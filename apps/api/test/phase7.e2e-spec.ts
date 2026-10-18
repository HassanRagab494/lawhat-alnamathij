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
 * النموذج العقاري الموحّد والأسئلة الشرطية: الإنشاء من القالب، الحفظ والنشر بالشروط والهويات الدلالية،
 * فرض الظهور في الخادم، الإصدارات القديمة، والتوجيه إلى مساري العرض والطلب في Flowmax.
 * Flowmax هنا خادم وهمي محلي فقط؛ التكامل الفعلي في flowmax-real.e2e-spec.ts.
 */

const ORIGIN = 'http://localhost:3000';
const ADMIN = { username: 'p7.admin', password: 'P7-admin-pass-2026!' };
const REVIEWER = { username: 'p7.reviewer', password: 'P7-review-pass-2026!' };

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
    put: (url: string, body: object) => auth(request(server()).put(url)).send(body),
  };
}

let admin: Session;
let reviewer: Session;
let formId: string;
let publicId: string;
let draft: any;
let form: any;

/** يحوّل مسودة الخادم (شروط بالمعرّفات) إلى جسم حفظ (شروط بالمواقع)، كما يفعل المحرر. */
function toSaveBody(d: any, edit: (qs: any[]) => any[] = (qs) => qs) {
  const index = new Map(d.questions.map((q: any, i: number) => [q.id, i]));
  const questions = d.questions.map((q: any) => {
    let showIf = null;
    if (q.showIf) {
      const qi = index.get(q.showIf.questionId) as number;
      showIf = {
        questionIndex: qi,
        optionIndexes: q.showIf.optionIds.map((id: string) =>
          d.questions[qi].options.findIndex((o: any) => o.id === id),
        ),
      };
    }
    return {
      id: q.id,
      type: q.type,
      title: q.title,
      description: q.description,
      required: q.required,
      settings: q.settings,
      showIf,
      semanticKey: q.semanticKey,
      options: q.options.map((o: any) => ({
        id: o.id,
        label: o.label,
        semanticKey: o.semanticKey,
      })),
    };
  });
  return {
    revision: d.revision,
    title: d.title,
    description: d.description,
    questions: edit(questions),
  };
}

/** سؤال الإصدار المنشور بالهوية الدلالية (المفتاح المنطقي = معرّف سؤال المسودة). */
function pq(semantic: string) {
  const dq = draft.questions.find((q: any) => q.semanticKey === semantic);
  return form.questions.find((q: any) => q.key === dq.id);
}
function po(semantic: string, option: string): string {
  const dq = draft.questions.find((q: any) => q.semanticKey === semantic);
  const key = dq.options.find((o: any) => o.semanticKey === option).id;
  return pq(semantic).options.find((o: any) => o.key === key).id;
}

async function fillSession(): Promise<string> {
  return (
    await request(server())
      .post(`/api/public/forms/${publicId}/upload-sessions`)
      .set('Origin', ORIGIN)
      .send({})
      .expect(201)
  ).body.token;
}
const upload = (token: string, semantic: string, name: string, data: Buffer) =>
  request(server())
    .post(`/api/public/forms/${publicId}/files?questionId=${pq(semantic).id}`)
    .set('Origin', ORIGIN)
    .set('Content-Type', 'application/octet-stream')
    .set('x-file-name', encodeURIComponent(name))
    .set('x-fill-session', token)
    .send(data);

function submit(answers: { questionId: string; value: string | string[] }[], token?: string) {
  return request(server())
    .post(`/api/public/forms/${publicId}/responses`)
    .set('Origin', ORIGIN)
    .send({
      versionId: form.versionId,
      idempotencyKey: randomUUID(),
      ...(token ? { fillSession: token } : {}),
      answers,
    });
}

const requestAnswers = () => [
  { questionId: pq('listing.kind').id, value: po('listing.kind', 'request') },
  { questionId: pq('request.category').id, value: po('request.category', 'apartment') },
  { questionId: pq('request.purpose').id, value: po('request.purpose', 'rent') },
  { questionId: pq('request.city').id, value: 'جدة' },
  { questionId: pq('request.budget_max').id, value: '60000' },
  { questionId: pq('request.rent_duration').id, value: '12 شهر' },
  { questionId: pq('request.bedrooms_min').id, value: '3' },
  { questionId: pq('request.consent').id, value: po('request.consent', 'yes') },
  { questionId: pq('contact.phone').id, value: '0500000098' },
];

async function offerAnswers(token: string) {
  const image = (await upload(token, 'offer.images', 'واجهة.png', samples.png()).expect(201)).body
    .id;
  return [
    { questionId: pq('listing.kind').id, value: po('listing.kind', 'offer') },
    { questionId: pq('offer.category').id, value: po('offer.category', 'villa') },
    { questionId: pq('offer.purpose').id, value: po('offer.purpose', 'sale') },
    { questionId: pq('offer.title').id, value: 'فيلا للبيع (اختبار)' },
    { questionId: pq('offer.description').id, value: 'بيانات تجريبية — ليست عقارًا حقيقيًا.' },
    { questionId: pq('offer.city').id, value: 'الرياض' },
    { questionId: pq('offer.district').id, value: 'الملقا' },
    { questionId: pq('offer.price').id, value: '2500000' },
    { questionId: pq('offer.bedrooms').id, value: '5' },
    { questionId: pq('offer.images').id, value: [image] },
    { questionId: pq('contact.name').id, value: 'مالك تجريبي' },
    { questionId: pq('contact.phone').id, value: '0500000097' },
  ];
}

async function responseId(referenceCode: string): Promise<string> {
  return (await prisma.formResponse.findUniqueOrThrow({ where: { referenceCode } })).id;
}
const flowmaxUrl = (id: string, action = '') =>
  `/api/forms/${formId}/responses/${id}/flowmax${action}`;

beforeAll(async () => {
  prisma = new PrismaClient();
  mock = await startMockFlowmax();
  uploadDir = await mkdtemp(join(tmpdir(), 'lawha-p7-'));
  Object.assign(process.env, {
    UPLOAD_SCAN_MODE: 'disabled',
    UPLOAD_DIR: uploadDir,
    PUBLIC_UPLOAD_PER_IP_PER_MINUTE: '100000',
    PUBLIC_UPLOAD_PER_FORM_PER_MINUTE: '100000',
    PUBLIC_SUBMIT_PER_IP_PER_MINUTE: '100000',
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
      displayName: 'مدير المرحلة السابعة',
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
}, 120_000);

afterAll(async () => {
  await app?.get(FlowmaxService).whenIdle();
  if (prisma) {
    const users = await prisma.user.findMany({
      where: { username: { in: [ADMIN.username, REVIEWER.username] } },
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
  await mock?.close();
  if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe('النموذج العقاري الموحّد والأسئلة الشرطية', () => {
  it('ينشئ النموذج من القالب بأسئلة وشروط وهويات دلالية، والنموذج العادي يبقى فارغًا', async () => {
    const res = await as(admin)
      .post('/api/forms', { title: 'تسجيل عقار (اختبار)', template: 'real-estate-unified' })
      .expect(201);
    formId = res.body.id;
    draft = (await as(admin).get(`/api/forms/${formId}/draft`).expect(200)).body;
    expect(draft.revision).toBe(1);
    expect(draft.questions.length).toBeGreaterThan(40);
    const [first, ...rest] = draft.questions;
    expect(first).toMatchObject({
      title: 'وش ترغب تسجّل؟',
      required: true,
      showIf: null,
      semanticKey: 'listing.kind',
    });
    expect(first.options.map((o: any) => [o.label, o.semanticKey])).toEqual([
      ['عرض عقار', 'offer'],
      ['طلب عقار', 'request'],
    ]);
    expect(rest.every((q: any) => q.showIf && q.semanticKey)).toBe(true);
    const bedrooms = draft.questions.find((q: any) => q.semanticKey === 'offer.bedrooms');
    const category = draft.questions.find((q: any) => q.semanticKey === 'offer.category');
    expect(bedrooms.showIf.questionId).toBe(category.id);

    const plain = await as(admin).post('/api/forms', { title: 'نموذج عادي' }).expect(201);
    expect(
      (await as(admin).get(`/api/forms/${plain.body.id}/draft`).expect(200)).body.questions,
    ).toEqual([]);
    const bad = await as(admin)
      .post('/api/forms', { title: 'خطأ', template: 'unknown' })
      .expect(400);
    expect(bad.body.fields).toEqual([{ field: 'template', message: 'القالب غير معروف.' }]);
  });

  it('حفظ المسودة يحافظ على الشروط والهويات، ويرفض المراجع غير الصحيحة', async () => {
    // حفظ بلا تغيير لا يزيد revision
    const same = await as(admin).put(`/api/forms/${formId}/draft`, toSaveBody(draft)).expect(200);
    expect(same.body.revision).toBe(draft.revision);

    // تغيير صياغة سؤال السعر يبقي هويته
    const renamed = await as(admin)
      .put(
        `/api/forms/${formId}/draft`,
        toSaveBody(draft, (qs) =>
          qs.map((q) =>
            q.semanticKey === 'offer.price' ? { ...q, title: 'كم السعر المطلوب؟ (ريال)' } : q,
          ),
        ),
      )
      .expect(200);
    expect(renamed.body.revision).toBe(draft.revision + 1);
    draft = renamed.body;
    const price = draft.questions.find((q: any) => q.semanticKey === 'offer.price');
    expect(price.title).toBe('كم السعر المطلوب؟ (ريال)');
    expect(price.showIf).toEqual({
      questionId: draft.questions[0].id,
      optionIds: [draft.questions[0].options[0].id],
    });

    // شرط على سؤال لاحق (دورة) أو على سؤال غير اختياري ⇒ 400 دون أي حفظ
    const cyc = await as(admin)
      .put(
        `/api/forms/${formId}/draft`,
        toSaveBody(draft, (qs) =>
          qs.map((q, i) =>
            i === 0 ? { ...q, showIf: { questionIndex: 1, optionIndexes: [0] } } : q,
          ),
        ),
      )
      .expect(400);
    expect(cyc.body.fields).toContainEqual({
      field: 'questions.0.showIf.questionIndex',
      message: 'الشرط يجب أن يعتمد على سؤال سابق لهذا السؤال.',
    });
    const titleIndex = draft.questions.findIndex((q: any) => q.semanticKey === 'offer.title');
    const nonChoice = await as(admin)
      .put(
        `/api/forms/${formId}/draft`,
        toSaveBody(draft, (qs) =>
          qs.map((q, i) =>
            i === titleIndex + 1
              ? { ...q, showIf: { questionIndex: titleIndex, optionIndexes: [0] } }
              : q,
          ),
        ),
      )
      .expect(400);
    expect(nonChoice.body.fields[0].field).toBe(`questions.${titleIndex + 1}.showIf.questionIndex`);
    expect((await as(admin).get(`/api/forms/${formId}/draft`).expect(200)).body.revision).toBe(
      draft.revision,
    );

    const published = await as(admin)
      .post(`/api/forms/${formId}/publish`, {
        revision: draft.revision,
        publishKey: randomUUID(),
        openResponses: true,
      })
      .expect(200);
    publicId = published.body.form.publication.publicId;
    form = (await request(server()).get(`/api/public/forms/${publicId}`).expect(200)).body;
    expect(form.questions[0].showIf).toBeNull();
    expect(pq('offer.price').showIf).toEqual({
      questionKey: draft.questions[0].id,
      optionKeys: [draft.questions[0].options[0].id],
    });
  });

  it('الخادم يفرض الظهور: المخفي ليس إجباريًا، ويرفض إجابات وملفات الفرع المخفي', async () => {
    const ok = await submit(requestAnswers()).expect(201);
    expect(ok.body.referenceCode).toMatch(/^[0-9A-Z]{4}-/);

    const token = await fillSession();
    const image = (await upload(token, 'offer.images', 'صورة.png', samples.png()).expect(201)).body
      .id;
    const tampered = await submit(
      [
        ...requestAnswers(),
        { questionId: pq('offer.title').id, value: 'تلاعب' },
        { questionId: pq('offer.images').id, value: [image] },
      ],
      token,
    ).expect(400);
    const hiddenMsg = 'هذا السؤال غير ظاهر حسب إجاباتك، فلا تُقبل له إجابة.';
    expect(tampered.body.fields).toEqual(
      expect.arrayContaining([
        { field: `answers.${pq('offer.title').id}`, message: hiddenMsg },
        { field: `answers.${pq('offer.images').id}`, message: hiddenMsg },
      ]),
    );
    // الملف لم يُربط برد، فيبقى للتنظيف الآمن الحالي
    expect(
      (await prisma.uploadedFile.findUniqueOrThrow({ where: { id: image } })).responseId,
    ).toBeNull();

    // الفرع الظاهر يبقى إجباريًا
    const missing = await submit([
      { questionId: pq('listing.kind').id, value: po('listing.kind', 'request') },
    ]).expect(400);
    expect(missing.body.fields.map((f: any) => f.field)).toEqual(
      expect.arrayContaining([
        `answers.${pq('request.city').id}`,
        `answers.${pq('contact.phone').id}`,
      ]),
    );
    expect(missing.body.fields.map((f: any) => f.field)).not.toContain(
      `answers.${pq('offer.title').id}`,
    );

    const id = await responseId(ok.body.referenceCode);
    const detail = (await as(reviewer).get(`/api/forms/${formId}/responses/${id}`).expect(200))
      .body;
    const view = (s: string) => detail.answers.find((a: any) => a.questionId === pq(s).id);
    expect(view('offer.title')).toMatchObject({ hidden: true, kind: 'empty' });
    expect(view('request.city')).toMatchObject({ hidden: false, kind: 'text', value: 'جدة' });
  });

  it('الطلب يذهب لمسار الطلبات وينتظر مراجعة Flowmax دون مشاركة، ثم تظهر بعد النشر', async () => {
    const ok = await submit(requestAnswers()).expect(201);
    const id = await responseId(ok.body.referenceCode);
    await as(reviewer).post(flowmaxUrl(id, '/approve')).expect(202);
    await app.get(FlowmaxService).whenIdle();
    const demand = mock.demands.at(-1)!;
    expect(demand.payload).toMatchObject({
      requester_phone: '+966500000098',
      property_category: 'apartment',
      listing_purpose: 'rent',
      city: 'جدة',
      budget_max_halalas: 6_000_000,
      criteria: { rent_duration: '12 شهر', bedrooms_min: 3 },
      consent_version: 'lawha-forms-1',
    });
    expect(mock.requests.some((r) => r.path.endsWith('/offers'))).toBe(false);
    let state = (await as(reviewer).get(flowmaxUrl(id)).expect(200)).body;
    expect(state.sync).toMatchObject({
      status: 'SENT',
      operation: 'REQUEST',
      isPublic: false,
      share: null,
    });

    mock.publishDemand(demand.reference);
    state = (await as(reviewer).post(flowmaxUrl(id, '/refresh')).expect(200)).body;
    expect(state.sync).toMatchObject({ isPublic: true });
    expect(state.sync.share).toMatchObject({
      operation: 'REQUEST',
      title: 'طلب شقة للإيجار في جدة',
    });
    expect(JSON.stringify(state.sync.share)).not.toMatch(/0500000098/);
  });

  it('العرض يذهب لمسار العروض ويُنشر، وإعادة الاعتماد وإعادة المحاولة لا تكرر', async () => {
    const token = await fillSession();
    const ok = await submit(await offerAnswers(token), token).expect(201);
    const id = await responseId(ok.body.referenceCode);

    // تعطل الإنشاء ثم إعادة المحاولة
    mock.failNext.push({ match: /POST .*\/offers$/, mode: 'http500' });
    const approvals = await Promise.all(
      [1, 2].map(() => as(reviewer).post(flowmaxUrl(id, '/approve'))),
    );
    expect(approvals.map((r) => r.status)).toEqual([202, 202]);
    await app.get(FlowmaxService).whenIdle();
    let state = (await as(reviewer).get(flowmaxUrl(id)).expect(200)).body;
    expect(state.sync.status).toBe('FAILED');
    await as(reviewer).post(flowmaxUrl(id, '/retry')).expect(202);
    await app.get(FlowmaxService).whenIdle();
    state = (await as(reviewer).get(flowmaxUrl(id)).expect(200)).body;
    expect(state.sync).toMatchObject({
      status: 'SENT',
      isPublic: true,
      attempts: 2,
      publishState: 'PUBLISHED',
    });

    const created = mock.properties.filter((p) => p.sourceKey === `lawha:response:${id}`);
    expect(created).toHaveLength(1);
    expect(created[0]!.payload).toMatchObject({
      type_letter: 'B',
      listing_kind: 'offer',
      property_category: 'villa',
      listing_purpose: 'sale',
      requested_price: 250_000_000,
      bedrooms_count: 5,
      developer_id: 7,
    });
    expect(created[0]!.images).toBe(1);
    expect(state.sync.share).toMatchObject({ title: 'فيلا للبيع (اختبار)', operation: 'OFFER' });
    expect(await prisma.flowmaxSync.count({ where: { responseId: id } })).toBe(1);
  });

  it('الرد الناقص في نموذج القالب يُمنع اعتماده برسالة عربية تحدد الحقل', async () => {
    const ok = await submit(
      requestAnswers().map((a) =>
        a.questionId === pq('request.consent').id
          ? { ...a, value: po('request.consent', 'no') }
          : a,
      ),
    ).expect(201);
    const id = await responseId(ok.body.referenceCode);
    const state = (await as(reviewer).get(flowmaxUrl(id)).expect(200)).body;
    expect(state.precheck.problems).toEqual([
      {
        field: 'request.consent',
        message: '«الموافقة على إرسال الطلب»: لم يوافق المرسل على إرسال الطلب.',
      },
    ]);
    const res = await as(reviewer).post(flowmaxUrl(id, '/approve')).expect(422);
    expect(res.body.code).toBe('FLOWMAX_INCOMPLETE');
  });

  it('نشر إصدار جديد لا يغيّر الردود القديمة، والرد القديم يُعتمد بإصداره', async () => {
    const old = await submit(requestAnswers()).expect(201);
    const oldId = await responseId(old.body.referenceCode);
    const cityId = draft.questions.find((q: any) => q.semanticKey === 'request.city').id;
    const saved = await as(admin)
      .put(
        `/api/forms/${formId}/draft`,
        toSaveBody(draft, (qs) =>
          qs.map((q) => (q.id === cityId ? { ...q, title: 'في أي مدينة تبحث؟' } : q)),
        ),
      )
      .expect(200);
    draft = saved.body;
    await as(admin)
      .post(`/api/forms/${formId}/publish`, { revision: draft.revision, publishKey: randomUUID() })
      .expect(200);
    form = (await request(server()).get(`/api/public/forms/${publicId}`).expect(200)).body;
    expect(pq('request.city').title).toBe('في أي مدينة تبحث؟');

    const detail = (await as(reviewer).get(`/api/forms/${formId}/responses/${oldId}`).expect(200))
      .body;
    expect(detail.version.versionNumber).toBe(1);
    expect(detail.answers.find((a: any) => a.value === 'جدة').title).toBe('المدينة');
    await as(reviewer).post(flowmaxUrl(oldId, '/approve')).expect(202);
    await app.get(FlowmaxService).whenIdle();
    expect((await as(reviewer).get(flowmaxUrl(oldId)).expect(200)).body.sync.status).toBe('SENT');
    // الإصدار الجديد يقبل الردود بالشروط نفسها
    await submit(requestAnswers()).expect(201);
  });
});
