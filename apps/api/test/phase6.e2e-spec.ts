import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient, UserRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { FlowmaxService } from '../src/integrations/flowmax/flowmax.service';
import { samples } from './fixtures/files';
import { startMockFlowmax, type MockFlowmax } from './fixtures/flowmax-mock';

/**
 * معاينة المرفقات والفيديو وربط Flowmax. Flowmax هنا خادم وهمي محلي (127.0.0.1) فقط؛
 * لا يتصل الاختبار بأي Flowmax حقيقي ولا ينشئ عقارًا حقيقيًا.
 */

const ORIGIN = 'http://localhost:3000';
const ADMIN = { username: 'p6.admin', password: 'P6-admin-pass-2026!' };
const VIEWER = { username: 'p6.viewer', password: 'P6-viewer-pass-2026!' };
const DOWNLOADER = { username: 'p6.downloader', password: 'P6-download-pass-2026!' };
const REVIEWER = { username: 'p6.reviewer', password: 'P6-review-pass-2026!' };
const USERNAMES = [ADMIN, VIEWER, DOWNLOADER, REVIEWER].map((u) => u.username);

let app: NestExpressApplication;
let prisma: PrismaClient;
let mock: MockFlowmax;
let uploadDir: string;
const savedEnv = { ...process.env };

interface Session {
  cookie: string[];
  csrf: string;
}

async function login(u: { username: string; password: string }): Promise<Session> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send(u)
    .expect(200);
  return { cookie: res.headers['set-cookie'] as unknown as string[], csrf: res.body.csrfToken };
}

function as(s: Session) {
  const server = app.getHttpServer();
  const auth = (req: request.Test) =>
    req.set('Cookie', s.cookie).set('Origin', ORIGIN).set('x-csrf-token', s.csrf);
  return {
    get: (url: string) => request(server).get(url).set('Cookie', s.cookie),
    post: (url: string, body?: object) => auth(request(server).post(url)).send(body ?? {}),
    put: (url: string, body: object) => auth(request(server).put(url)).send(body),
  };
}

const server = () => app.getHttpServer();
/** يجمع جسم الرد كما هو (للصور والفيديو). */
const binary = (res: request.Response, done: (err: Error | null, body: Buffer) => void) => {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => done(null, Buffer.concat(chunks)));
};
const upload = (publicId: string, token: string, questionId: string, name: string, data: Buffer) =>
  request(server())
    .post(`/api/public/forms/${publicId}/files?questionId=${questionId}`)
    .set('Origin', ORIGIN)
    .set('Content-Type', 'application/octet-stream')
    .set('x-file-name', encodeURIComponent(name))
    .set('x-fill-session', token)
    .send(data);

/** يشغّل نسخة جديدة من التطبيق على القاعدة نفسها (لاختبار الاستمرار بعد إعادة التشغيل). */
async function startApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const instance = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: ['error'],
  });
  configureApp(instance, loadEnv());
  await instance.init();
  return instance;
}

let admin: Session;
let viewer: Session;
let downloader: Session;
let reviewer: Session;
let formId: string;
let publicId: string;
let form: any;
const q = (title: string) => form.questions.find((x: any) => x.title === title);
const opt = (title: string, label: string) =>
  q(title).options.find((o: any) => o.label === label).id as string;

async function newSession(): Promise<string> {
  return (
    await request(server())
      .post(`/api/public/forms/${publicId}/upload-sessions`)
      .set('Origin', ORIGIN)
      .send({})
      .expect(201)
  ).body.token;
}

/** يرفع ملفات ويرسل ردًا كاملًا (أو ناقص المدينة) ويعيد معرّفه. */
async function submitResponse(
  opts: {
    city?: string;
    title?: string;
    operation?: string;
    consent?: string;
    images?: boolean;
  } = {},
) {
  const token = await newSession();
  const png = (await upload(publicId, token, q('الصور').id, 'واجهة.png', samples.png()).expect(201))
    .body.id;
  const mp4 = (
    await upload(publicId, token, q('الفيديو').id, 'جولة.mp4', samples.mp4()).expect(201)
  ).body.id;
  const webm = (
    await upload(publicId, token, q('الفيديو').id, 'تسجيل.webm', samples.webm()).expect(201)
  ).body.id;
  const pdf = (await upload(publicId, token, q('مستند').id, 'صك.pdf', samples.pdf()).expect(201))
    .body.id;
  const answers = [
    { questionId: q('العملية').id, value: opt('العملية', opts.operation ?? 'عرض') },
    ...(opts.consent
      ? [{ questionId: q('الموافقة').id, value: opt('الموافقة', opts.consent) }]
      : []),
    { questionId: q('العنوان').id, value: opts.title ?? 'شقة مطلة على الحديقة' },
    { questionId: q('الوصف').id, value: 'ثلاث غرف وصالة ومطبخ' },
    { questionId: q('نوع العقار').id, value: opt('نوع العقار', 'شقة') },
    { questionId: q('الغرض').id, value: opt('الغرض', 'بيع') },
    ...(opts.city === '' ? [] : [{ questionId: q('المدينة').id, value: opts.city ?? 'الرياض' }]),
    { questionId: q('الحي').id, value: 'النرجس' },
    { questionId: q('السعر').id, value: '850000' },
    { questionId: q('اسم المالك').id, value: 'سارة المالكة' },
    { questionId: q('الجوال').id, value: '0551234567' },
    ...(opts.images === false ? [] : [{ questionId: q('الصور').id, value: [png] }]),
    { questionId: q('الفيديو').id, value: [mp4, webm] },
    { questionId: q('مستند').id, value: [pdf] },
  ];
  const res = await request(server())
    .post(`/api/public/forms/${publicId}/responses`)
    .set('Origin', ORIGIN)
    .send({ versionId: form.versionId, fillSession: token, idempotencyKey: randomUUID(), answers })
    .expect(201);
  const row = await prisma.formResponse.findUniqueOrThrow({
    where: { referenceCode: res.body.referenceCode },
  });
  return { responseId: row.id, files: { png, mp4, webm, pdf } };
}

beforeAll(async () => {
  prisma = new PrismaClient();
  mock = await startMockFlowmax();
  uploadDir = await mkdtemp(join(tmpdir(), 'lawha-p6-'));
  Object.assign(process.env, {
    UPLOAD_SCAN_MODE: 'disabled',
    UPLOAD_DIR: uploadDir,
    PUBLIC_UPLOAD_PER_IP_PER_MINUTE: '100000',
    PUBLIC_UPLOAD_PER_FORM_PER_MINUTE: '100000',
    FLOWMAX_ENABLED: 'true',
    FLOWMAX_API_BASE_URL: mock.url,
    FLOWMAX_SERVICE_TOKEN: mock.token,
    FLOWMAX_TIMEOUT_MS: '2000',
    FLOWMAX_MEDIA_TIMEOUT_MS: '5000',
  });
  app = await startApp();

  await prisma.user.create({
    data: {
      username: ADMIN.username,
      displayName: 'مدير المرحلة السادسة',
      passwordHash: await hashPassword(ADMIN.password),
      role: UserRole.ADMIN,
    },
  });
  admin = await login(ADMIN);
  const create = (u: typeof VIEWER, displayName: string, permissions: string[]) =>
    as(admin)
      .post('/api/users', { username: u.username, displayName, password: u.password, permissions })
      .expect(201);
  await create(VIEWER, 'عارض الردود', ['FORMS_VIEW', 'RESPONSES_VIEW']);
  await create(DOWNLOADER, 'منزّل الملفات', [
    'FORMS_VIEW',
    'RESPONSES_VIEW',
    'RESPONSES_FILES_DOWNLOAD',
  ]);
  await create(REVIEWER, 'مراجع الردود', ['FORMS_VIEW', 'RESPONSES_VIEW', 'RESPONSES_REVIEW']);
  viewer = await login(VIEWER);
  downloader = await login(DOWNLOADER);
  reviewer = await login(REVIEWER);

  const title = 'عروض العقارات';
  formId = (await as(admin).post('/api/forms', { title }).expect(201)).body.id;
  const choice = (t: string, labels: string[]) => ({
    type: 'SINGLE_CHOICE',
    title: t,
    required: true,
    settings: {},
    options: labels.map((label) => ({ label })),
  });
  const text = (t: string, required = false) => ({
    type: 'SHORT_TEXT',
    title: t,
    required,
    settings: {},
  });
  const files = (t: string, allowedTypes: string[], maxFileSizeMb: number, maxFiles: number) => ({
    type: 'FILE_UPLOAD',
    title: t,
    required: false,
    settings: { allowedTypes, maxFileSizeMb, maxFiles },
  });
  const questions = [
    choice('العملية', ['عرض', 'طلب']),
    text('العنوان', true),
    { type: 'PARAGRAPH', title: 'الوصف', required: true, settings: {} },
    { ...choice('نوع العقار', ['شقة', 'فيلا']), type: 'DROPDOWN' },
    choice('الغرض', ['بيع', 'إيجار']),
    text('المدينة'),
    text('الحي'),
    { type: 'NUMBER', title: 'السعر', required: true, settings: { allowDecimals: false } },
    text('اسم المالك'),
    text('الجوال'),
    files('الصور', ['jpg', 'png', 'webp'], 5, 5),
    files('الفيديو', ['mp4', 'mov', 'webm'], 1, 3),
    files('مستند', ['pdf'], 1, 1),
    { ...choice('الموافقة', ['نعم، أوافق', 'لا']), required: false },
  ];
  await as(admin).put(`/api/forms/${formId}/draft`, { revision: 1, title, questions }).expect(200);
  const draft = (await as(admin).get(`/api/forms/${formId}/draft`).expect(200)).body;
  const published = await as(admin)
    .post(`/api/forms/${formId}/publish`, {
      revision: draft.revision,
      publishKey: randomUUID(),
      openResponses: true,
    })
    .expect(200);
  publicId = published.body.form.publication.publicId;
  form = (await request(server()).get(`/api/public/forms/${publicId}`).expect(200)).body;
}, 120_000);

afterAll(async () => {
  await app?.get(FlowmaxService).whenIdle();
  if (prisma) {
    const users = await prisma.user.findMany({
      where: { username: { in: USERNAMES } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    const formIds = (
      await prisma.form.findMany({ where: { createdById: { in: ids } }, select: { id: true } })
    ).map((f) => f.id);
    await prisma.flowmaxSync.deleteMany({ where: { formId: { in: formIds } } });
    await prisma.formFlowmaxMapping.deleteMany({ where: { formId: { in: formIds } } });
    await prisma.uploadedFile.deleteMany({ where: { formId: { in: formIds } } });
    await prisma.fillSession.deleteMany({ where: { formId: { in: formIds } } });
    await prisma.formResponseStatusChange.deleteMany({
      where: { response: { formId: { in: formIds } } },
    });
    await prisma.formResponse.deleteMany({ where: { formId: { in: formIds } } });
    await prisma.formVersionOption.deleteMany({
      where: { question: { version: { formId: { in: formIds } } } },
    });
    await prisma.formVersionQuestion.deleteMany({
      where: { version: { formId: { in: formIds } } },
    });
    await prisma.formVersion.deleteMany({ where: { formId: { in: formIds } } });
    await prisma.form.deleteMany({ where: { id: { in: formIds } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await app?.close();
  await prisma?.$disconnect();
  await mock?.close();
  await rm(uploadDir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe('الفيديو في إعداد السؤال', () => {
  it('حد 100MB للفيديو فقط، و25MB لغيره', async () => {
    const id = (await as(admin).post('/api/forms', { title: 'حدود' }).expect(201)).body.id;
    const save = (allowedTypes: string[], maxFileSizeMb: number) =>
      as(admin).put(`/api/forms/${id}/draft`, {
        revision: 1,
        title: 'حدود',
        questions: [
          {
            type: 'FILE_UPLOAD',
            title: 'ملف',
            required: false,
            settings: { allowedTypes, maxFileSizeMb, maxFiles: 1 },
          },
        ],
      });
    const bad = await save(['pdf'], 30).expect(400);
    expect(bad.body.fields[0].field).toBe('questions.0.settings.maxFileSizeMb');
    await save(['mp4', 'pdf'], 100).expect(200);
  });
});

describe('رفع الفيديو والتحقق من النوع الفعلي', () => {
  let token: string;
  beforeAll(async () => {
    token = await newSession();
  });

  it('يقبل MP4 وMOV وWebM السليمة', async () => {
    const v = q('الفيديو').id;
    expect((await upload(publicId, token, v, 'a.mp4', samples.mp4()).expect(201)).body.kind).toBe(
      'MP4',
    );
    expect((await upload(publicId, token, v, 'a.mov', samples.mov()).expect(201)).body.kind).toBe(
      'MOV',
    );
    expect((await upload(publicId, token, v, 'a.webm', samples.webm()).expect(201)).body.kind).toBe(
      'WEBM',
    );
  });

  it('يرفض امتدادًا غير مسموح وMIME مزورًا وملفًا يتجاوز الحجم', async () => {
    const t = await newSession();
    const v = q('الفيديو').id;
    expect((await upload(publicId, t, v, 'run.exe', samples.mp4()).expect(400)).body.code).toBe(
      'FILE_REJECTED',
    );
    const forged = await upload(publicId, t, v, 'fake.mp4', samples.png()).expect(400);
    expect(forged.body.message).toMatch(/غير مسموح|لا يطابق/);
    const textAsVideo = await upload(
      publicId,
      t,
      v,
      'fake.webm',
      Buffer.from('hello video'),
    ).expect(400);
    expect(textAsVideo.body.code).toBe('FILE_REJECTED');
    const big = Buffer.concat([samples.mp4(), Buffer.alloc(1024 * 1024 + 10)]);
    expect((await upload(publicId, t, v, 'big.mp4', big).expect(413)).body.code).toBe(
      'FILE_TOO_LARGE',
    );
  });
});

describe('معاينة المرفقات وتنزيلها عبر المسار المحمي', () => {
  let responseId: string;
  let files: Record<string, string>;
  const fileUrl = (id: string, inline = false) =>
    `/api/forms/${formId}/responses/${responseId}/files/${id}${inline ? '?disposition=inline' : ''}`;

  beforeAll(async () => {
    ({ responseId, files } = await submitResponse());
  });

  it('التفاصيل تحدد ما يُعاين، وتبقي علامة «غير مفحوص»', async () => {
    const detail = (
      await as(viewer).get(`/api/forms/${formId}/responses/${responseId}`).expect(200)
    ).body;
    const all = detail.answers.flatMap((a: any) => a.files ?? []);
    const by = (kind: string) => all.find((f: any) => f.kind === kind);
    expect(by('PNG')).toMatchObject({ previewable: true, malwareScanned: false });
    expect(by('MP4').previewable).toBe(true);
    expect(by('WEBM').previewable).toBe(true);
    expect(by('PDF').previewable).toBe(false);
  });

  it('صورة: inline بالنوع الحقيقي مع CSP وnosniff ودون تخزين؛ والتنزيل attachment', async () => {
    const res = await as(downloader)
      .get(fileUrl(files.png!, true))
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toMatch(/^inline;/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store, private');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(Buffer.from(res.body).equals(samples.png())).toBe(true);
    const dl = await as(downloader).get(fileUrl(files.png!)).expect(200);
    expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('MP4 وWebM: معاينة داخل الصفحة مع دعم Range للتشغيل والتنقل', async () => {
    const full = await as(downloader).get(fileUrl(files.mp4!, true)).expect(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(full.headers['accept-ranges']).toBe('bytes');
    const part = await as(downloader)
      .get(fileUrl(files.mp4!, true))
      .set('Range', 'bytes=0-9')
      .expect(206);
    const size = samples.mp4().length;
    expect(part.headers['content-range']).toBe(`bytes 0-9/${size}`);
    expect(part.headers['content-length']).toBe('10');
    await as(downloader).get(fileUrl(files.mp4!, true)).set('Range', `bytes=${size}-`).expect(416);
    const webm = await as(downloader).get(fileUrl(files.webm!, true)).expect(200);
    expect(webm.headers['content-type']).toBe('video/webm');
    expect(webm.headers['content-disposition']).toMatch(/^inline;/);
  });

  it('PDF لا يُعرض داخل الصفحة؛ تنزيل فقط', async () => {
    const res = await as(downloader).get(fileUrl(files.pdf!, true)).expect(400);
    expect(res.body.code).toBe('PREVIEW_NOT_SUPPORTED');
    const dl = await as(downloader).get(fileUrl(files.pdf!)).expect(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('دون صلاحية تنزيل الملفات: المعاينة والتنزيل 403 (حتى للمراجع)', async () => {
    for (const s of [viewer, reviewer]) {
      expect((await as(s).get(fileUrl(files.png!, true)).expect(403)).body.code).toBe('FORBIDDEN');
      await as(s).get(fileUrl(files.mp4!, true)).expect(403);
      await as(s).get(fileUrl(files.pdf!)).expect(403);
      // طلب مدى لا يتجاوز الصلاحية
      await as(s).get(fileUrl(files.mp4!, true)).set('Range', 'bytes=0-9').expect(403);
    }
    await request(server()).get(fileUrl(files.png!, true)).expect(401);
    await request(server()).get(fileUrl(files.mp4!, true)).set('Range', 'bytes=0-9').expect(401);
  });

  it('المعاينة تُسجَّل في التدقيق مرة لبداية التشغيل لا لكل جزء', async () => {
    const before = await prisma.auditLog.count({
      where: { action: 'response.file_previewed', entityId: responseId },
    });
    await as(downloader).get(fileUrl(files.mp4!, true)).set('Range', 'bytes=10-19').expect(206);
    await as(downloader).get(fileUrl(files.mp4!, true)).set('Range', 'bytes=0-').expect(206);
    const after = await prisma.auditLog.count({
      where: { action: 'response.file_previewed', entityId: responseId },
    });
    expect(after - before).toBe(1);
  });
});

describe('ربط Flowmax (خادم Flowmax وهمي محلي بنفس عقد نقاط التكامل)', () => {
  const flowmax = () => app.get(FlowmaxService);
  const fields = (overrides: Record<string, unknown> = {}) => ({
    operation: { questionId: q('العملية').key },
    title_ar: { questionId: q('العنوان').key },
    description_ar: { questionId: q('الوصف').key },
    property_category: { questionId: q('نوع العقار').key },
    listing_purpose: { questionId: q('الغرض').key },
    city: { questionId: q('المدينة').key },
    district: { questionId: q('الحي').key },
    price: { questionId: q('السعر').key },
    contact_name: { questionId: q('اسم المالك').key },
    contact_phone: { questionId: q('الجوال').key },
    images: { questionId: q('الصور').key },
    videos: { questionId: q('الفيديو').key },
    consent: { questionId: q('الموافقة').key },
    consent_version: { constant: '2026-10' },
    type_letter: { constant: 'M' },
    developer_id: { constant: '7' },
    mediation_contract_number: { constant: 'MCN-TEST' },
    contract_date: { constant: '2026-03-15' },
    fal_license_number: { constant: 'FAL-TEST' },
    ...overrides,
  });
  const saveMapping = (overrides: Record<string, unknown> = {}) =>
    as(admin)
      .put(`/api/forms/${formId}/flowmax-mapping`, {
        enabled: true,
        config: { fields: fields(overrides) },
      })
      .expect(200);
  const flowmaxUrl = (responseId: string, action = '') =>
    `/api/forms/${formId}/responses/${responseId}/flowmax${action}`;
  const state = async (responseId: string) =>
    (await as(viewer).get(flowmaxUrl(responseId)).expect(200)).body;
  const sourceKey = (responseId: string) => `lawha:response:${responseId}`;
  const offers = (responseId: string) =>
    mock.properties.filter((p) => p.sourceKey === sourceKey(responseId));
  const OWNER = /سارة|0551234567|966551234567/;

  it('الاختبار لا يلمس Flowmax حقيقيًا', () => {
    expect(process.env.FLOWMAX_API_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('الربط: يعدّله من يملك تعديل النماذج فقط، ويرفض سؤالًا بنوع غير مناسب', async () => {
    await as(viewer).get(`/api/forms/${formId}/flowmax-mapping`).expect(403);
    await as(reviewer)
      .put(`/api/forms/${formId}/flowmax-mapping`, { enabled: true, config: { fields: fields() } })
      .expect(403);
    const bad = await as(admin)
      .put(`/api/forms/${formId}/flowmax-mapping`, {
        enabled: true,
        config: { fields: fields({ images: { questionId: q('العنوان').key } }) },
      })
      .expect(400);
    expect(bad.body.fields[0]).toEqual({
      field: 'config.fields.images',
      message: 'اختر سؤال رفع ملفات.',
    });
    const ok = await saveMapping();
    expect(ok.body.enabled).toBe(true);
    expect(ok.body.integrationEnabled).toBe(true);
  });

  it('رد ناقص البيانات ⇒ 422 برسالة عربية، دون إرسال أو تغيير الحالة', async () => {
    const { responseId } = await submitResponse({ city: '' });
    const pre = await state(responseId);
    expect(pre.precheck.problems).toEqual([
      { field: 'city', message: '«المدينة»: الإجابة مطلوبة لإنشاء العقار.' },
    ]);
    const before = mock.requests.length;
    const res = await as(reviewer).post(flowmaxUrl(responseId, '/approve')).expect(422);
    expect(res.body.code).toBe('FLOWMAX_INCOMPLETE');
    expect(res.body.fields).toEqual([
      { field: 'flowmax.city', message: '«المدينة»: الإجابة مطلوبة لإنشاء العقار.' },
    ]);
    expect(await prisma.flowmaxSync.count({ where: { responseId } })).toBe(0);
    expect(
      (await prisma.formResponse.findUniqueOrThrow({ where: { id: responseId } })).status,
    ).toBe('NEW');
    expect(mock.requests.length).toBe(before);
  });

  it('المرفقات غير المتوافقة تظهر قبل الاعتماد وتمنعه حتى تُستبعد صراحة، ويُسجَّل الاستبعاد', async () => {
    // سؤال المستندات (PDF) مربوط بالصور ⇒ ملف لا يقبله Flowmax
    await saveMapping({ images: { questionId: q('مستند').key } });
    try {
      const { responseId, files } = await submitResponse({ title: 'عرض بمرفق غير متوافق' });
      const pre = await state(responseId);
      expect(pre.precheck.incompatibleMedia).toEqual([
        { fileId: files.pdf, name: 'صك.pdf', reason: 'Flowmax يقبل صور JPG وPNG وWEBP فقط.' },
      ]);
      const blocked = await as(reviewer).post(flowmaxUrl(responseId, '/approve')).expect(422);
      expect(blocked.body.code).toBe('FLOWMAX_MEDIA_INCOMPATIBLE');
      expect(blocked.body.fields[0].message).toBe('«صك.pdf»: Flowmax يقبل صور JPG وPNG وWEBP فقط.');
      expect(await prisma.flowmaxSync.count({ where: { responseId } })).toBe(0);

      await as(reviewer)
        .post(flowmaxUrl(responseId, '/approve'), { excludeFileIds: [files.pdf] })
        .expect(202);
      await flowmax().whenIdle();
      const s = (await state(responseId)).sync;
      expect(s.status).toBe('SENT');
      expect(s.media.find((m: any) => m.fileId === files.pdf)).toMatchObject({
        status: 'EXCLUDED',
        excludedReason: 'Flowmax يقبل صور JPG وPNG وWEBP فقط.',
      });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'response.flowmax_approved', entityId: responseId },
      });
      expect((audit.details as any).excludedFileIds).toEqual([files.pdf]);
    } finally {
      await saveMapping();
    }
  });

  it('طلبا اعتماد متزامنان ⇒ سجل واحد هنا وسجل واحد في Flowmax', async () => {
    const { responseId } = await submitResponse({ title: 'اعتماد متزامن' });
    const results = await Promise.all([
      as(reviewer).post(flowmaxUrl(responseId, '/approve')),
      as(reviewer).post(flowmaxUrl(responseId, '/approve')),
      as(reviewer).post(flowmaxUrl(responseId, '/approve')),
    ]);
    expect(results.map((r) => r.status)).toEqual([202, 202, 202]);
    await flowmax().whenIdle();
    expect(await prisma.flowmaxSync.count({ where: { responseId } })).toBe(1);
    expect(offers(responseId)).toHaveLength(1);
  });

  let approvedId: string;

  it('الاعتماد يرسل البيانات وكل مرفق، والمسودة لا تعرض مشاركة عامة', async () => {
    const { responseId } = await submitResponse({ title: 'شقة النرجس للاختبار' });
    approvedId = responseId;
    await as(viewer).post(flowmaxUrl(responseId, '/approve')).expect(403);
    await as(downloader).post(flowmaxUrl(responseId, '/approve')).expect(403);
    await as(reviewer).post(flowmaxUrl(responseId, '/approve')).expect(202);
    await flowmax().whenIdle();

    const s = (await state(responseId)).sync;
    expect(s).toMatchObject({
      status: 'SENT',
      operation: 'OFFER',
      isPublic: false,
      publishState: 'NONE',
      share: null,
    });
    expect(s.detailUrl).toBe(`https://flowmax.test/property/${s.flowmaxId}`);
    expect(s.media.map((m: any) => m.status)).toEqual(['SENT', 'SENT', 'SENT']);
    expect(offers(responseId)[0]).toMatchObject({ images: 1, videos: 2, status: 'Draft' });
    expect(JSON.stringify(s)).not.toMatch(OWNER);
    const sent = offers(responseId)[0]!.payload;
    expect(sent).toMatchObject({ requested_price: 85_000_000, contact_phone: '+966551234567' });
    expect(
      (await prisma.formResponse.findUniqueOrThrow({ where: { id: responseId } })).status,
    ).toBe('ACCEPTED');
  });

  it('تكرار الاعتماد وإعادة المحاولة لا ينشئان سجلًا ثانيًا', async () => {
    await as(reviewer).post(flowmaxUrl(approvedId, '/approve')).expect(202);
    await as(reviewer).post(flowmaxUrl(approvedId, '/retry')).expect(202);
    await flowmax().whenIdle();
    expect(offers(approvedId)).toHaveLength(1);
  });

  it('النشر منفصل: بعده فقط تظهر المشاركة برابط التفاصيل الذي أعاده Flowmax ودون بيانات المالك', async () => {
    await as(viewer).post(flowmaxUrl(approvedId, '/publish')).expect(403);
    const res = await as(reviewer).post(flowmaxUrl(approvedId, '/publish')).expect(200);
    expect(res.body.sync).toMatchObject({ publishState: 'PUBLISHED', isPublic: true });
    expect(res.body.sync.share).toMatchObject({
      title: 'شقة النرجس للاختبار',
      city: 'الرياض',
      district: 'النرجس',
      priceSar: '850000',
    });
    expect(JSON.stringify(res.body)).not.toMatch(OWNER);
    expect(offers(approvedId)[0]!.status).toBe('Published');
  });

  it('فشل النشر يحفظ المعرّف والسبب ولا يعرض مشاركة، ويمكن إعادة المحاولة', async () => {
    const { responseId } = await submitResponse({ title: 'عرض بلا صور', images: false });
    await as(reviewer).post(flowmaxUrl(responseId, '/approve')).expect(202);
    await flowmax().whenIdle();
    const res = await as(reviewer).post(flowmaxUrl(responseId, '/publish')).expect(200);
    expect(res.body.sync).toMatchObject({
      status: 'SENT',
      publishState: 'FAILED',
      publishError: 'متطلبات النشر في Flowmax غير مكتملة: images.',
      isPublic: false,
      share: null,
    });
    expect(res.body.sync.flowmaxId).toBeTruthy();
    const again = await as(reviewer).post(flowmaxUrl(responseId, '/publish')).expect(200);
    expect(again.body.sync.publishState).toBe('FAILED');
  });

  it('وصول الإنشاء ثم ضياع الاستجابة لا يكرر السجل عند إعادة المحاولة', async () => {
    const { responseId } = await submitResponse({ title: 'ضياع استجابة الإنشاء' });
    mock.failNext.push({ match: /POST .*\/offers$/, mode: 'drop-after-create' });
    await as(reviewer).post(flowmaxUrl(responseId, '/approve')).expect(202);
    await flowmax().whenIdle();
    expect((await state(responseId)).sync).toMatchObject({
      status: 'FAILED',
      lastError: 'تعذر الاتصال بـ Flowmax.',
    });
    expect(offers(responseId)).toHaveLength(1);
    await as(reviewer).post(flowmaxUrl(responseId, '/retry')).expect(202);
    await flowmax().whenIdle();
    expect((await state(responseId)).sync.status).toBe('SENT');
    expect(offers(responseId)).toHaveLength(1);
  });

  it('وصول المرفق ثم ضياع الاستجابة لا يكرره، وفشل المرفق لا يظهر نجاحًا كاملًا', async () => {
    const { responseId } = await submitResponse({ title: 'ضياع استجابة مرفق' });
    mock.failNext.push({ match: /\/media$/, mode: 'drop-after-create' });
    await as(reviewer).post(flowmaxUrl(responseId, '/approve')).expect(202);
    await flowmax().whenIdle();
    const failed = (await state(responseId)).sync;
    expect(failed.status).toBe('FAILED');
    expect(failed.lastError).toBe('لم يكتمل نقل 1 من المرفقات؛ أعد المحاولة.');
    expect(failed.media.map((m: any) => m.status)).toEqual(['FAILED', 'SENT', 'SENT']);
    expect(failed.share).toBeNull();
    await as(viewer).post(flowmaxUrl(responseId, '/retry')).expect(403);
    await as(reviewer).post(flowmaxUrl(responseId, '/retry')).expect(202);
    await flowmax().whenIdle();
    expect((await state(responseId)).sync.status).toBe('SENT');
    expect(offers(responseId)[0]).toMatchObject({ images: 1, videos: 2 });
  });

  it('محتوى مختلف بالمفتاح نفسه يُرفض من Flowmax بـ 409 ويظهر خطأً صريحًا', async () => {
    const { responseId } = await submitResponse({ title: 'مفتاح بمحتوى مختلف' });
    await as(reviewer).post(flowmaxUrl(responseId, '/approve')).expect(202);
    await flowmax().whenIdle();
    // تعديل اللقطة المحفوظة يحاكي إعادة استخدام المفتاح ببيانات مختلفة
    const sync = await prisma.flowmaxSync.findUniqueOrThrow({ where: { responseId } });
    await prisma.flowmaxSync.update({
      where: { id: sync.id },
      data: {
        status: 'FAILED',
        payload: { ...(sync.payload as object), requested_price: 1 },
      },
    });
    await as(reviewer).post(flowmaxUrl(responseId, '/retry')).expect(202);
    await flowmax().whenIdle();
    const s = (await state(responseId)).sync;
    expect(s.status).toBe('FAILED');
    expect(s.lastError).toBe('رفض Flowmax مفتاح التكامل لأنه استُخدم ببيانات مختلفة (409).');
    expect(offers(responseId)).toHaveLength(1);
  });

  it('الطلب العقاري يعيد رابط تفاصيل الطلب نفسه، والمشاركة بعد نشره في Flowmax فقط', async () => {
    const { responseId } = await submitResponse({
      title: 'طلب شقة',
      operation: 'طلب',
      consent: 'نعم، أوافق',
    });
    await as(reviewer).post(flowmaxUrl(responseId, '/approve')).expect(202);
    await flowmax().whenIdle();
    const s = (await state(responseId)).sync;
    expect(s).toMatchObject({ status: 'SENT', operation: 'REQUEST', isPublic: false, share: null });
    expect(s.detailUrl).toBe(`https://flowmax.test/properties/demands/${s.flowmaxRef}`);
    expect(s.detailUrl).not.toMatch(/\/property\//);
    const demand = mock.demands.find((d) => d.sourceKey === sourceKey(responseId))!;
    expect(demand.payload).not.toHaveProperty('idempotency_key');
    expect(
      (await as(reviewer).post(flowmaxUrl(responseId, '/publish')).expect(409)).body.code,
    ).toBe('FLOWMAX_PUBLISH_NOT_SUPPORTED');

    mock.publishDemand(demand.reference);
    const refreshed = await as(reviewer).post(flowmaxUrl(responseId, '/refresh')).expect(200);
    expect(refreshed.body.sync).toMatchObject({ isPublic: true, publishState: 'PUBLISHED' });
    expect(refreshed.body.sync.share).toMatchObject({ operation: 'REQUEST', city: 'الرياض' });
    expect(JSON.stringify(refreshed.body)).not.toMatch(OWNER);
    expect(mock.demands.filter((d) => d.sourceKey === sourceKey(responseId))).toHaveLength(1);
  });

  it('حالة التكامل تبقى بعد إعادة تشغيل التطبيق، والإرسال المنقطع يصبح قابلًا لإعادة المحاولة', async () => {
    const { responseId } = await submitResponse({ title: 'انقطاع أثناء الإرسال' });
    // إرسال يتعلق دون رد ثم يُغلق التطبيق قبل اكتماله (انهيار العملية)
    mock.failNext.push({ match: /POST .*\/offers$/, mode: 'hang' });
    await as(reviewer).post(flowmaxUrl(responseId, '/approve')).expect(202);
    await new Promise((r) => setTimeout(r, 300));
    await prisma.flowmaxSync.updateMany({ where: { responseId }, data: { status: 'SENDING' } });
    await flowmax().whenIdle();
    await prisma.flowmaxSync.updateMany({ where: { responseId }, data: { status: 'SENDING' } });
    await app.close();
    app = await startApp();

    const after = (await state(responseId)).sync;
    expect(after.status).toBe('FAILED');
    expect(after.lastError).toBe('انقطع الإرسال قبل اكتماله؛ أعد المحاولة.');
    await as(reviewer).post(flowmaxUrl(responseId, '/retry')).expect(202);
    await flowmax().whenIdle();
    expect((await state(responseId)).sync.status).toBe('SENT');
    expect(offers(responseId)).toHaveLength(1);
    // السجل المرسل والمنشور قبل إعادة التشغيل باقٍ كما هو
    expect((await state(approvedId)).sync).toMatchObject({
      publishState: 'PUBLISHED',
      isPublic: true,
    });
  });

  it('السجلات والتدقيق وسجل التكامل لا تحمل رمز التكامل', async () => {
    const logs = await prisma.auditLog.findMany({
      where: { action: { startsWith: 'response.flowmax' } },
    });
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(mock.token);
    const syncs = await prisma.flowmaxSync.findMany();
    expect(JSON.stringify(syncs)).not.toContain(mock.token);
  });
});
