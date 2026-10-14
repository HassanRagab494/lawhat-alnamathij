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
async function submitResponse(opts: { city?: string; title?: string } = {}) {
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
    { questionId: q('العملية').id, value: opt('العملية', 'عرض') },
    { questionId: q('العنوان').id, value: opts.title ?? 'شقة مطلة على الحديقة' },
    { questionId: q('الوصف').id, value: 'ثلاث غرف وصالة ومطبخ' },
    { questionId: q('نوع العقار').id, value: opt('نوع العقار', 'شقة') },
    { questionId: q('الغرض').id, value: opt('الغرض', 'بيع') },
    ...(opts.city === '' ? [] : [{ questionId: q('المدينة').id, value: opts.city ?? 'الرياض' }]),
    { questionId: q('الحي').id, value: 'النرجس' },
    { questionId: q('السعر').id, value: '850000' },
    { questionId: q('اسم المالك').id, value: 'سارة المالكة' },
    { questionId: q('الجوال').id, value: '0551234567' },
    { questionId: q('الصور').id, value: [png] },
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
    FLOWMAX_PUBLIC_SITE_URL: 'https://flowmax.test',
    FLOWMAX_TIMEOUT_MS: '2000',
    FLOWMAX_MEDIA_TIMEOUT_MS: '5000',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: ['error'],
  });
  configureApp(app, loadEnv());
  await app.init();

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
    }
    await request(server()).get(fileUrl(files.png!, true)).expect(401);
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

describe('ربط Flowmax (خادم وهمي محلي)', () => {
  const flowmax = () => app.get(FlowmaxService);
  const fields = () => ({
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
    type_letter: { constant: 'M' },
    developer_id: { constant: '7' },
    mediation_contract_number: { constant: 'MCN-TEST' },
    contract_date: { constant: '2026-03-15' },
    fal_license_number: { constant: 'FAL-TEST' },
  });
  const flowmaxUrl = (responseId: string, action = '') =>
    `/api/forms/${formId}/responses/${responseId}/flowmax${action}`;

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
        config: { fields: { ...fields(), images: { questionId: q('العنوان').key } } },
      })
      .expect(400);
    expect(bad.body.fields[0]).toEqual({
      field: 'config.fields.images',
      message: 'اختر سؤال رفع ملفات.',
    });
    const ok = await as(admin)
      .put(`/api/forms/${formId}/flowmax-mapping`, { enabled: true, config: { fields: fields() } })
      .expect(200);
    expect(ok.body.enabled).toBe(true);
    expect(ok.body.integrationEnabled).toBe(true);
  });

  it('رد ناقص البيانات ⇒ 422 برسالة عربية، دون إرسال أو تغيير الحالة', async () => {
    const { responseId } = await submitResponse({ city: '' });
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

  let approvedId: string;

  it('الاعتماد يتطلب مراجعة الردود، ثم يرسل العقار ووسائطه ويحفظ الرابط', async () => {
    const { responseId } = await submitResponse({ title: 'شقة النرجس للاختبار' });
    approvedId = responseId;
    await as(viewer).post(flowmaxUrl(responseId, '/approve')).expect(403);
    await as(downloader).post(flowmaxUrl(responseId, '/approve')).expect(403);
    const res = await as(reviewer).post(flowmaxUrl(responseId, '/approve')).expect(202);
    expect(['PENDING', 'SENDING', 'SENT']).toContain(res.body.sync.status);
    await flowmax().whenIdle();

    const state = (await as(viewer).get(flowmaxUrl(responseId)).expect(200)).body;
    expect(state.sync).toMatchObject({
      status: 'SENT',
      operation: 'OFFER',
      attempts: 1,
      mediaSent: 3,
    });
    expect(state.sync.url).toBe(`https://flowmax.test/property/${state.sync.flowmaxId}`);
    expect(JSON.stringify(state.sync.share)).not.toMatch(/سارة|0551234567|966551234567/);
    expect(state.sync.share).toMatchObject({
      title: 'شقة النرجس للاختبار',
      city: 'الرياض',
      district: 'النرجس',
      priceSar: '850000',
    });

    const created = mock.properties.filter((p) => p.platform_code === `lawha-${responseId}`);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ images: 1, videos: 2, status: 'Draft' });
    const createReq = mock.requests.find(
      (r) =>
        r.method === 'POST' &&
        r.path === '/api/admin/properties' &&
        r.idempotencyKey === `lawha-${responseId}`,
    )!;
    expect(JSON.parse(createReq.body.toString('utf8'))).toMatchObject({
      requested_price: 85_000_000,
      contact_phone: '+966551234567',
      property_category: 'apartment',
      listing_purpose: 'sale',
    });
    expect(
      (await prisma.formResponse.findUniqueOrThrow({ where: { id: responseId } })).status,
    ).toBe('ACCEPTED');
  });

  it('تكرار الاعتماد لا ينشئ عقارًا ثانيًا', async () => {
    const count = mock.properties.length;
    const again = await as(reviewer).post(flowmaxUrl(approvedId, '/approve')).expect(202);
    await flowmax().whenIdle();
    expect(again.body.sync.status).toBe('SENT');
    expect(mock.properties.length).toBe(count);
    await as(reviewer).post(flowmaxUrl(approvedId, '/retry')).expect(202);
    await flowmax().whenIdle();
    expect(mock.properties.length).toBe(count);
  });

  it('فشل Flowmax ⇒ حالة فشل وخطأ مختصر، وإعادة المحاولة تكمل دون تكرار', async () => {
    const { responseId } = await submitResponse({ title: 'شقة تفشل أولًا' });
    mock.failNext.push({ match: /POST \/api\/admin\/properties$/, mode: 'http500' });
    await as(reviewer).post(flowmaxUrl(responseId, '/approve')).expect(202);
    await flowmax().whenIdle();
    const failed = (await as(viewer).get(flowmaxUrl(responseId)).expect(200)).body.sync;
    expect(failed).toMatchObject({
      status: 'FAILED',
      lastError: 'خطأ من Flowmax (500).',
      url: null,
      share: null,
    });

    await as(viewer).post(flowmaxUrl(responseId, '/retry')).expect(403);
    await as(reviewer).post(flowmaxUrl(responseId, '/retry')).expect(202);
    await flowmax().whenIdle();
    const sent = (await as(viewer).get(flowmaxUrl(responseId)).expect(200)).body.sync;
    expect(sent).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
    expect(mock.properties.filter((p) => p.platform_code === `lawha-${responseId}`)).toHaveLength(
      1,
    );
  });

  it('السجلات والتدقيق لا تحمل رمز التكامل', async () => {
    const logs = await prisma.auditLog.findMany({
      where: { action: { startsWith: 'response.flowmax' } },
    });
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(mock.token);
    const syncs = await prisma.flowmaxSync.findMany();
    expect(JSON.stringify(syncs)).not.toContain(mock.token);
  });
});
