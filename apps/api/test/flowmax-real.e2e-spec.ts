import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient, UserRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

/**
 * تكامل فعلي مع كود Flowmax (لا خادم وهمي): يعمل فقط عند ضبط FLOWMAX_REAL_URL إلى نسخة Flowmax محلية
 * منفصلة (localhost فقط) بحساب تكامل بصلاحية integrations.forms وحدها. لا يُسمح بأي مضيف آخر،
 * فلا تُنشأ عقارات أو طلبات حقيقية.
 *   FLOWMAX_REAL_URL=http://127.0.0.1:8100 FLOWMAX_REAL_TOKEN_FILE=… FLOWMAX_REAL_DEVELOPER_ID=…
 */
const REAL_URL = process.env.FLOWMAX_REAL_URL;
const enabled = Boolean(REAL_URL);
if (enabled && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(REAL_URL!)) {
  throw new Error('FLOWMAX_REAL_URL must point to a local Flowmax instance');
}
const run = enabled ? describe : describe.skip;

const ORIGIN = 'http://localhost:3000';
const ADMIN = { username: 'fr.admin', password: 'FR-admin-pass-2026!' };
const REVIEWER = { username: 'fr.reviewer', password: 'FR-review-pass-2026!' };
const OWNER = /سارة|0551234567|966551234567/;
const media = (name: string) => readFileSync(join(__dirname, 'fixtures/media', name));

let app: NestExpressApplication;
let prisma: PrismaClient;
let uploadDir: string;
let token: string;
const savedEnv = { ...process.env };

interface Session {
  cookie: string[];
  csrf: string;
}
let admin: Session;
let reviewer: Session;
let formId: string;
let publicId: string;
let form: any;
const q = (title: string) => form.questions.find((x: any) => x.title === title);
const opt = (title: string, label: string) =>
  q(title).options.find((o: any) => o.label === label).id as string;

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
/** طلب مباشر إلى Flowmax المحلي بحساب التكامل (للتحقق من النتيجة على جهة Flowmax). */
const flowmaxApi = () => ({
  get: (path: string) =>
    request(REAL_URL!)
      .get(path)
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json'),
  post: (path: string, body: object) =>
    request(REAL_URL!)
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json')
      .send(body),
});

async function submit(opts: { operation: string; title: string; consent?: string }) {
  const server = app.getHttpServer();
  const fill = (
    await request(server)
      .post(`/api/public/forms/${publicId}/upload-sessions`)
      .set('Origin', ORIGIN)
      .send({})
      .expect(201)
  ).body.token;
  const up = async (question: string, name: string, data: Buffer) =>
    (
      await request(server)
        .post(`/api/public/forms/${publicId}/files?questionId=${q(question).id}`)
        .set('Origin', ORIGIN)
        .set('Content-Type', 'application/octet-stream')
        .set('x-file-name', encodeURIComponent(name))
        .set('x-fill-session', fill)
        .send(data)
        .expect(201)
    ).body.id as string;
  const offer = opts.operation === 'عرض';
  const files = offer
    ? {
        png: await up('الصور', 'واجهة.png', samples.png()),
        mp4: await up('الفيديو', 'جولة.mp4', media('recorded.mp4')),
        webm: await up('الفيديو', 'تسجيل.webm', media('recorded.webm')),
      }
    : null;
  const answers = [
    { questionId: q('العملية').id, value: opt('العملية', opts.operation) },
    { questionId: q('العنوان').id, value: opts.title },
    { questionId: q('الوصف').id, value: 'ثلاث غرف وصالة ومطبخ' },
    { questionId: q('نوع العقار').id, value: opt('نوع العقار', 'شقة') },
    { questionId: q('الغرض').id, value: opt('الغرض', 'بيع') },
    { questionId: q('المدينة').id, value: 'الرياض' },
    { questionId: q('الحي').id, value: 'النرجس' },
    { questionId: q('السعر').id, value: '850000' },
    { questionId: q('اسم المالك').id, value: 'سارة المالكة' },
    { questionId: q('الجوال').id, value: '0551234567' },
    ...(files
      ? [
          { questionId: q('الصور').id, value: [files.png] },
          { questionId: q('الفيديو').id, value: [files.mp4, files.webm] },
        ]
      : []),
    ...(opts.consent
      ? [{ questionId: q('الموافقة').id, value: opt('الموافقة', opts.consent) }]
      : []),
  ];
  const res = await request(server)
    .post(`/api/public/forms/${publicId}/responses`)
    .set('Origin', ORIGIN)
    .send({ versionId: form.versionId, fillSession: fill, idempotencyKey: randomUUID(), answers })
    .expect(201);
  return (
    await prisma.formResponse.findUniqueOrThrow({
      where: { referenceCode: res.body.referenceCode },
    })
  ).id;
}

const flowmaxUrl = (responseId: string, action = '') =>
  `/api/forms/${formId}/responses/${responseId}/flowmax${action}`;
const state = async (responseId: string) =>
  (await as(reviewer).get(flowmaxUrl(responseId)).expect(200)).body;
const records = (responseId: string) =>
  `/api/admin/integrations/forms/records/${encodeURIComponent(`lawha:response:${responseId}`)}`;

run('تكامل فعلي مع Flowmax محلي منفصل', () => {
  beforeAll(async () => {
    token = readFileSync(process.env.FLOWMAX_REAL_TOKEN_FILE!, 'utf8').trim();
    prisma = new PrismaClient();
    uploadDir = await mkdtemp(join(tmpdir(), 'lawha-fr-'));
    Object.assign(process.env, {
      UPLOAD_SCAN_MODE: 'disabled',
      UPLOAD_DIR: uploadDir,
      PUBLIC_UPLOAD_PER_IP_PER_MINUTE: '100000',
      PUBLIC_UPLOAD_PER_FORM_PER_MINUTE: '100000',
      FLOWMAX_ENABLED: 'true',
      FLOWMAX_API_BASE_URL: REAL_URL,
      FLOWMAX_SERVICE_TOKEN: token,
      FLOWMAX_TIMEOUT_MS: '30000',
      FLOWMAX_MEDIA_TIMEOUT_MS: '60000',
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
        displayName: 'مدير التكامل الفعلي',
        passwordHash: await hashPassword(ADMIN.password),
        role: UserRole.ADMIN,
      },
    });
    admin = await login(ADMIN);
    await as(admin)
      .post('/api/users', {
        username: REVIEWER.username,
        displayName: 'مراجع',
        password: REVIEWER.password,
        permissions: ['FORMS_VIEW', 'RESPONSES_VIEW', 'RESPONSES_REVIEW'],
      })
      .expect(201);
    reviewer = await login(REVIEWER);

    const title = 'عروض وطلبات (تكامل فعلي)';
    formId = (await as(admin).post('/api/forms', { title }).expect(201)).body.id;
    const choice = (t: string, labels: string[], required = true) => ({
      type: 'SINGLE_CHOICE',
      title: t,
      required,
      settings: {},
      options: labels.map((label) => ({ label })),
    });
    const text = (t: string) => ({ type: 'SHORT_TEXT', title: t, required: false, settings: {} });
    const files = (t: string, allowedTypes: string[]) => ({
      type: 'FILE_UPLOAD',
      title: t,
      required: false,
      settings: { allowedTypes, maxFileSizeMb: 5, maxFiles: 3 },
    });
    const questions = [
      choice('العملية', ['عرض', 'طلب']),
      text('العنوان'),
      { type: 'PARAGRAPH', title: 'الوصف', required: false, settings: {} },
      choice('نوع العقار', ['شقة', 'فيلا']),
      choice('الغرض', ['بيع', 'إيجار']),
      text('المدينة'),
      text('الحي'),
      { type: 'NUMBER', title: 'السعر', required: true, settings: { allowDecimals: false } },
      text('اسم المالك'),
      text('الجوال'),
      files('الصور', ['png', 'jpg', 'webp']),
      files('الفيديو', ['mp4', 'webm', 'mov']),
      choice('الموافقة', ['نعم، أوافق', 'لا'], false),
    ];
    await as(admin)
      .put(`/api/forms/${formId}/draft`, { revision: 1, title, questions })
      .expect(200);
    const draft = (await as(admin).get(`/api/forms/${formId}/draft`).expect(200)).body;
    publicId = (
      await as(admin)
        .post(`/api/forms/${formId}/publish`, {
          revision: draft.revision,
          publishKey: randomUUID(),
          openResponses: true,
        })
        .expect(200)
    ).body.form.publication.publicId;
    form = (await request(app.getHttpServer()).get(`/api/public/forms/${publicId}`).expect(200))
      .body;
    const key = (t: string) => ({ questionId: q(t).key });
    await as(admin)
      .put(`/api/forms/${formId}/flowmax-mapping`, {
        enabled: true,
        config: {
          fields: {
            operation: key('العملية'),
            title_ar: key('العنوان'),
            description_ar: key('الوصف'),
            property_category: key('نوع العقار'),
            listing_purpose: key('الغرض'),
            city: key('المدينة'),
            district: key('الحي'),
            price: key('السعر'),
            contact_name: key('اسم المالك'),
            contact_phone: key('الجوال'),
            images: key('الصور'),
            videos: key('الفيديو'),
            consent: key('الموافقة'),
            consent_version: { constant: 'forms-2026-10' },
            type_letter: { constant: 'M' },
            developer_id: { constant: process.env.FLOWMAX_REAL_DEVELOPER_ID },
            mediation_contract_number: { constant: 'MCN-LOCAL' },
            contract_date: { constant: '2026-03-15' },
            fal_license_number: { constant: 'FAL-LOCAL' },
          },
        },
      })
      .expect(200);
  }, 120_000);

  afterAll(async () => {
    await app?.get(FlowmaxService).whenIdle();
    await app?.close();
    await prisma?.$disconnect();
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  });

  let offerId: string;

  it('عرض: اعتمادات متزامنة ⇒ سجل واحد في Flowmax مع الصورة والفيديوهين، والمسودة بلا مشاركة', async () => {
    offerId = await submit({ operation: 'عرض', title: 'شقة النرجس (تكامل فعلي)' });
    const results = await Promise.all(
      [1, 2, 3].map(() => as(reviewer).post(flowmaxUrl(offerId, '/approve'))),
    );
    expect(results.map((r) => r.status)).toEqual([202, 202, 202]);
    await app.get(FlowmaxService).whenIdle();
    const s = (await state(offerId)).sync;
    expect(s).toMatchObject({ status: 'SENT', operation: 'OFFER', isPublic: false, share: null });
    expect(s.media.map((m: any) => m.status)).toEqual(['SENT', 'SENT', 'SENT']);
    expect(s.detailUrl).toBe(`http://flowmax-site.localhost:3999/property/${s.flowmaxId}`);
    const record = (await flowmaxApi().get(records(offerId)).expect(200)).body.data;
    expect(record).toMatchObject({
      id: Number(s.flowmaxId),
      status: 'Draft',
      images_count: 1,
      videos_count: 2,
      is_public: false,
    });
    expect(JSON.stringify(record)).not.toMatch(OWNER);
  });

  it('إعادة الإنشاء بالمفتاح نفسه تعيد السجل نفسه، ومحتوى مختلف ⇒ 409 من Flowmax', async () => {
    const sync = await prisma.flowmaxSync.findUniqueOrThrow({ where: { responseId: offerId } });
    const payload = { source_key: sync.sourceKey, ...(sync.payload as object) };
    const replay = await flowmaxApi()
      .post('/api/admin/integrations/forms/offers', payload)
      .expect(200);
    expect(replay.body.data).toMatchObject({ id: Number(sync.flowmaxId), replayed: true });
    const conflict = await flowmaxApi()
      .post('/api/admin/integrations/forms/offers', { ...payload, requested_price: 1_000 })
      .expect(409);
    expect(conflict.body.error.code).toBe('integration_key_conflict');
    // إعادة المحاولة من لوحة النماذج لا تنشئ شيئًا جديدًا
    await prisma.flowmaxSync.update({ where: { id: sync.id }, data: { status: 'FAILED' } });
    await as(reviewer).post(flowmaxUrl(offerId, '/retry')).expect(202);
    await app.get(FlowmaxService).whenIdle();
    const record = (await flowmaxApi().get(records(offerId)).expect(200)).body.data;
    expect(record).toMatchObject({ id: Number(sync.flowmaxId), images_count: 1, videos_count: 2 });
  });

  it('نشر العرض بقواعد Flowmax ثم المشاركة برابط التفاصيل، والصفحة العامة بلا بيانات المالك', async () => {
    const res = await as(reviewer).post(flowmaxUrl(offerId, '/publish')).expect(200);
    expect(res.body.sync).toMatchObject({ publishState: 'PUBLISHED', isPublic: true });
    expect(res.body.sync.share).toMatchObject({ title: 'شقة النرجس (تكامل فعلي)', city: 'الرياض' });
    expect(JSON.stringify(res.body)).not.toMatch(OWNER);
    const pub = await request(REAL_URL!)
      .get(`/api/public/properties/${res.body.sync.flowmaxId}`)
      .set('Accept', 'application/json')
      .expect(200);
    expect(JSON.stringify(pub.body)).not.toMatch(OWNER);
  });

  it('طلب: رابط تفاصيل الطلب نفسه، وغير عام قبل مراجعة Flowmax', async () => {
    const id = await submit({
      operation: 'طلب',
      title: 'طلب شقة (تكامل فعلي)',
      consent: 'نعم، أوافق',
    });
    await as(reviewer).post(flowmaxUrl(id, '/approve')).expect(202);
    await app.get(FlowmaxService).whenIdle();
    const s = (await state(id)).sync;
    expect(s).toMatchObject({ status: 'SENT', operation: 'REQUEST', isPublic: false, share: null });
    expect(s.detailUrl).toBe(
      `http://flowmax-site.localhost:3999/properties/demands/${s.flowmaxRef}`,
    );
    const record = (await flowmaxApi().get(records(id)).expect(200)).body.data;
    expect(record).toMatchObject({
      reference: s.flowmaxRef,
      status: 'under_review',
      is_public: false,
    });
    expect(JSON.stringify(record)).not.toMatch(OWNER);
    const refreshed = await as(reviewer).post(flowmaxUrl(id, '/refresh')).expect(200);
    expect(refreshed.body.sync.share).toBeNull();
  });
});
