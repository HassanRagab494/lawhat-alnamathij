import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient, UserRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
 *   FLOWMAX_REAL_SITE_URL=… (اختياري: قيمة FRONTEND_URL في نسخة Flowmax نفسها)
 * يمر التطبيق عبر وكيل محلي إلى Flowmax الحقيقي ليُختبر التعطل وضياع الاستجابة دون خادم وهمي.
 * يُشغَّل وحده (`npm run test:e2e -- flowmax-real`) لأنه يترك بيانات في قاعدة الاختبار تتوقع بقية الملفات خلوها منها.
 */
const REAL_URL = process.env.FLOWMAX_REAL_URL;
const enabled = Boolean(REAL_URL);
if (enabled && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(REAL_URL!)) {
  throw new Error('FLOWMAX_REAL_URL must point to a local Flowmax instance');
}
const run = enabled ? describe : describe.skip;
const SITE = process.env.FLOWMAX_REAL_SITE_URL ?? 'http://flowmax-site.localhost:3999';

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
    { questionId: q('مساحة العقار بالمتر').id, value: '145' },
    { questionId: q('عدد الغرف').id, value: '3' },
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

/**
 * وكيل بين التطبيق وFlowmax الحقيقي:
 * - pass: تمرير كما هو.
 * - down: Flowmax متعطل (503) ولا يصله الطلب.
 * - drop-create: يمرر طلب الإنشاء إلى Flowmax وينتظر اكتماله ثم يقطع الاتصال قبل وصول الاستجابة.
 * - hold-create: يحتجز استجابة الإنشاء حتى release() ليُرى «جارٍ الإرسال».
 */
type ProxyMode = 'pass' | 'down' | 'drop-create' | 'hold-create';
const proxyState = {
  mode: 'pass' as ProxyMode,
  dropped: 0,
  release: null as null | (() => void),
};
const isCreate = (method: string | undefined, path: string) =>
  method === 'POST' && /\/api\/admin\/integrations\/forms\/(offers|demands)$/.test(path);
const proxy = http.createServer((req, res) => {
  if (proxyState.mode === 'down') {
    req.resume();
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"success":false,"error":{"code":"service_unavailable"}}');
    return;
  }
  const target = new URL(req.url ?? '/', REAL_URL);
  const upstream = http.request(
    target,
    { method: req.method, headers: { ...req.headers, host: target.host } },
    (upRes) => {
      const create = isCreate(req.method, target.pathname);
      if (create && proxyState.mode === 'drop-create') {
        proxyState.mode = 'pass';
        proxyState.dropped++;
        upRes.resume();
        upRes.on('end', () => req.socket.destroy());
        return;
      }
      const forward = () => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      };
      if (create && proxyState.mode === 'hold-create') {
        proxyState.mode = 'pass';
        proxyState.release = forward;
        return;
      }
      forward();
    },
  );
  upstream.on('error', () => res.destroy());
  req.pipe(upstream);
});
async function waitFor(check: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

run('تكامل فعلي مع Flowmax محلي منفصل', () => {
  beforeAll(async () => {
    token = readFileSync(process.env.FLOWMAX_REAL_TOKEN_FILE!, 'utf8').trim();
    prisma = new PrismaClient();
    uploadDir = await mkdtemp(join(tmpdir(), 'lawha-fr-'));
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    Object.assign(process.env, {
      UPLOAD_SCAN_MODE: 'disabled',
      UPLOAD_DIR: uploadDir,
      PUBLIC_UPLOAD_PER_IP_PER_MINUTE: '100000',
      PUBLIC_UPLOAD_PER_FORM_PER_MINUTE: '100000',
      FLOWMAX_ENABLED: 'true',
      FLOWMAX_API_BASE_URL: proxyUrl,
      FLOWMAX_SERVICE_TOKEN: token,
      FLOWMAX_DEVELOPER_ID: process.env.FLOWMAX_REAL_DEVELOPER_ID,
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
      {
        type: 'NUMBER',
        title: 'مساحة العقار بالمتر',
        required: false,
        settings: { allowDecimals: true },
      },
      { type: 'NUMBER', title: 'عدد الغرف', required: false, settings: { allowDecimals: false } },
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
    // لا إعداد ربط: الحقول تُكتشف تلقائيًا من عناوين الأسئلة عند الاعتماد
  }, 120_000);

  afterAll(async () => {
    await app?.get(FlowmaxService).whenIdle();
    // تنظيف بيانات هذا الملف من قاعدة الاختبار حتى لا تؤثر على ترتيب بقية الاختبارات
    // (المرحلة الأولى تتوقع عدم وجود مدير، والمرحلة النهائية تفحص كل الملفات المرتبطة).
    if (prisma) {
      const users = await prisma.user.findMany({
        where: { username: { in: [ADMIN.username, REVIEWER.username, 'fr.viewer'] } },
        select: { id: true },
      });
      const ids = users.map((u) => u.id);
      const formIds = (
        await prisma.form.findMany({ where: { createdById: { in: ids } }, select: { id: true } })
      ).map((f) => f.id);
      await prisma.flowmaxSync.deleteMany({ where: { formId: { in: formIds } } });
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
    await new Promise((resolve) => proxy.close(resolve));
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  });

  let offerId: string;

  it('عرض: اعتمادات متزامنة ⇒ سجل واحد في Flowmax مع الصورة والفيديوهين، ثم النشر والرابط والمشاركة', async () => {
    offerId = await submit({ operation: 'عرض', title: 'شقة النرجس (تكامل فعلي)' });
    const results = await Promise.all(
      [1, 2, 3].map(() => as(reviewer).post(flowmaxUrl(offerId, '/approve'))),
    );
    expect(results.map((r) => r.status)).toEqual([202, 202, 202]);
    await app.get(FlowmaxService).whenIdle();
    const s = (await state(offerId)).sync;
    expect(s).toMatchObject({
      status: 'SENT',
      operation: 'OFFER',
      publishState: 'PUBLISHED',
      isPublic: true,
    });
    expect(s.share).toMatchObject({
      title: 'شقة النرجس (تكامل فعلي)',
      city: 'الرياض',
      district: 'النرجس',
    });
    expect(JSON.stringify(s)).not.toMatch(OWNER);
    expect(s.media.map((m: any) => m.status)).toEqual(['SENT', 'SENT', 'SENT']);
    expect(s.detailUrl).toBe(`${SITE}/property/${s.flowmaxId}`);
    const record = (await flowmaxApi().get(records(offerId)).expect(200)).body.data;
    expect(record).toMatchObject({
      id: Number(s.flowmaxId),
      status: 'Published',
      images_count: 1,
      videos_count: 2,
      is_public: true,
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
    expect(s.detailUrl).toBe(`${SITE}/properties/demands/${s.flowmaxRef}`);
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

  it('«جارٍ الإرسال» دون مشاركة أثناء الإنشاء، ثم الإرسال والنشر بعد رد Flowmax', async () => {
    const id = await submit({ operation: 'عرض', title: 'شقة حالة الإرسال (تكامل فعلي)' });
    proxyState.mode = 'hold-create';
    await as(reviewer).post(flowmaxUrl(id, '/approve')).expect(202);
    await waitFor(async () => proxyState.release !== null);
    expect((await state(id)).sync).toMatchObject({
      status: 'SENDING',
      share: null,
      isPublic: false,
    });
    proxyState.release!();
    proxyState.release = null;
    await app.get(FlowmaxService).whenIdle();
    const done = (await state(id)).sync;
    expect(done).toMatchObject({ status: 'SENT', publishState: 'PUBLISHED', isPublic: true });
    expect(done.share).not.toBeNull();
  });

  it('تعطل Flowmax ⇒ «فشل الإرسال» دون سجل هناك، وإعادة المحاولة تنشئ سجلًا واحدًا', async () => {
    const id = await submit({ operation: 'عرض', title: 'شقة تعطل Flowmax (تكامل فعلي)' });
    proxyState.mode = 'down';
    await as(reviewer).post(flowmaxUrl(id, '/approve')).expect(202);
    await app.get(FlowmaxService).whenIdle();
    const failed = (await state(id)).sync;
    expect(failed).toMatchObject({ status: 'FAILED', flowmaxId: null, share: null });
    expect(failed.lastError).toBeTruthy();
    await flowmaxApi().get(records(id)).expect(404);

    proxyState.mode = 'pass';
    await as(reviewer).post(flowmaxUrl(id, '/retry')).expect(202);
    await app.get(FlowmaxService).whenIdle();
    const sent = (await state(id)).sync;
    expect(sent).toMatchObject({ status: 'SENT', lastError: null });
    const record = (await flowmaxApi().get(records(id)).expect(200)).body.data;
    expect(record).toMatchObject({ id: Number(sent.flowmaxId), images_count: 1, videos_count: 2 });
  });

  it('وصول الإنشاء إلى Flowmax ثم انقطاع الاتصال قبل الاستجابة ⇒ إعادة المحاولة تعيد السجل نفسه', async () => {
    const id = await submit({ operation: 'عرض', title: 'شقة انقطاع الاستجابة (تكامل فعلي)' });
    const dropped = proxyState.dropped;
    proxyState.mode = 'drop-create';
    await as(reviewer).post(flowmaxUrl(id, '/approve')).expect(202);
    await app.get(FlowmaxService).whenIdle();
    expect(proxyState.dropped).toBe(dropped + 1);
    expect((await state(id)).sync).toMatchObject({ status: 'FAILED', flowmaxId: null });
    // السجل أُنشئ فعلًا في Flowmax رغم ضياع الاستجابة
    const created = (await flowmaxApi().get(records(id)).expect(200)).body.data;

    await as(reviewer).post(flowmaxUrl(id, '/retry')).expect(202);
    await app.get(FlowmaxService).whenIdle();
    expect((await state(id)).sync).toMatchObject({ status: 'SENT', flowmaxId: String(created.id) });
    const record = (await flowmaxApi().get(records(id)).expect(200)).body.data;
    expect(record).toMatchObject({ id: created.id, images_count: 1, videos_count: 2 });
  });

  it('الضغط على الاعتماد مرتين متتاليتين ⇒ سجل تكامل واحد وسجل Flowmax واحد', async () => {
    const id = await submit({ operation: 'عرض', title: 'شقة اعتماد مزدوج (تكامل فعلي)' });
    const first = await as(reviewer).post(flowmaxUrl(id, '/approve')).expect(202);
    const second = await as(reviewer).post(flowmaxUrl(id, '/approve')).expect(202);
    await app.get(FlowmaxService).whenIdle();
    expect(second.body.sync.approvedAt).toBe(first.body.sync.approvedAt);
    expect(await prisma.flowmaxSync.count({ where: { responseId: id } })).toBe(1);
    const s = (await state(id)).sync;
    expect(s.attempts).toBe(1);
    const record = (await flowmaxApi().get(records(id)).expect(200)).body.data;
    expect(record).toMatchObject({ id: Number(s.flowmaxId), images_count: 1, videos_count: 2 });
  });

  it('الصلاحيات: دون مراجعة الردود لا اعتماد ولا إعادة ولا نشر، ودون جلسة 401', async () => {
    const id = await submit({ operation: 'عرض', title: 'شقة الصلاحيات (تكامل فعلي)' });
    const viewerCreds = { username: 'fr.viewer', password: 'FR-viewer-pass-2026!' };
    await as(admin)
      .post('/api/users', {
        ...viewerCreds,
        displayName: 'مشاهد',
        permissions: ['FORMS_VIEW', 'RESPONSES_VIEW'],
      })
      .expect(201);
    const viewer = await login(viewerCreds);
    await as(viewer).get(flowmaxUrl(id)).expect(200);
    for (const action of ['/approve', '/retry', '/publish', '/refresh']) {
      await as(viewer).post(flowmaxUrl(id, action)).expect(403);
    }
    await request(app.getHttpServer())
      .post(flowmaxUrl(id, '/approve'))
      .set('Origin', ORIGIN)
      .expect(401);
    expect(await prisma.flowmaxSync.count({ where: { responseId: id } })).toBe(0);
    await flowmaxApi().get(records(id)).expect(404);
  });

  describe('النموذج العقاري الموحّد (هويات دلالية وأسئلة شرطية)', () => {
    let tFormId: string;
    let tPublicId: string;
    let tDraft: any;
    let tForm: any;
    const tq = (semantic: string) => {
      const dq = tDraft.questions.find((x: any) => x.semanticKey === semantic);
      return tForm.questions.find((x: any) => x.key === dq.id);
    };
    const to = (semantic: string, option: string) => {
      const dq = tDraft.questions.find((x: any) => x.semanticKey === semantic);
      const key = dq.options.find((o: any) => o.semanticKey === option).id;
      return tq(semantic).options.find((o: any) => o.key === key).id as string;
    };
    const tUrl = (id: string, action = '') =>
      `/api/forms/${tFormId}/responses/${id}/flowmax${action}`;
    const tState = async (id: string) => (await as(reviewer).get(tUrl(id)).expect(200)).body;

    async function tSubmit(kind: 'offer' | 'request'): Promise<string> {
      const server = app.getHttpServer();
      const fill = (
        await request(server)
          .post(`/api/public/forms/${tPublicId}/upload-sessions`)
          .set('Origin', ORIGIN)
          .send({})
          .expect(201)
      ).body.token;
      const up = async (semantic: string, name: string, data: Buffer) =>
        (
          await request(server)
            .post(`/api/public/forms/${tPublicId}/files?questionId=${tq(semantic).id}`)
            .set('Origin', ORIGIN)
            .set('Content-Type', 'application/octet-stream')
            .set('x-file-name', encodeURIComponent(name))
            .set('x-fill-session', fill)
            .send(data)
            .expect(201)
        ).body.id as string;
      const answers =
        kind === 'offer'
          ? [
              { questionId: tq('listing.kind').id, value: to('listing.kind', 'offer') },
              { questionId: tq('offer.category').id, value: to('offer.category', 'apartment') },
              { questionId: tq('offer.purpose').id, value: to('offer.purpose', 'rent') },
              { questionId: tq('offer.role').id, value: to('offer.role', 'broker') },
              {
                questionId: tq('offer.description').id,
                value: 'بيانات تجريبية — ليست عقارًا حقيقيًا.',
              },
              { questionId: tq('offer.city').id, value: 'الرياض' },
              { questionId: tq('offer.district').id, value: 'الياسمين' },
              { questionId: tq('offer.price').id, value: '65000' },
              { questionId: tq('offer.area').id, value: '140.5' },
              { questionId: tq('offer.bedrooms').id, value: '3' },
              { questionId: tq('offer.bathrooms').id, value: '2' },
              { questionId: tq('offer.living_rooms').id, value: '1' },
              { questionId: tq('offer.kitchens').id, value: '1' },
              {
                questionId: tq('offer.images').id,
                value: [await up('offer.images', 'واجهة.png', samples.png())],
              },
              {
                questionId: tq('offer.videos').id,
                value: [await up('offer.videos', 'جولة.mp4', media('recorded.mp4'))],
              },
              { questionId: tq('contact.name').id, value: 'وسيط تجريبي' },
              { questionId: tq('contact.phone').id, value: '0551234500' },
            ]
          : [
              { questionId: tq('listing.kind').id, value: to('listing.kind', 'request') },
              { questionId: tq('request.category').id, value: to('request.category', 'land') },
              { questionId: tq('request.purpose').id, value: to('request.purpose', 'sale') },
              { questionId: tq('request.land_use').id, value: 'سكني' },
              { questionId: tq('request.city').id, value: 'الدمام' },
              { questionId: tq('request.district').id, value: 'الشاطئ' },
              { questionId: tq('request.budget_max').id, value: '1800000' },
              { questionId: tq('request.budget_min').id, value: '1200000' },
              {
                questionId: tq('request.sale_priority').id,
                value: to('request.sale_priority', 'urgent'),
              },
              { questionId: tq('request.land_area_min').id, value: '600' },
              {
                questionId: tq('request.finance_required').id,
                value: to('request.finance_required', 'true'),
              },
              { questionId: tq('request.consent').id, value: to('request.consent', 'yes') },
              { questionId: tq('contact.name').id, value: 'طالب تجريبي' },
              { questionId: tq('contact.phone').id, value: '0551234501' },
            ];
      const res = await request(server)
        .post(`/api/public/forms/${tPublicId}/responses`)
        .set('Origin', ORIGIN)
        .send({
          versionId: tForm.versionId,
          fillSession: fill,
          idempotencyKey: randomUUID(),
          answers,
        })
        .expect(201);
      return (
        await prisma.formResponse.findUniqueOrThrow({
          where: { referenceCode: res.body.referenceCode },
        })
      ).id;
    }

    beforeAll(async () => {
      tFormId = (
        await as(admin)
          .post('/api/forms', {
            title: 'تسجيل عقار موحّد (تكامل فعلي)',
            template: 'real-estate-unified',
          })
          .expect(201)
      ).body.id;
      tDraft = (await as(admin).get(`/api/forms/${tFormId}/draft`).expect(200)).body;
      tPublicId = (
        await as(admin)
          .post(`/api/forms/${tFormId}/publish`, {
            revision: tDraft.revision,
            publishKey: randomUUID(),
            openResponses: true,
          })
          .expect(200)
      ).body.form.publication.publicId;
      tForm = (await request(app.getHttpServer()).get(`/api/public/forms/${tPublicId}`).expect(200))
        .body;
    });

    it('عرض من القالب ⇒ مسار العروض في Flowmax الحقيقي، نشر تلقائي، اعتماد مزدوج دون تكرار', async () => {
      const id = await tSubmit('offer');
      const results = await Promise.all([1, 2].map(() => as(reviewer).post(tUrl(id, '/approve'))));
      expect(results.map((r) => r.status)).toEqual([202, 202]);
      await app.get(FlowmaxService).whenIdle();
      const s = (await tState(id)).sync;
      expect(s).toMatchObject({
        status: 'SENT',
        operation: 'OFFER',
        isPublic: true,
        publishState: 'PUBLISHED',
        attempts: 1,
      });
      // رمز التصنيف حسب الغرض (إيجار ⇒ J) كما يختاره معالج Flowmax
      expect(s.flowmaxRef).toMatch(/^J-/);
      const record = (await flowmaxApi().get(records(id)).expect(200)).body.data;
      expect(record).toMatchObject({
        operation: 'offer',
        status: 'Published',
        is_public: true,
        images_count: 1,
        videos_count: 1,
      });
      expect(s.share).toMatchObject({
        operation: 'OFFER',
        purpose: 'إيجار',
        category: 'شقة',
        areaSqm: 140.5,
        bedrooms: 3,
      });
      expect(JSON.stringify(s.share)).not.toMatch(/0551234500|وسيط تجريبي/);
      const pub = await request(REAL_URL!)
        .get(`/api/public/properties/${s.flowmaxId}`)
        .set('Accept', 'application/json')
        .expect(200);
      expect(JSON.stringify(pub.body)).not.toMatch(/0551234500|وسيط تجريبي/);
      // «وصف العقار» هو وصف الإعلان في Flowmax، والعنوان من النوع والغرض والموقع (لا سؤال عنوان)
      expect(pub.body.data).toMatchObject({
        description_ar: 'بيانات تجريبية — ليست عقارًا حقيقيًا.',
        title_ar: 'شقة للإيجار في الرياض — الياسمين',
        bedrooms_count: 3,
        bathrooms_count: 2,
        kitchens_count: 1,
      });
      await as(reviewer).post(tUrl(id, '/approve')).expect(202);
      await app.get(FlowmaxService).whenIdle();
      expect((await flowmaxApi().get(records(id)).expect(200)).body.data.id).toBe(record.id);
      expect(await prisma.flowmaxSync.count({ where: { responseId: id } })).toBe(1);
    });

    it('طلب من القالب ⇒ مسار الطلبات، بانتظار مراجعة Flowmax ودون مشاركة؛ التعطل ثم إعادة المحاولة دون تكرار', async () => {
      const id = await tSubmit('request');
      proxyState.mode = 'down';
      await as(reviewer).post(tUrl(id, '/approve')).expect(202);
      await app.get(FlowmaxService).whenIdle();
      expect((await tState(id)).sync.status).toBe('FAILED');
      await flowmaxApi().get(records(id)).expect(404);

      proxyState.mode = 'pass';
      await as(reviewer).post(tUrl(id, '/retry')).expect(202);
      await app.get(FlowmaxService).whenIdle();
      const s = (await tState(id)).sync;
      expect(s).toMatchObject({
        status: 'SENT',
        operation: 'REQUEST',
        isPublic: false,
        share: null,
        attempts: 2,
      });
      const record = (await flowmaxApi().get(records(id)).expect(200)).body.data;
      expect(record).toMatchObject({
        operation: 'demand',
        status: 'under_review',
        is_public: false,
      });
      expect(s.detailUrl).toBe(record.detail_url);
      // الاعتماد مرة أخرى يعيد الحالة نفسها دون إنشاء جديد
      await as(reviewer).post(tUrl(id, '/approve')).expect(202);
      await app.get(FlowmaxService).whenIdle();
      expect((await flowmaxApi().get(records(id)).expect(200)).body.data.id).toBe(record.id);
      expect(await prisma.flowmaxSync.count({ where: { responseId: id } })).toBe(1);
    });
  });
});
