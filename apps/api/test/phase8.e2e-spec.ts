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
 * مراجعة الردود: تعديل الرد قبل الاعتماد وسجله، التعارض، الصلاحيات، الرفض بسبب إلزامي، مشاركة سبب الرفض،
 * ومنع إرسال المرفوض، وحقول القالب الجديدة. Flowmax هنا خادم وهمي محلي فقط.
 */

const ORIGIN = 'http://localhost:3000';
const ADMIN = { username: 'p8.admin', password: 'P8-admin-pass-2026!' };
const REVIEWER = { username: 'p8.reviewer', password: 'P8-review-pass-2026!' };
const VIEWER = { username: 'p8.viewer', password: 'P8-viewer-pass-2026!' };
const USERNAMES = [ADMIN, REVIEWER, VIEWER].map((u) => u.username);

let app: NestExpressApplication;
let prisma: PrismaClient;
let mock: MockFlowmax;
let uploadDir: string;
const savedEnv = { ...process.env };

interface Session {
  cookie: string[];
  csrf: string;
}
const server = () => app.getHttpServer();

async function login(u: { username: string; password: string }): Promise<Session> {
  const res = await request(server())
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send(u)
    .expect(200);
  return { cookie: res.headers['set-cookie'] as unknown as string[], csrf: res.body.csrfToken };
}
function as(s: Session) {
  const auth = (req: request.Test) =>
    req.set('Cookie', s.cookie).set('Origin', ORIGIN).set('x-csrf-token', s.csrf);
  return {
    get: (url: string) => request(server()).get(url).set('Cookie', s.cookie),
    post: (url: string, body?: object) => auth(request(server()).post(url)).send(body ?? {}),
    patch: (url: string, body: object) => auth(request(server()).patch(url)).send(body),
    put: (url: string, body: object) => auth(request(server()).put(url)).send(body),
    del: (url: string) => auth(request(server()).delete(url)),
    upload: (url: string, name: string, data: Buffer) =>
      auth(request(server()).post(url))
        .set('Content-Type', 'application/octet-stream')
        .set('x-file-name', encodeURIComponent(name))
        .send(data),
  };
}

let admin: Session;
let reviewer: Session;
let viewer: Session;
let formId: string;
let publicId: string;
let draft: any;
let form: any;

const dq = (k: string) => draft.questions.find((q: any) => q.semanticKey === k);
const pq = (k: string) => form.questions.find((q: any) => q.key === dq(k).id);
const po = (k: string, o: string) =>
  pq(k).options.find((x: any) => x.key === dq(k).options.find((y: any) => y.semanticKey === o).id)
    .id as string;
const base = (id: string) => `/api/forms/${formId}/responses/${id}`;

async function fill(): Promise<string> {
  return (
    await request(server())
      .post(`/api/public/forms/${publicId}/upload-sessions`)
      .set('Origin', ORIGIN)
      .send({})
      .expect(201)
  ).body.token;
}
async function uploadPublic(token: string, key: string, name: string, data: Buffer) {
  return (
    await request(server())
      .post(`/api/public/forms/${publicId}/files?questionId=${pq(key).id}`)
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/octet-stream')
      .set('x-file-name', encodeURIComponent(name))
      .set('x-fill-session', token)
      .send(data)
      .expect(201)
  ).body.id as string;
}

/** عرض كامل من القالب (صورتان) ويعيد معرّف الرد. */
async function submitOffer(phone = '0500000097'): Promise<{ id: string; images: string[] }> {
  const token = await fill();
  const images = [
    await uploadPublic(token, 'offer.images', 'واجهة.png', samples.png()),
    await uploadPublic(token, 'offer.images', 'صالة.png', samples.png()),
  ];
  const answers = [
    ['listing.kind', po('listing.kind', 'offer')],
    ['offer.category', po('offer.category', 'apartment')],
    ['offer.purpose', po('offer.purpose', 'sale')],
    ['offer.description', 'شقة اختبار بإطلالة — ليست عقارًا حقيقيًا.'],
    ['offer.city', 'الرياض'],
    ['offer.district', 'النرجس'],
    ['offer.price', '900000'],
    ['offer.area', '150'],
    ['offer.bedrooms', '3'],
    ['offer.bathrooms', '2'],
    ['offer.kitchens', '1'],
    ['offer.images', images],
    ['contact.name', 'سارة'],
    ['contact.phone', phone],
  ].map(([k, value]) => ({ questionId: pq(k as string).id, value }));
  const res = await request(server())
    .post(`/api/public/forms/${publicId}/responses`)
    .set('Origin', ORIGIN)
    .send({ versionId: form.versionId, fillSession: token, idempotencyKey: randomUUID(), answers })
    .expect(201);
  const row = await prisma.formResponse.findUniqueOrThrow({
    where: { referenceCode: res.body.referenceCode },
  });
  return { id: row.id, images };
}

beforeAll(async () => {
  prisma = new PrismaClient();
  mock = await startMockFlowmax();
  uploadDir = await mkdtemp(join(tmpdir(), 'lawha-p8-'));
  Object.assign(process.env, {
    UPLOAD_SCAN_MODE: 'disabled',
    UPLOAD_DIR: uploadDir,
    PUBLIC_UPLOAD_PER_IP_PER_MINUTE: '100000',
    PUBLIC_UPLOAD_PER_FORM_PER_MINUTE: '100000',
    PUBLIC_SUBMIT_PER_IP_PER_MINUTE: '100000',
    RESPONSES_RATE_LIMIT_PER_MINUTE: '100000',
    FLOWMAX_ENABLED: 'true',
    FLOWMAX_API_BASE_URL: mock.url,
    FLOWMAX_SERVICE_TOKEN: mock.token,
    FLOWMAX_TIMEOUT_MS: '2000',
    FLOWMAX_DEVELOPER_ID: '7',
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
      displayName: 'مدير المرحلة الثامنة',
      passwordHash: await hashPassword(ADMIN.password),
      role: UserRole.ADMIN,
    },
  });
  admin = await login(ADMIN);
  const create = (u: typeof VIEWER, displayName: string, permissions: string[]) =>
    as(admin)
      .post('/api/users', { ...u, displayName, permissions })
      .expect(201);
  await create(REVIEWER, 'مراجعة الردود', ['FORMS_VIEW', 'RESPONSES_VIEW', 'RESPONSES_REVIEW']);
  await create(VIEWER, 'عارض الردود', ['FORMS_VIEW', 'RESPONSES_VIEW']);
  reviewer = await login(REVIEWER);
  viewer = await login(VIEWER);

  formId = (
    await as(admin)
      .post('/api/forms', { title: 'مراجعة الردود (اختبار)', template: 'real-estate-unified' })
      .expect(201)
  ).body.id;
  draft = (await as(admin).get(`/api/forms/${formId}/draft`).expect(200)).body;
  publicId = (
    await as(admin)
      .post(`/api/forms/${formId}/publish`, {
        revision: draft.revision,
        publishKey: randomUUID(),
        openResponses: true,
      })
      .expect(200)
  ).body.form.publication.publicId;
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
    const responseIds = (
      await prisma.formResponse.findMany({
        where: { formId: { in: formIds } },
        select: { id: true },
      })
    ).map((r) => r.id);
    await prisma.formResponseEdit.deleteMany({ where: { responseId: { in: responseIds } } });
    await prisma.flowmaxSync.deleteMany({ where: { formId: { in: formIds } } });
    await prisma.uploadedFile.deleteMany({ where: { formId: { in: formIds } } });
    await prisma.fillSession.deleteMany({ where: { formId: { in: formIds } } });
    await prisma.formResponseStatusChange.deleteMany({
      where: { responseId: { in: responseIds } },
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
  if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe('مراجعة الردود: التعديل والرفض', () => {
  it('القالب الجديد: «عدد الغرف» و«عدد الحمامات» و«عدد المطابخ» دون «عنوان الإعلان»', () => {
    const titles = form.questions.map((q: any) => q.title);
    expect(titles).toEqual(expect.arrayContaining(['عدد الغرف', 'عدد الحمامات', 'عدد المطابخ']));
    expect(titles).not.toContain('عنوان الإعلان');
    expect(titles).not.toContain('عدد غرف النوم');
  });

  it('تعديل الرد قبل الاعتماد يُسجَّل بالقيمة الأصلية والمعدلة ومن عدّل، ثم يُرسل المعدَّل إلى Flowmax', async () => {
    const { id, images } = await submitOffer();
    const edit = (
      await as(reviewer)
        .get(`${base(id)}/edit`)
        .expect(200)
    ).body;
    expect(edit.revision).toBe(0);
    expect(edit.locked).toBe(false);
    expect(edit.values[pq('offer.city').id]).toBe('الرياض');

    // رفع مرفق جديد وإزالة صورة قديمة وتعديل الحقول
    const added = (
      await as(reviewer)
        .upload(`${base(id)}/files?questionId=${pq('offer.images').id}`, 'جديدة.png', samples.png())
        .expect(201)
    ).body.id;
    const saved = await as(reviewer)
      .patch(`${base(id)}/answers`, {
        revision: 0,
        answers: [
          { questionId: pq('offer.city').id, value: 'جدة' },
          { questionId: pq('offer.district').id, value: 'الشاطئ' },
          { questionId: pq('offer.price').id, value: '850000' },
          { questionId: pq('offer.kitchens').id, value: '2' },
          { questionId: pq('offer.category').id, value: po('offer.category', 'villa') },
          { questionId: pq('offer.images').id, value: [images[0], added] },
          { questionId: pq('contact.phone').id, value: '0500000096' },
        ],
      })
      .expect(200);
    expect(saved.body.editRevision).toBe(1);
    const byTitle = Object.fromEntries(saved.body.edits.map((e: any) => [e.questionTitle, e]));
    expect(byTitle['المدينة']).toMatchObject({
      oldValue: { kind: 'text', value: 'الرياض' },
      newValue: { kind: 'text', value: 'جدة' },
      editedBy: 'مراجعة الردود',
      revision: 1,
    });
    expect(byTitle['نوع العقار']).toMatchObject({
      oldValue: { kind: 'choice', options: ['شقة'] },
      newValue: { kind: 'choice', options: ['فيلا'] },
    });
    expect(byTitle['صور العقار'].oldValue.files.map((f: any) => f.name)).toEqual([
      'واجهة.png',
      'صالة.png',
    ]);
    expect(byTitle['صور العقار'].newValue.files.map((f: any) => f.name)).toEqual([
      'واجهة.png',
      'جديدة.png',
    ]);
    // الصورة المُزالة لم تُحذف: ملفها وربطها باقيان مع removed_at
    const removed = await prisma.uploadedFile.findUniqueOrThrow({ where: { id: images[1] } });
    expect(removed.responseId).toBe(id);
    expect(removed.removedAt).not.toBeNull();
    const view = (title: string) => saved.body.answers.find((a: any) => a.title === title);
    expect(view('صور العقار').files.map((f: any) => f.name)).toEqual(['واجهة.png', 'جديدة.png']);
    expect(await prisma.formResponseEdit.count({ where: { responseId: id } })).toBe(7);

    // الاعتماد بالمراجعة القديمة يُرفض؛ بالمراجعة الحالية يُرسل المعدَّل
    await as(reviewer)
      .post(`${base(id)}/flowmax/approve`, { editRevision: 0 })
      .expect(409);
    await as(reviewer)
      .post(`${base(id)}/flowmax/approve`, { editRevision: 1 })
      .expect(202);
    await app.get(FlowmaxService).whenIdle();
    const p = mock.properties.find((x) => x.sourceKey === `lawha:response:${id}`)!;
    expect(p.payload).toMatchObject({
      city: 'جدة',
      district: 'الشاطئ',
      requested_price: 85_000_000,
      property_category: 'villa',
      kitchens_count: 2,
      bedrooms_count: 3,
      bathrooms_count: 2,
      description_ar: 'شقة اختبار بإطلالة — ليست عقارًا حقيقيًا.',
      title_ar: 'فيلا للبيع في جدة — الشاطئ',
      contact_phone: '+966500000096',
    });
    expect(p.images).toBe(2);
    const state = (
      await as(reviewer)
        .get(`${base(id)}/flowmax`)
        .expect(200)
    ).body;
    expect(state.sync.share).toMatchObject({
      description: 'شقة اختبار بإطلالة — ليست عقارًا حقيقيًا.',
      kitchens: 2,
    });
    expect(JSON.stringify(state.sync.share)).not.toMatch(/0500000096|سارة/);

    // بعد الإرسال لا تعديل ولا رفع
    const locked = await as(reviewer)
      .patch(`${base(id)}/answers`, {
        revision: 1,
        answers: [{ questionId: pq('offer.city').id, value: 'الدمام' }],
      })
      .expect(409);
    expect(locked.body.code).toBe('RESPONSE_LOCKED');
    await as(reviewer)
      .upload(`${base(id)}/files?questionId=${pq('offer.images').id}`, 'x.png', samples.png())
      .expect(409);
  });

  it('إعادة التحقق بعد التعديل، وتبديل العرض إلى طلب يطبق الشروط ولا يرسل الفرع المخفي', async () => {
    const { id } = await submitOffer();
    // مسح حقل إجباري ظاهر ⇒ 400 دون حفظ
    const bad = await as(reviewer)
      .patch(`${base(id)}/answers`, {
        revision: 0,
        answers: [{ questionId: pq('offer.city').id, value: null }],
      })
      .expect(400);
    expect(bad.body.fields).toContainEqual({
      field: `answers.${pq('offer.city').id}`,
      message: 'هذا السؤال إجباري.',
    });
    // التحويل إلى طلب يتطلب أسئلة الطلب الإجبارية
    const incomplete = await as(reviewer)
      .patch(`${base(id)}/answers`, {
        revision: 0,
        answers: [{ questionId: pq('listing.kind').id, value: po('listing.kind', 'request') }],
      })
      .expect(400);
    expect(incomplete.body.fields.map((f: any) => f.field)).toEqual(
      expect.arrayContaining([
        `answers.${pq('request.city').id}`,
        `answers.${pq('request.consent').id}`,
      ]),
    );
    await as(reviewer)
      .patch(`${base(id)}/answers`, {
        revision: 0,
        answers: [
          { questionId: pq('listing.kind').id, value: po('listing.kind', 'request') },
          { questionId: pq('request.category').id, value: po('request.category', 'apartment') },
          { questionId: pq('request.purpose').id, value: po('request.purpose', 'rent') },
          { questionId: pq('request.city').id, value: 'جدة' },
          { questionId: pq('request.budget_max').id, value: '70000' },
          { questionId: pq('request.consent').id, value: po('request.consent', 'yes') },
        ],
      })
      .expect(200);
    // قيمة لسؤال صار مخفيًا ⇒ 400
    const hidden = await as(reviewer)
      .patch(`${base(id)}/answers`, {
        revision: 1,
        answers: [{ questionId: pq('offer.city').id, value: 'الخبر' }],
      })
      .expect(400);
    expect(hidden.body.fields[0].message).toMatch(/غير ظاهر/);
    await as(reviewer)
      .post(`${base(id)}/flowmax/approve`, { editRevision: 1 })
      .expect(202);
    await app.get(FlowmaxService).whenIdle();
    const demand = mock.demands.find((d) => d.sourceKey === `lawha:response:${id}`)!;
    expect(demand.payload).toMatchObject({
      property_category: 'apartment',
      listing_purpose: 'rent',
      city: 'جدة',
    });
    // إجابات العرض باقية في الرد (لم تُحذف) لكنها لم تُرسل
    expect(JSON.stringify(demand.payload)).not.toMatch(/النرجس|900000/);
    const detail = (await as(reviewer).get(base(id)).expect(200)).body;
    expect(detail.answers.find((a: any) => a.title === 'الحي' && a.hidden)).toMatchObject({
      kind: 'text',
    });
  });

  it('صاحب العرض فقط لا يعدّل ولا يرفع ولا يشارك سبب الرفض', async () => {
    const { id } = await submitOffer();
    await as(viewer).get(base(id)).expect(200);
    await as(viewer)
      .get(`${base(id)}/edit`)
      .expect(403);
    await as(viewer)
      .patch(`${base(id)}/answers`, {
        revision: 0,
        answers: [{ questionId: pq('offer.city').id, value: 'x' }],
      })
      .expect(403);
    await as(viewer)
      .upload(`${base(id)}/files?questionId=${pq('offer.images').id}`, 'x.png', samples.png())
      .expect(403);
    await as(viewer)
      .post(`${base(id)}/rejection-share`)
      .expect(403);
    await as(viewer)
      .patch(`${base(id)}/status`, { status: 'REJECTED', reason: 'سبب' })
      .expect(403);
    expect(await prisma.formResponseEdit.count({ where: { responseId: id } })).toBe(0);
  });

  it('تعديلان متزامنان بالمراجعة نفسها ⇒ يُحفظ واحد والآخر 409 مع القيم الحالية', async () => {
    const { id } = await submitOffer();
    const send = (city: string) =>
      as(reviewer).patch(`${base(id)}/answers`, {
        revision: 0,
        answers: [{ questionId: pq('offer.city').id, value: city }],
      });
    const results = await Promise.all([send('مكة'), send('المدينة المنورة')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const conflict = results.find((r) => r.status === 409)!;
    expect(conflict.body.code).toBe('RESPONSE_EDIT_CONFLICT');
    expect(conflict.body.details.current.revision).toBe(1);
    expect(await prisma.formResponseEdit.count({ where: { responseId: id } })).toBe(1);
  });

  it('الرفض: بلا سبب ⇒ 400، وبسبب ⇒ يُحفظ مع المستخدم والوقت والحالتين، ولا يُرسل ولا يُشارك', async () => {
    const { id } = await submitOffer();
    const noReason = await as(reviewer)
      .patch(`${base(id)}/status`, { status: 'REJECTED' })
      .expect(400);
    expect(noReason.body.fields[0].field).toBe('reason');
    await as(reviewer)
      .patch(`${base(id)}/status`, { status: 'REJECTED', reason: '  ' })
      .expect(400);
    expect((await prisma.formResponse.findUniqueOrThrow({ where: { id } })).status).toBe('NEW');

    const reason = 'الصور غير واضحة & السعر غير مطابق؟';
    const res = await as(reviewer)
      .patch(`${base(id)}/status`, { status: 'REJECTED', reason })
      .expect(200);
    expect(res.body.response.rejection).toMatchObject({ reason, rejectedBy: 'مراجعة الردود' });
    expect(res.body.response.statusHistory.at(-1)).toMatchObject({
      fromStatus: 'NEW',
      toStatus: 'REJECTED',
      reason,
      changedBy: 'مراجعة الردود',
    });

    // لا اعتماد ولا إرسال، ولا رابط أو مشاركة
    const approve = await as(reviewer)
      .post(`${base(id)}/flowmax/approve`)
      .expect(409);
    expect(approve.body.code).toBe('RESPONSE_REJECTED');
    const state = (
      await as(reviewer)
        .get(`${base(id)}/flowmax`)
        .expect(200)
    ).body;
    expect(state).toMatchObject({ rejected: true, sync: null, precheck: null });
    expect(await prisma.flowmaxSync.count({ where: { responseId: id } })).toBe(0);
    expect(mock.properties.some((p) => p.sourceKey === `lawha:response:${id}`)).toBe(false);

    // مشاركة السبب: رابط wa.me بالرقم المتحقق منه ورسالة مشفرة؛ يُسجَّل الفتح فقط
    const share = (
      await as(reviewer)
        .post(`${base(id)}/rejection-share`)
        .expect(200)
    ).body;
    const url = new URL(share.url);
    expect(url.origin + url.pathname).toBe('https://wa.me/966500000097');
    const text = url.searchParams.get('text')!;
    expect(share.url).toContain(encodeURIComponent('&'));
    expect(share.url).not.toContain(' ');
    expect(text).toContain('السلام عليكم سارة');
    expect(text).toContain(`سبب الرفض: ${reason}`);
    const ref = (await prisma.formResponse.findUniqueOrThrow({ where: { id } })).referenceCode;
    expect(text).toContain(ref);
    expect(text).not.toMatch(/النرجس|900000|Flowmax/);
    const logged = await prisma.auditLog.findMany({
      where: { action: 'response.rejection_share_opened', entityId: id },
    });
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0]!.details)).not.toMatch(/0500000097|966/);
  });

  it('مشاركة سبب الرفض بلا رقم صالح ⇒ رسالة واضحة؛ وغير المرفوض ⇒ 409', async () => {
    const { id } = await submitOffer('12345');
    await as(reviewer)
      .post(`${base(id)}/rejection-share`)
      .expect(409);
    await as(reviewer)
      .patch(`${base(id)}/status`, { status: 'REJECTED', reason: 'رقم الجوال غير صحيح' })
      .expect(200);
    const res = await as(reviewer)
      .post(`${base(id)}/rejection-share`)
      .expect(422);
    expect(res.body).toMatchObject({
      code: 'REJECTION_SHARE_NO_PHONE',
      message: expect.stringContaining('لا يوجد رقم جوال صالح'),
    });
  });

  it('رقم الجوال لا يظهر للعامة: النموذج العام وردّ الإرسال بلا بيانات الردود', async () => {
    const { id } = await submitOffer('0500000091');
    const pub = await request(server()).get(`/api/public/forms/${publicId}`).expect(200);
    expect(JSON.stringify(pub.body)).not.toMatch(/0500000091/);
    await request(server()).get(base(id)).expect(401);
    await request(server())
      .get(`${base(id)}/edit`)
      .expect(401);
  });
});

describe('قائمة كل الردود والحذف الناعم', () => {
  it('قائمة كل الردود تعرض الرد مع عنوان نموذجه لمن يملك عرض الردود', async () => {
    const { id } = await submitOffer('0500000081');
    const res = await as(viewer).get('/api/responses?pageSize=50').expect(200);
    const item = res.body.items.find((r: any) => r.id === id);
    expect(item).toMatchObject({ formId, formTitle: 'مراجعة الردود (اختبار)' });
    expect(JSON.stringify(res.body)).not.toMatch(/0500000081/);
    const one = await as(viewer).get(`/api/responses?formId=${formId}&pageSize=50`).expect(200);
    expect(one.body.items.every((r: any) => r.formId === formId)).toBe(true);
  });

  it('حذف الرد للمدير فقط، يخفيه من القوائم والتفاصيل ويبقي بياناته وملفاته', async () => {
    const { id, images } = await submitOffer('0500000082');
    await as(reviewer).del(base(id)).expect(403);
    await as(admin).del(base(id)).expect(204);

    await as(admin).get(base(id)).expect(404);
    await as(admin)
      .get(`${base(id)}/files/${images[0]}`)
      .expect(404);
    await as(reviewer)
      .patch(`${base(id)}/status`, { status: 'IN_REVIEW' })
      .expect(404);
    const list = await as(admin).get(`/api/forms/${formId}/responses?pageSize=50`).expect(200);
    expect(list.body.items.map((r: any) => r.id)).not.toContain(id);
    const all = await as(admin).get('/api/responses?pageSize=50').expect(200);
    expect(all.body.items.map((r: any) => r.id)).not.toContain(id);
    await as(admin).del(base(id)).expect(404);

    const row = await prisma.formResponse.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).not.toBeNull();
    expect(await prisma.formAnswer.count({ where: { responseId: id } })).toBeGreaterThan(0);
    expect(await prisma.uploadedFile.count({ where: { responseId: id } })).toBe(2);
    const logged = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'response.deleted', entityId: id },
    });
    expect(JSON.stringify(logged.details)).not.toMatch(/0500000082/);
  });

  it('حذف النموذج للمدير فقط، يخفيه وردوده ويوقف رابطه العام دون مسح البيانات', async () => {
    const otherId = (
      await as(admin)
        .post('/api/forms', { title: 'نموذج للحذف (اختبار)', template: 'real-estate-unified' })
        .expect(201)
    ).body.id as string;
    const otherDraft = (await as(admin).get(`/api/forms/${otherId}/draft`).expect(200)).body;
    const otherPublic = (
      await as(admin)
        .post(`/api/forms/${otherId}/publish`, {
          revision: otherDraft.revision,
          publishKey: randomUUID(),
          openResponses: true,
        })
        .expect(200)
    ).body.form.publication.publicId as string;

    await as(reviewer).del(`/api/forms/${otherId}`).expect(403);
    await as(admin).del(`/api/forms/${otherId}`).expect(204);

    await as(admin).get(`/api/forms/${otherId}`).expect(404);
    await as(admin).get(`/api/forms/${otherId}/draft`).expect(404);
    await as(admin).get(`/api/forms/${otherId}/responses`).expect(404);
    await request(server()).get(`/api/public/forms/${otherPublic}`).expect(404);
    const forms = await as(admin).get('/api/forms?pageSize=50').expect(200);
    expect(forms.body.items.map((f: any) => f.id)).not.toContain(otherId);
    await as(admin).del(`/api/forms/${otherId}`).expect(404);

    const row = await prisma.form.findUniqueOrThrow({ where: { id: otherId } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.acceptingResponses).toBe(false);
    expect(await prisma.formVersion.count({ where: { formId: otherId } })).toBe(1);
  });
});
