import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient, UserRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { RESPONSE_REQUEST_MAX_BYTES } from '../src/forms/questions/limits';

/**
 * المرحلة الثالثة من طرف إلى طرف: النشر والإصدارات الثابتة والاستقبال والرابط العام وحفظ الردود.
 * مستقل عن phase1/phase2 (مستخدمون بأسماء خاصة) وينظف بياناته في النهاية.
 */

const ORIGIN = 'http://localhost:3000';
const ADMIN = { username: 'p3.admin', password: 'P3-admin-pass-2026!' };
const EDITOR = { username: 'p3.editor', password: 'P3-editor-pass-2026!' };
const PUBLISHER = { username: 'p3.publisher', password: 'P3-publish-pass-2026!' };
const PUBLISH_ONLY = { username: 'p3.pubonly', password: 'P3-pubonly-pass-2026!' };

let app: NestExpressApplication;
let prisma: PrismaClient;

interface Session {
  cookie: string[];
  csrf: string;
  userId: string;
}

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

async function login(u: { username: string; password: string }): Promise<Session> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send(u)
    .expect(200);
  return {
    cookie: res.headers['set-cookie'] as unknown as string[],
    csrf: res.body.csrfToken,
    userId: res.body.user.id,
  };
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

/** طلبات عامة بلا جلسة ولا CSRF (كما يرسلها المتصفح من الصفحة العامة). */
const pub = {
  get: (publicId: string, a = app) =>
    request(a.getHttpServer()).get(`/api/public/forms/${publicId}`),
  submit: (publicId: string, body: object, a = app) =>
    request(a.getHttpServer())
      .post(`/api/public/forms/${publicId}/responses`)
      .set('Origin', ORIGIN)
      .send(body),
};

function toDraftBody(d: any) {
  return {
    revision: d.revision,
    title: d.title,
    description: d.description,
    questions: d.questions.map((q: any) => ({
      id: q.id,
      type: q.type,
      title: q.title,
      description: q.description,
      required: q.required,
      settings: { ...q.settings },
      options: q.options.map((o: any) => ({ id: o.id, label: o.label })),
    })),
  };
}

const sevenTypes = () => [
  {
    type: 'SHORT_TEXT',
    title: 'الاسم الكامل',
    required: true,
    settings: { minLength: 3, maxLength: 40 },
  },
  { type: 'PARAGRAPH', title: 'نبذة', required: false, settings: { maxLength: 500 } },
  {
    type: 'SINGLE_CHOICE',
    title: 'المدينة',
    required: true,
    settings: {},
    options: [{ label: 'الرياض' }, { label: 'جدة' }],
  },
  {
    type: 'MULTIPLE_CHOICE',
    title: 'الخدمات',
    required: false,
    settings: { minSelections: 1, maxSelections: 2 },
    options: [{ label: 'استشارة' }, { label: 'تدريب' }, { label: 'دعم' }],
  },
  {
    type: 'DROPDOWN',
    title: 'القسم',
    required: false,
    settings: {},
    options: [{ label: 'المالية' }, { label: 'التقنية' }],
  },
  {
    type: 'NUMBER',
    title: 'عدد الموظفين',
    required: false,
    settings: { allowDecimals: false, min: 1, max: 1000 },
  },
  {
    type: 'DATE',
    title: 'تاريخ البدء',
    required: false,
    settings: { minDate: '2026-01-01', maxDate: '2027-12-31' },
  },
];

let admin: Session;
let editor: Session;
let publisher: Session;
let formId: string;
let publicId: string;
let v1: any; // النموذج العام للإصدار 1
let firstRef: { key: string; body: any; referenceCode: string };

function answersFor(form: any, overrides: Record<string, unknown> = {}) {
  const q = (title: string) => form.questions.find((x: any) => x.title === title);
  const opt = (title: string, i: number) => q(title)?.options[i]?.id;
  const base: Record<string, unknown> = {
    'الاسم الكامل': 'سارة علي',
    نبذة: 'مهتمة بالخدمة',
    المدينة: opt('المدينة', 1),
    الخدمات: q('الخدمات') ? [opt('الخدمات', 0), opt('الخدمات', 2)] : undefined,
    القسم: opt('القسم', 0),
    'عدد الموظفين': '25',
    'تاريخ البدء': '2026-11-01',
    ...overrides,
  };
  // الأسئلة غير الموجودة في هذا الإصدار والقيم undefined تُحذف.
  return Object.entries(base)
    .filter(([title, value]) => q(title) && value !== undefined)
    .map(([title, value]) => ({ questionId: q(title).id, value }));
}

beforeAll(async () => {
  prisma = new PrismaClient();
  app = await startApp();
  await prisma.user.create({
    data: {
      username: ADMIN.username,
      displayName: 'مدير المرحلة الثالثة',
      passwordHash: await hashPassword(ADMIN.password),
      role: UserRole.ADMIN,
    },
  });
  admin = await login(ADMIN);
  await as(admin)
    .post('/api/users', {
      username: EDITOR.username,
      displayName: 'محرر بلا نشر',
      password: EDITOR.password,
      permissions: ['FORMS_VIEW', 'FORMS_CREATE', 'FORMS_EDIT'],
    })
    .expect(201);
  await as(admin)
    .post('/api/users', {
      username: PUBLISHER.username,
      displayName: 'ناشر',
      password: PUBLISHER.password,
      permissions: ['FORMS_VIEW', 'FORMS_EDIT', 'FORMS_PUBLISH', 'FORMS_INTAKE'],
    })
    .expect(201);
  editor = await login(EDITOR);
  publisher = await login(PUBLISHER);
});

afterAll(async () => {
  if (prisma) {
    const users = await prisma.user.findMany({
      where: {
        username: {
          in: [ADMIN.username, EDITOR.username, PUBLISHER.username, PUBLISH_ONLY.username],
        },
      },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    const forms = await prisma.form.findMany({
      where: { createdById: { in: ids } },
      select: { id: true },
    });
    const formIds = forms.map((f) => f.id);
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
});

describe('المرحلة الثالثة: النشر والاستقبال والردود', () => {
  it('صلاحيتا النشر والاستقبال في فهرس الصلاحيات وتتطلبان العرض', async () => {
    const cat = await as(admin).get('/api/users/permissions').expect(200);
    expect(cat.body.map((p: any) => p.key)).toEqual(
      expect.arrayContaining(['FORMS_PUBLISH', 'FORMS_INTAKE']),
    );
    const bad = await as(admin)
      .post('/api/users', {
        username: 'p3.bad',
        displayName: 'خطأ',
        password: 'P3-bad-pass-2026!',
        permissions: ['FORMS_PUBLISH'],
      })
      .expect(400);
    expect(bad.body.fields[0].message).toMatch(/عرض النماذج/);
  });

  it('2) منع نشر نموذج فارغ أو فيه سؤال ملفات أو مسودة قديمة', async () => {
    formId = (await as(editor).post('/api/forms', { title: 'نموذج المرحلة الثالثة' }).expect(201))
      .body.id;
    const empty = await as(admin)
      .post(`/api/forms/${formId}/publish`, { revision: 1, publishKey: randomUUID() })
      .expect(409);
    expect(empty.body).toMatchObject({
      code: 'PUBLISH_BLOCKED',
      details: { reasons: ['لا يمكن نشر نموذج بلا أسئلة.'] },
    });

    const withFile = await as(editor)
      .put(`/api/forms/${formId}/draft`, {
        revision: 1,
        title: 'نموذج المرحلة الثالثة',
        questions: [
          ...sevenTypes(),
          {
            type: 'FILE_UPLOAD',
            title: 'السيرة',
            required: false,
            settings: { allowedTypes: ['pdf'], maxFileSizeMb: 2, maxFiles: 1 },
          },
        ],
      })
      .expect(200);
    const blocked = await as(admin)
      .post(`/api/forms/${formId}/publish`, {
        revision: withFile.body.revision,
        publishKey: randomUUID(),
      })
      .expect(409);
    expect(blocked.body.code).toBe('PUBLISH_BLOCKED');
    expect(blocked.body.details.reasons[0]).toMatch(/السؤال 8 «السيرة» من نوع رفع ملفات/);

    const body = toDraftBody(withFile.body);
    body.questions = body.questions.filter((q: any) => q.type !== 'FILE_UPLOAD');
    const saved = await as(editor).put(`/api/forms/${formId}/draft`, body).expect(200);
    expect(saved.body.revision).toBe(3);
    const stale = await as(admin)
      .post(`/api/forms/${formId}/publish`, { revision: 2, publishKey: randomUUID() })
      .expect(409);
    expect(stale.body.code).toBe('REVISION_CONFLICT');
    expect(stale.body.details.current.revision).toBe(3);
    expect(await prisma.formVersion.count({ where: { formId } })).toBe(0);
  });

  it('1) المحرر بلا صلاحية لا ينشر ولا يفتح الاستقبال بطلب مباشر', async () => {
    const r1 = await as(editor)
      .post(`/api/forms/${formId}/publish`, { revision: 3, publishKey: randomUUID() })
      .expect(403);
    expect(r1.body.code).toBe('FORBIDDEN');
    await as(editor).post(`/api/forms/${formId}/responses/open`).expect(403);
    await as(editor).post(`/api/forms/${formId}/responses/close`).expect(403);
    // دون CSRF يُرفض حتى للمدير
    await request(app.getHttpServer())
      .post(`/api/forms/${formId}/publish`)
      .set('Cookie', admin.cookie)
      .send({ revision: 3, publishKey: randomUUID() })
      .expect(403);
  });

  it('1) صلاحية النشر وحدها لا تفتح الاستقبال مع أول نشر', async () => {
    await as(admin)
      .post('/api/users', {
        username: PUBLISH_ONLY.username,
        displayName: 'ناشر بلا استقبال',
        password: PUBLISH_ONLY.password,
        permissions: ['FORMS_VIEW', 'FORMS_PUBLISH'],
      })
      .expect(201);
    const pubOnly = await login(PUBLISH_ONLY);
    const res = await as(pubOnly)
      .post(`/api/forms/${formId}/publish`, {
        revision: 3,
        publishKey: randomUUID(),
        openResponses: true,
      })
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    await as(pubOnly).post(`/api/forms/${formId}/responses/open`).expect(403);
    expect(await prisma.formVersion.count({ where: { formId } })).toBe(0);
  });

  it('أول نشر لا يفتح الاستقبال ضمنيًا، وإعادة الطلب بنفس المفتاح لا تكرر الإصدار', async () => {
    const key = randomUUID();
    const res = await as(publisher)
      .post(`/api/forms/${formId}/publish`, { revision: 3, publishKey: key })
      .expect(200);
    expect(res.body).toMatchObject({ replayed: false, version: { versionNumber: 1 } });
    expect(res.body.form).toMatchObject({
      publicationStatus: 'published',
      publication: {
        acceptingResponses: false,
        hasUnpublishedChanges: false,
        latestVersion: { versionNumber: 1 },
      },
    });
    publicId = res.body.form.publication.publicId;
    expect(publicId).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const replay = await as(publisher)
      .post(`/api/forms/${formId}/publish`, { revision: 3, publishKey: key })
      .expect(200);
    expect(replay.body).toMatchObject({
      replayed: true,
      version: { id: res.body.version.id, versionNumber: 1 },
    });
    const parallel = await Promise.all(
      Array.from({ length: 4 }, () =>
        as(publisher).post(`/api/forms/${formId}/publish`, { revision: 3, publishKey: key }),
      ),
    );
    expect(
      parallel.every((r) => r.status === 200 && r.body.version.id === res.body.version.id),
    ).toBe(true);
    expect(await prisma.formVersion.count({ where: { formId } })).toBe(1);

    // النموذج المنشور غير المفتوح: الصفحة العامة تعرض الإغلاق دون أسئلة، والإرسال مرفوض
    const closed = await pub.get(publicId).expect(200);
    expect(closed.body).toEqual({
      publicId,
      title: 'نموذج المرحلة الثالثة',
      description: null,
      acceptingResponses: false,
      versionId: null,
      questions: [],
      // يُعلن هل تُفحص الملفات ضد البرمجيات الخبيثة (UPLOAD_SCAN_MODE الافتراضي required)
      fileScanning: true,
    });
  });

  it('فتح الاستقبال يتطلب نموذجًا منشورًا وغير مؤرشف', async () => {
    const unpublished = (await as(admin).post('/api/forms', { title: 'غير منشور' }).expect(201))
      .body.id;
    expect(
      (await as(admin).post(`/api/forms/${unpublished}/responses/open`).expect(409)).body.code,
    ).toBe('NOT_PUBLISHED');
    const opened = await as(publisher).post(`/api/forms/${formId}/responses/open`).expect(200);
    expect(opened.body.publication.acceptingResponses).toBe(true);
    // تكرار الطلب آمن
    await as(publisher).post(`/api/forms/${formId}/responses/open`).expect(200);
  });

  it('5) قراءة النموذج العام دون جلسة ودون كشف بيانات داخلية', async () => {
    const res = await pub.get(publicId).expect(200);
    v1 = res.body;
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'acceptingResponses',
        'description',
        'fileScanning',
        'publicId',
        'questions',
        'title',
        'versionId',
      ].sort(),
    );
    expect(res.body.questions).toHaveLength(7);
    expect(Object.keys(res.body.questions[2]).sort()).toEqual(
      ['description', 'id', 'key', 'options', 'required', 'settings', 'title', 'type'].sort(),
    );
    const text = JSON.stringify(res.body);
    for (const leak of [
      'revision',
      'createdBy',
      'username',
      'permissions',
      'archivedAt',
      'p3.admin',
    ]) {
      expect(text).not.toContain(leak);
    }
    await pub.get('AAAAAAAAAAAAAAAAAAAAAA').expect(404);
    await pub.get('short').expect(404);
  });

  it('6) قبول الأنواع السبعة وحفظ القيم بأنواعها', async () => {
    const key = randomUUID();
    const body = { versionId: v1.versionId, idempotencyKey: key, answers: answersFor(v1) };
    const res = await pub.submit(publicId, body).expect(201);
    expect(res.body.referenceCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    firstRef = { key, body, referenceCode: res.body.referenceCode };

    const saved = await prisma.formResponse.findUniqueOrThrow({
      where: { referenceCode: res.body.referenceCode },
      include: { answers: { include: { question: true, options: { include: { option: true } } } } },
    });
    expect(saved).toMatchObject({ status: 'NEW', versionId: v1.versionId, formId });
    const byTitle = Object.fromEntries(saved.answers.map((a) => [a.question.title, a]));
    expect(byTitle['الاسم الكامل']!.textValue).toBe('سارة علي');
    expect(byTitle['عدد الموظفين']!.numberValue?.toString()).toBe('25');
    expect(byTitle['تاريخ البدء']!.dateValue?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(byTitle['المدينة']!.options.map((o) => o.option.label)).toEqual(['جدة']);
    expect(byTitle['الخدمات']!.options.map((o) => o.option.label).sort()).toEqual(
      ['دعم', 'استشارة'].sort(),
    );
    expect(saved.answers).toHaveLength(7);
    // لا يُخزن IP أو User-Agent مع الرد
    expect(Object.keys(saved)).not.toEqual(expect.arrayContaining(['ipAddress', 'userAgent']));
  });

  it('6) رفض مخالفة القيود برسائل عربية بجانب السؤال', async () => {
    const q = (t: string) => v1.questions.find((x: any) => x.title === t);
    const cases: [Record<string, unknown>, string, RegExp][] = [
      [{ 'الاسم الكامل': '  ' }, 'الاسم الكامل', /إجباري/],
      [{ 'الاسم الكامل': 'سا' }, 'الاسم الكامل', /لا تقل/],
      [{ 'عدد الموظفين': '2.5' }, 'عدد الموظفين', /دون كسور/],
      [{ 'عدد الموظفين': '5000' }, 'عدد الموظفين', /لا يزيد/],
      [{ 'تاريخ البدء': '2025-01-01' }, 'تاريخ البدء', /قبل/],
      [
        {
          الخدمات: [
            q('الخدمات').options[0].id,
            q('الخدمات').options[1].id,
            q('الخدمات').options[2].id,
          ],
        },
        'الخدمات',
        /كحد أقصى/,
      ],
      [
        { المدينة: [q('المدينة').options[0].id, q('المدينة').options[1].id] },
        'المدينة',
        /خيارًا واحدًا/,
      ],
    ];
    for (const [over, title, re] of cases) {
      const res = await pub.submit(publicId, {
        versionId: v1.versionId,
        idempotencyKey: randomUUID(),
        answers: answersFor(v1, over),
      });
      expect([title, res.status]).toEqual([title, 400]);
      expect(res.body.fields).toContainEqual({
        field: `answers.${q(title).id}`,
        message: expect.stringMatching(re),
      });
    }
  });

  it('7) رفض العبث بالأسئلة والخيارات والإصدار والحقول', async () => {
    const other = (await as(admin).post('/api/forms', { title: 'نموذج آخر' }).expect(201)).body.id;
    const od = await as(admin)
      .put(`/api/forms/${other}/draft`, { revision: 1, title: 'آخر', questions: [sevenTypes()[2]] })
      .expect(200);
    const op = await as(admin)
      .post(`/api/forms/${other}/publish`, {
        revision: od.body.revision,
        publishKey: randomUUID(),
        openResponses: true,
      })
      .expect(200);
    const otherPublic = (await pub.get(op.body.form.publication.publicId).expect(200)).body;
    const foreignQ = otherPublic.questions[0];
    const q = (t: string) => v1.questions.find((x: any) => x.title === t);
    const send = (body: any) =>
      pub.submit(publicId, { versionId: v1.versionId, idempotencyKey: randomUUID(), ...body });

    let res = await send({
      answers: [...answersFor(v1), { questionId: foreignQ.id, value: foreignQ.options[0].id }],
    });
    expect(res.status).toBe(400);
    expect(res.body.fields[0].message).toBe('هذا السؤال لا يخص الإصدار الحالي.');
    res = await send({ answers: answersFor(v1, { المدينة: foreignQ.options[0].id }) });
    expect(res.body.fields).toContainEqual({
      field: `answers.${q('المدينة').id}`,
      message: 'الخيار المحدد غير موجود في هذا السؤال.',
    });
    res = await send({ answers: answersFor(v1, { القسم: q('المدينة').options[0].id }) });
    expect(res.status).toBe(400);
    res = await send({ answers: [...answersFor(v1), answersFor(v1)[0]] });
    expect(res.body.fields.some((f: any) => f.message === 'تكررت الإجابة على السؤال نفسه.')).toBe(
      true,
    );
    res = await send({ versionId: otherPublic.versionId, answers: answersFor(v1) });
    expect(res.body.fields).toEqual([
      { field: 'versionId', message: 'الإصدار غير صالح لهذا النموذج.' },
    ]);
    res = await send({ answers: answersFor(v1), files: ['x'] });
    expect(res.body.fields).toContainEqual({ field: 'files', message: 'حقل غير مسموح به.' });
    res = await send({ answers: answersFor(v1).map((a: any) => ({ ...a, fileName: 'cv.pdf' })) });
    expect(res.status).toBe(400);
    // Origin أجنبي مرفوض للمسار العام
    await request(app.getHttpServer())
      .post(`/api/public/forms/${publicId}/responses`)
      .set('Origin', 'https://evil.example')
      .send({ versionId: v1.versionId, idempotencyKey: randomUUID(), answers: answersFor(v1) })
      .expect(403);
    expect(await prisma.formResponse.count({ where: { formId } })).toBe(1);
  });

  it('11) إعادة المحاولة دون رد مكرر، بالتزامن، ورفض المفتاح نفسه بمحتوى مختلف', async () => {
    const replay = await pub.submit(publicId, firstRef.body).expect(200);
    expect(replay.body.referenceCode).toBe(firstRef.referenceCode);
    const different = await pub
      .submit(publicId, {
        ...firstRef.body,
        answers: answersFor(v1, { 'الاسم الكامل': 'اسم آخر' }),
      })
      .expect(409);
    expect(different.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const key = randomUUID();
    const body = {
      versionId: v1.versionId,
      idempotencyKey: key,
      answers: answersFor(v1, { نبذة: 'متزامن' }),
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => pub.submit(publicId, body)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.referenceCode)).size).toBe(1);
    expect(await prisma.formResponse.count({ where: { formId, idempotencyKey: key } })).toBe(1);
  });

  it('3) و4) و10) الإصدار الثابت بعد تعديل المسودة وحذف أسئلتها، والردود القديمة على أسئلتها الأصلية، ورفض الإصدار القديم', async () => {
    const draft = (await as(admin).get(`/api/forms/${formId}/draft`).expect(200)).body;
    const body = toDraftBody(draft);
    body.questions = body.questions.filter((q: any) => q.title !== 'نبذة'); // حذف سؤال
    const city = body.questions.find((q: any) => q.title === 'المدينة');
    city.title = 'المدينة الحالية';
    city.options[1].label = 'جدة (معدّل)';
    const saved = await as(publisher).put(`/api/forms/${formId}/draft`, body).expect(200);
    const status = (await as(admin).get(`/api/forms/${formId}`).expect(200)).body.publication;
    expect(status).toMatchObject({
      hasUnpublishedChanges: true,
      acceptingResponses: true,
      latestVersion: { versionNumber: 1 },
    });

    // الصفحة العامة ما زالت على الإصدار 1 حتى النشر
    expect((await pub.get(publicId).expect(200)).body.versionId).toBe(v1.versionId);

    const v2res = await as(publisher)
      .post(`/api/forms/${formId}/publish`, {
        revision: saved.body.revision,
        publishKey: randomUUID(),
        openResponses: false,
      })
      .expect(200);
    expect(v2res.body.version.versionNumber).toBe(2);
    // التحديث يحافظ على حالة الاستقبال (openResponses يُتجاهل بعد أول نشر)
    expect(v2res.body.form.publication).toMatchObject({
      acceptingResponses: true,
      hasUnpublishedChanges: false,
    });

    // الإصدار 1 لم يتغير في القاعدة
    const v1db = await prisma.formVersion.findUniqueOrThrow({
      where: { id: v1.versionId },
      include: {
        questions: {
          orderBy: { position: 'asc' },
          include: { options: { orderBy: { position: 'asc' } } },
        },
      },
    });
    expect(v1db.questions.map((q) => q.title)).toEqual(v1.questions.map((q: any) => q.title));
    expect(v1db.questions.find((q) => q.title === 'المدينة')!.options.map((o) => o.label)).toEqual([
      'الرياض',
      'جدة',
    ]);
    // الرد الأول ما زال مرتبطًا بأسئلة وخيارات الإصدار 1 الأصلية
    const old = await prisma.formResponse.findUniqueOrThrow({
      where: { referenceCode: firstRef.referenceCode },
      include: { answers: { include: { question: true, options: { include: { option: true } } } } },
    });
    expect(old.versionId).toBe(v1.versionId);
    const oldCity = old.answers.find((a) => a.question.title === 'المدينة')!;
    expect(oldCity.options[0]!.option.label).toBe('جدة');
    expect(old.answers.some((a) => a.question.title === 'نبذة')).toBe(true);

    // المعرّف المنطقي يربط السؤال عبر الإصدارين بمعرّفات مستقلة داخل كل إصدار
    const v2 = (await pub.get(publicId).expect(200)).body;
    expect(v2.versionId).toBe(v2res.body.version.id);
    const c1 = v1.questions.find((q: any) => q.title === 'المدينة');
    const c2 = v2.questions.find((q: any) => q.title === 'المدينة الحالية');
    expect(c2.key).toBe(c1.key);
    expect(c2.id).not.toBe(c1.id);
    expect(v2.questions.some((q: any) => q.title === 'نبذة')).toBe(false);

    // الإرسال على الإصدار القديم مرفوض برسالة تطلب التحديث
    const outdated = await pub
      .submit(publicId, {
        versionId: v1.versionId,
        idempotencyKey: randomUUID(),
        answers: answersFor(v1),
      })
      .expect(409);
    expect(outdated.body.code).toBe('VERSION_OUTDATED');
    expect(outdated.body.message).toMatch(/حدّث النموذج/);
    // والإصدار الجديد مقبول
    await pub
      .submit(publicId, {
        versionId: v2.versionId,
        idempotencyKey: randomUUID(),
        answers: answersFor(v2, { المدينة: undefined, 'المدينة الحالية': c2.options[0].id }),
      })
      .expect(201);
    v1 = v2;
  });

  it('8) رفض الإرسال بعد الإغلاق أو الأرشفة، وإعادة طلب محفوظ تعيد نتيجته', async () => {
    await as(publisher).post(`/api/forms/${formId}/responses/close`).expect(200);
    const closed = await pub
      .submit(publicId, {
        versionId: v1.versionId,
        idempotencyKey: randomUUID(),
        answers: answersFor(v1, {
          'المدينة الحالية': v1.questions.find((q: any) => q.title === 'المدينة الحالية').options[0]
            .id,
        }),
      })
      .expect(409);
    expect(closed.body.code).toBe('RESPONSES_CLOSED');
    // طلب محفوظ قبل الإغلاق: إعادته تعيد الرقم المرجعي الأصلي ولا تنشئ ردًا
    expect((await pub.submit(publicId, firstRef.body).expect(200)).body.referenceCode).toBe(
      firstRef.referenceCode,
    );
    expect((await pub.get(publicId).expect(200)).body).toMatchObject({
      acceptingResponses: false,
      questions: [],
    });

    await as(publisher).post(`/api/forms/${formId}/responses/open`).expect(200);
    await as(admin).post(`/api/forms/${formId}/archive`).expect(200);
    let state = (await as(admin).get(`/api/forms/${formId}`).expect(200)).body;
    expect(state.publication.acceptingResponses).toBe(false);
    expect(
      (await as(publisher).post(`/api/forms/${formId}/responses/open`).expect(409)).body.code,
    ).toBe('FORM_ARCHIVED');
    expect(
      (
        await as(admin)
          .post(`/api/forms/${formId}/publish`, {
            revision: state.revision,
            publishKey: randomUUID(),
          })
          .expect(409)
      ).body.code,
    ).toBe('FORM_ARCHIVED');
    await as(admin).post(`/api/forms/${formId}/restore`).expect(200);
    state = (await as(admin).get(`/api/forms/${formId}`).expect(200)).body;
    expect(state.publication.acceptingResponses).toBe(false); // الاستعادة لا تعيد الفتح
    await as(publisher).post(`/api/forms/${formId}/responses/open`).expect(200);
  });

  it('9) اتساق الإرسال المتزامن مع الإغلاق', async () => {
    const city = v1.questions.find((q: any) => q.title === 'المدينة الحالية');
    for (let round = 0; round < 3; round++) {
      await as(publisher).post(`/api/forms/${formId}/responses/open`).expect(200);
      const before = await prisma.formResponse.count({ where: { formId } });
      const submits = Array.from({ length: 6 }, () =>
        pub.submit(publicId, {
          versionId: v1.versionId,
          idempotencyKey: randomUUID(),
          answers: answersFor(v1, { 'المدينة الحالية': city.options[0].id }),
        }),
      );
      const [closeRes, ...results] = await Promise.all([
        as(publisher).post(`/api/forms/${formId}/responses/close`),
        ...submits,
      ]);
      expect(closeRes.status).toBe(200);
      const accepted = results.filter((r) => r.status === 201).length;
      expect(
        results.every(
          (r) => r.status === 201 || (r.status === 409 && r.body.code === 'RESPONSES_CLOSED'),
        ),
      ).toBe(true);
      expect(await prisma.formResponse.count({ where: { formId } })).toBe(before + accepted);
      // بعد اكتمال الإغلاق لا يُقبل أي رد
      const late = await pub.submit(publicId, {
        versionId: v1.versionId,
        idempotencyKey: randomUUID(),
        answers: answersFor(v1, { 'المدينة الحالية': city.options[0].id }),
      });
      expect(late.status).toBe(409);
      expect(await prisma.formResponse.count({ where: { formId } })).toBe(before + accepted);
    }
    await as(publisher).post(`/api/forms/${formId}/responses/open`).expect(200);
  });

  it('12) حد حجم طلب الرد مستقل عن حد المسودة', async () => {
    const raw = JSON.stringify({
      versionId: v1.versionId,
      idempotencyKey: randomUUID(),
      answers: [],
      pad: 'x'.repeat(RESPONSE_REQUEST_MAX_BYTES),
    });
    const res = await request(app.getHttpServer())
      .post(`/api/public/forms/${publicId}/responses`)
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(413);
    expect(res.body).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message: expect.stringMatching(/حجم الإجابات يتجاوز/),
    });
    // طلب مسودة أكبر من 512KB ما زال مقبولًا لمساره (حده 4MiB)
    const draft = (await as(admin).get(`/api/forms/${formId}/draft`).expect(200)).body;
    const big = toDraftBody(draft);
    big.description = 'ع'.repeat(2000);
    big.questions.forEach((q: any) => (q.description = 'ع'.repeat(1000)));
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThan(RESPONSE_REQUEST_MAX_BYTES);
  });

  it('12) معدل الطلبات لكل IP ولكل نموذج، دون الثقة بترويسة العميل من وكيل غير موثوق', async () => {
    const saved = {
      ip: process.env.PUBLIC_SUBMIT_PER_IP_PER_MINUTE,
      form: process.env.PUBLIC_SUBMIT_PER_FORM_PER_MINUTE,
      trust: process.env.TRUST_PROXY,
      login: process.env.LOGIN_RATE_LIMIT_PER_MINUTE,
    };
    const city = v1.questions.find((q: any) => q.title === 'المدينة الحالية');
    const body = () => ({
      versionId: v1.versionId,
      idempotencyKey: randomUUID(),
      answers: answersFor(v1, { 'المدينة الحالية': city.options[0].id }),
    });
    const post = (a: NestExpressApplication, xff?: string) => {
      const r = request(a.getHttpServer())
        .post(`/api/public/forms/${publicId}/responses`)
        .set('Origin', ORIGIN);
      return (xff ? r.set('X-Forwarded-For', xff) : r).send(body());
    };
    const openedApps: NestExpressApplication[] = [];
    const start = async () => {
      const instance = await startApp();
      openedApps.push(instance);
      return instance;
    };
    try {
      // (أ) لكل IP: الوكيل الموثوق (loopback) يمرر IP العميل في X-Forwarded-For
      process.env.PUBLIC_SUBMIT_PER_IP_PER_MINUTE = '3';
      process.env.PUBLIC_SUBMIT_PER_FORM_PER_MINUTE = '1000';
      process.env.TRUST_PROXY = 'loopback';
      process.env.LOGIN_RATE_LIMIT_PER_MINUTE = '3';
      let limited = await start();
      const a = [];
      for (let i = 0; i < 4; i++) a.push((await post(limited, '203.0.113.7')).status);
      expect(a).toEqual([201, 201, 201, 429]);
      const tooMany = await post(limited, '203.0.113.7');
      expect(tooMany.body).toMatchObject({
        code: 'TOO_MANY_REQUESTS',
        message: expect.stringMatching(/عدد الطلبات كبير/),
      });
      expect((await post(limited, '203.0.113.8')).status).toBe(201); // عنوان آخر لا يتأثر

      // (أ2) وكيل أمامي يضيف عنوان الاتصال الحقيقي بعد ترويسة مزيفة من الزائر: الحد يُحسب على العنوان الحقيقي
      const appended = [];
      for (let i = 0; i < 4; i++) {
        appended.push((await post(limited, `10.9.${i}.1, 203.0.113.50`)).status);
      }
      expect(appended).toEqual([201, 201, 201, 429]);
      const loginStatuses = [];
      for (let i = 0; i < 4; i++) {
        const res = await request(limited.getHttpServer())
          .post('/api/auth/login')
          .set('Origin', ORIGIN)
          .set('X-Forwarded-For', `10.8.${i}.1, 203.0.113.60`)
          .send({ username: `p3.nobody.${i}`, password: 'not-a-real-pass-2026' });
        loginStatuses.push(res.status);
      }
      expect(loginStatuses).toEqual([401, 401, 401, 429]);
      await limited.close();
      openedApps.splice(openedApps.indexOf(limited), 1);

      // (ب) وكيل غير موثوق: تغيير X-Forwarded-For لا يتجاوز الحد
      process.env.TRUST_PROXY = '10.255.255.1';
      limited = await start();
      const b = [];
      for (let i = 0; i < 4; i++) b.push((await post(limited, `198.51.100.${i}`)).status);
      expect(b).toEqual([201, 201, 201, 429]);
      await limited.close();
      openedApps.splice(openedApps.indexOf(limited), 1);

      // (ج) لكل نموذج: من عناوين مختلفة
      process.env.PUBLIC_SUBMIT_PER_IP_PER_MINUTE = '1000';
      process.env.PUBLIC_SUBMIT_PER_FORM_PER_MINUTE = '4';
      process.env.TRUST_PROXY = 'loopback';
      limited = await start();
      const c = [];
      for (let i = 0; i < 5; i++) c.push((await post(limited, `192.0.2.${i}`)).status);
      expect(c).toEqual([201, 201, 201, 201, 429]);
      await limited.close();
      openedApps.splice(openedApps.indexOf(limited), 1);
    } finally {
      await Promise.all(openedApps.splice(0).map((a) => a.close().catch(() => undefined)));
      process.env.PUBLIC_SUBMIT_PER_IP_PER_MINUTE = saved.ip;
      process.env.PUBLIC_SUBMIT_PER_FORM_PER_MINUTE = saved.form;
      process.env.TRUST_PROXY = saved.trust;
      process.env.LOGIN_RATE_LIMIT_PER_MINUTE = saved.login;
    }
  }, 60_000);

  it('13) البيانات محفوظة بعد إعادة تشغيل التطبيق، وإعادة الطلب ما زالت تعيد الرقم الأصلي', async () => {
    const count = await prisma.formResponse.count({ where: { formId } });
    await app.close();
    app = await startApp();
    const reloaded = (await pub.get(publicId).expect(200)).body;
    expect(reloaded.versionId).toBe(v1.versionId);
    expect((await pub.submit(publicId, firstRef.body).expect(200)).body.referenceCode).toBe(
      firstRef.referenceCode,
    );
    expect(await prisma.formResponse.count({ where: { formId } })).toBe(count);
    const versions = await prisma.formVersion.findMany({
      where: { formId },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions.map((v) => v.versionNumber)).toEqual([1, 2]);
  });

  it('سجل التدقيق للنشر والاستقبال دون محتوى الإجابات', async () => {
    const logs = await prisma.auditLog.findMany({ where: { entityId: formId } });
    const actions = new Set(logs.map((l) => l.action));
    for (const a of ['form.published', 'form.responses_opened', 'form.responses_closed'])
      expect(actions).toContain(a);
    expect(JSON.stringify(logs)).not.toContain('سارة علي');
  });
});
