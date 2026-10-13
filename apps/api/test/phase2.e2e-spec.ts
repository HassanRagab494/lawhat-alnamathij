import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient, UserRole } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { DRAFT_REQUEST_MAX_BYTES, QUESTION_LIMITS } from '../src/forms/questions/limits';

/**
 * المرحلة الثانية من طرف إلى طرف: HTTP → NestJS → Prisma → MySQL.
 * الملف مستقل عن phase1 (ينشئ مديره ومستخدميه بأسماء خاصة) لأن الملفين يعملان على قاعدة الاختبار نفسها.
 */

const ORIGIN = 'http://localhost:3000';
const ADMIN = { username: 'p2.admin', password: 'P2-admin-pass-2026!' };
const VIEWER = { username: 'p2.viewer', password: 'P2-viewer-pass-2026!' };
const EDITOR = { username: 'p2.editor', password: 'P2-editor-pass-2026!' };

let app: NestExpressApplication;
let prisma: PrismaClient;

interface Session {
  cookie: string[];
  csrf: string;
  userId: string;
}

async function login(username: string, password: string): Promise<Session> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send({ username, password })
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
    patch: (url: string, body: object) => auth(request(server).patch(url)).send(body),
    put: (url: string, body: object) => auth(request(server).put(url)).send(body),
  };
}

const allTypes = () => [
  {
    type: 'SHORT_TEXT',
    title: 'الاسم الكامل',
    description: 'كما في الهوية',
    required: true,
    settings: { minLength: 3, maxLength: 80 },
  },
  { type: 'PARAGRAPH', title: 'نبذة', required: false, settings: { maxLength: 2000 } },
  {
    type: 'SINGLE_CHOICE',
    title: 'المدينة',
    required: true,
    settings: {},
    options: [{ label: 'الرياض' }, { label: 'جدة' }, { label: 'الدمام' }],
  },
  {
    type: 'MULTIPLE_CHOICE',
    title: 'الخدمات المطلوبة',
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
    settings: { allowDecimals: false, min: 1, max: 100000 },
  },
  {
    type: 'DATE',
    title: 'تاريخ البدء',
    required: false,
    settings: { minDate: '2026-01-01', maxDate: '2027-12-31' },
  },
  {
    type: 'FILE_UPLOAD',
    title: 'المرفقات',
    required: false,
    settings: { allowedTypes: ['pdf', 'png'], maxFileSizeMb: 10, maxFiles: 3 },
  },
];

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
let editor: Session;
let formId: string;
let otherFormId: string;

beforeAll(async () => {
  prisma = new PrismaClient();
  app = await startApp();
  await prisma.user.create({
    data: {
      username: ADMIN.username,
      displayName: 'مدير المرحلة الثانية',
      passwordHash: await hashPassword(ADMIN.password),
      role: UserRole.ADMIN,
    },
  });
  admin = await login(ADMIN.username, ADMIN.password);
  for (const [u, perms] of [
    [VIEWER, ['FORMS_VIEW']],
    [EDITOR, ['FORMS_VIEW', 'FORMS_EDIT']],
  ] as const) {
    await as(admin)
      .post('/api/users', {
        username: u.username,
        displayName: u.username,
        password: u.password,
        permissions: perms,
      })
      .expect(201);
  }
  viewer = await login(VIEWER.username, VIEWER.password);
  editor = await login(EDITOR.username, EDITOR.password);
  formId = (await as(admin).post('/api/forms', { title: 'نموذج المرحلة الثانية' }).expect(201)).body
    .id;
  otherFormId = (await as(admin).post('/api/forms', { title: 'نموذج آخر' }).expect(201)).body.id;
});

afterAll(async () => {
  // تنظيف بيانات هذا الملف حتى لا يتأثر phase1 (المدير الأول وأرقام الملخص) أيًا كان ترتيب التشغيل.
  if (prisma) {
    const users = await prisma.user.findMany({
      where: { username: { in: [ADMIN.username, VIEWER.username, EDITOR.username] } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    await prisma.form.deleteMany({ where: { createdById: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await app?.close();
  await prisma?.$disconnect();
});

const draftUrl = (id: string) => `/api/forms/${id}/draft`;

describe('المرحلة الثانية: محرر النموذج', () => {
  let saved: any;

  it('مسودة جديدة بلا أسئلة', async () => {
    const res = await as(viewer).get(draftUrl(formId)).expect(200);
    expect(res.body).toMatchObject({ id: formId, revision: 1, questions: [] });
  });

  it('1) حفظ الأنواع الثمانية مع العنوان والوصف ثم إعادة تحميلها', async () => {
    const res = await as(admin)
      .put(draftUrl(formId), {
        revision: 1,
        title: '  نموذج طلب خدمة  ',
        description: 'وصف النموذج',
        questions: allTypes(),
      })
      .expect(200);
    expect(res.body.revision).toBe(2);
    expect(res.body.title).toBe('نموذج طلب خدمة');
    expect(res.body.questions.map((q: any) => q.type)).toEqual([
      'SHORT_TEXT',
      'PARAGRAPH',
      'SINGLE_CHOICE',
      'MULTIPLE_CHOICE',
      'DROPDOWN',
      'NUMBER',
      'DATE',
      'FILE_UPLOAD',
    ]);
    const reloaded = await as(admin).get(draftUrl(formId)).expect(200);
    expect(reloaded.body).toEqual(res.body);
    expect(reloaded.body.questions[0]).toMatchObject({
      title: 'الاسم الكامل',
      description: 'كما في الهوية',
      required: true,
      settings: { minLength: 3, maxLength: 80 },
      options: [],
    });
    expect(reloaded.body.questions[2].options.map((o: any) => o.label)).toEqual([
      'الرياض',
      'جدة',
      'الدمام',
    ]);
    expect(reloaded.body.questions[7].settings).toEqual({
      allowedTypes: ['pdf', 'png'],
      maxFileSizeMb: 10,
      maxFiles: 3,
    });
    expect(reloaded.body.questions.every((q: any) => /^[0-9a-f-]{36}$/.test(q.id))).toBe(true);
    saved = reloaded.body;

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'form.draft_saved', entityId: formId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.details).toMatchObject({
      revision: 2,
      questions: 8,
      added: 8,
      titleChanged: true,
    });
  });

  it('حفظ بلا تغيير لا يزيد revision', async () => {
    const body = { ...toBody(saved), revision: 2 };
    const res = await as(admin).put(draftUrl(formId), body).expect(200);
    expect(res.body.revision).toBe(2);
  });

  it('2) تعديل وحذف وترتيب الأسئلة والخيارات مع بقاء المعرّفات', async () => {
    const body = toBody(saved);
    const [short, paragraph, single, multiple, ...rest] = body.questions;
    // حذف الفقرة، نقل الاختيار الواحد للأعلى، تعديل عنوان الإجابة القصيرة
    short.title = 'الاسم الثلاثي';
    // خيارات الاختيار الواحد: حذف «جدة»، إعادة تسمية «الدمام»، إضافة «مكة»، وعكس الترتيب
    const [riyadh, , dammam] = single.options;
    dammam.label = 'الدمام والخبر';
    single.options = [{ label: 'مكة' }, dammam, riyadh];
    body.questions = [single, short, multiple, ...rest];
    void paragraph;

    const res = await as(editor)
      .put(draftUrl(formId), { ...body, revision: 2 })
      .expect(200);
    expect(res.body.revision).toBe(3);
    const qs = res.body.questions;
    expect(qs.map((q: any) => q.id)).toEqual([
      saved.questions[2].id,
      saved.questions[0].id,
      saved.questions[3].id,
      ...saved.questions.slice(4).map((q: any) => q.id),
    ]);
    expect(qs[1].title).toBe('الاسم الثلاثي');
    expect(qs[0].options.map((o: any) => o.label)).toEqual(['مكة', 'الدمام والخبر', 'الرياض']);
    expect(qs[0].options[1].id).toBe(saved.questions[2].options[2].id);
    expect(qs[0].options[2].id).toBe(saved.questions[2].options[0].id);
    expect(await prisma.formDraftQuestion.count({ where: { id: saved.questions[1].id } })).toBe(0);
    expect(
      await prisma.formDraftQuestionOption.count({
        where: { id: saved.questions[2].options[1].id },
      }),
    ).toBe(0);
    // المحرر (مشرف) لا يغيّر منشئ النموذج
    expect(res.body.createdBy.displayName).toBe('مدير المرحلة الثانية');
    saved = res.body;
  });

  it('3) الحفظ ذري: خطأ في سؤال واحد يمنع حفظ كل الأجزاء', async () => {
    const body = toBody(saved);
    body.title = 'عنوان لن يُحفظ';
    body.questions[0].title = 'تعديل لن يُحفظ';
    body.questions.push({
      type: 'DROPDOWN',
      title: 'ناقص',
      required: false,
      settings: {},
      options: [{ label: 'وحيد' }],
    });
    const res = await as(admin)
      .put(draftUrl(formId), { ...body, revision: 3 })
      .expect(400);
    expect(res.body.fields).toContainEqual({
      field: `questions.${body.questions.length - 1}.options`,
      message: 'أضف 2 خيارات على الأقل.',
    });
    const after = await as(admin).get(draftUrl(formId)).expect(200);
    expect(after.body).toEqual(saved);
  });

  it('4) رفض المدخلات غير الصحيحة والعبث بالمعرّفات', async () => {
    const put = (mut: (b: any) => void) => {
      const b = { ...toBody(saved), revision: 3 };
      mut(b);
      return as(admin).put(draftUrl(formId), b);
    };
    const cases: [string, (b: any) => void, string][] = [
      ['عنوان مسافات', (b) => (b.questions[0].title = '   '), 'questions.0.title'],
      ['نوع غير معروف', (b) => (b.questions[0].type = 'SIGNATURE'), 'questions.0.type'],
      [
        'إعداد لا يخص النوع',
        (b) => (b.questions[1].settings = { allowDecimals: true }),
        'questions.1.settings.allowDecimals',
      ],
      ['حقل غير معروف', (b) => (b.questions[0].hidden = true), 'questions.0.hidden'],
      [
        'خيار مكرر بعد المسافات',
        (b) => (b.questions[0].options[1].label = ' مكة '),
        'questions.0.options.1.label',
      ],
      [
        'حد أدنى > أقصى',
        (b) => (b.questions[1].settings = { minLength: 9, maxLength: 3 }),
        'questions.1.settings.minLength',
      ],
      [
        'حدود اختيار > عدد الخيارات',
        (b) => (b.questions[2].settings = { maxSelections: 9 }),
        'questions.2.settings.maxSelections',
      ],
      [
        'تاريخ غير صالح',
        (b) => (b.questions[5].settings = { minDate: '2026-13-01' }),
        'questions.5.settings.minDate',
      ],
      [
        'رقم خارج الحدود',
        (b) => (b.questions[4].settings = { allowDecimals: true, max: 1e20 }),
        'questions.4.settings.max',
      ],
      ['معرّف مكرر', (b) => (b.questions[1].id = b.questions[0].id), 'questions.1.id'],
    ];
    for (const [name, mut, field] of cases) {
      const res = await put(mut);
      expect([name, res.status]).toEqual([name, 400]);
      expect(res.body.fields.map((f: any) => f.field)).toContain(field);
    }

    // معرّف سؤال من نموذج آخر
    const other = await as(admin)
      .put(draftUrl(otherFormId), {
        revision: 1,
        title: 'نموذج آخر',
        questions: [
          {
            type: 'DROPDOWN',
            title: 'غريب',
            required: false,
            settings: {},
            options: [{ label: 'أ' }, { label: 'ب' }],
          },
        ],
      })
      .expect(200);
    const foreignQ = other.body.questions[0];
    let res = await put((b) => (b.questions[0].id = foreignQ.id));
    expect(res.status).toBe(400);
    expect(res.body.fields).toContainEqual({
      field: 'questions.0.id',
      message: 'هذا السؤال لا يخص النموذج الحالي.',
    });
    // معرّف خيار من نموذج آخر
    res = await put((b) => (b.questions[0].options[0].id = foreignQ.options[0].id));
    expect(res.status).toBe(400);
    expect(res.body.fields[0].field).toBe('questions.0.options.0.id');
    // معرّف خيار من سؤال آخر في النموذج نفسه
    res = await put((b) => {
      b.questions[2].options[0].id = b.questions[0].options[0].id;
    });
    expect(res.status).toBe(400);
    // الحد الأقصى لعدد الأسئلة
    res = await put((b) => {
      b.questions = Array.from({ length: QUESTION_LIMITS.maxQuestions + 1 }, () => ({
        type: 'PARAGRAPH',
        title: 'س',
        required: false,
        settings: {},
      }));
    });
    expect(res.status).toBe(400);

    // لم يتغير شيء في النموذج الأصلي ولا النموذج الآخر
    expect((await as(admin).get(draftUrl(formId))).body).toEqual(saved);
    expect((await as(admin).get(draftUrl(otherFormId))).body.questions[0].id).toBe(foreignQ.id);
  });

  it('5) مشرف العرض فقط يقرأ ولا يحفظ بطلب مباشر', async () => {
    await as(viewer).get(draftUrl(formId)).expect(200);
    const res = await as(viewer)
      .put(draftUrl(formId), { ...toBody(saved), revision: 3 })
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    await as(viewer).patch(`/api/forms/${formId}`, { title: 'x', revision: 3 }).expect(403);
    // دون CSRF يُرفض حتى للمدير
    await request(app.getHttpServer())
      .put(draftUrl(formId))
      .set('Cookie', admin.cookie)
      .send({ ...toBody(saved), revision: 3 })
      .expect(403);
    await request(app.getHttpServer()).get(draftUrl(formId)).expect(401);
  });

  it('6) revision قديم ⇒ 409 مع المسودة الكاملة الحديثة ودون حفظ جزئي', async () => {
    const stale = toBody(saved);
    stale.title = 'تعديل على نسخة قديمة';
    const res = await as(admin)
      .put(draftUrl(formId), { ...stale, revision: 2 })
      .expect(409);
    expect(res.body.code).toBe('REVISION_CONFLICT');
    expect(res.body.details.current).toEqual(saved);
    expect(res.body.details.current.questions[0].options).toHaveLength(3);

    // حفظان متزامنان على المراجعة نفسها: ينجح واحد فقط
    const a = toBody(saved);
    a.title = 'متزامن أ';
    const b = toBody(saved);
    b.title = 'متزامن ب';
    b.questions = b.questions.slice(0, 2);
    const results = await Promise.all([
      as(admin).put(draftUrl(formId), { ...a, revision: 3 }),
      as(editor).put(draftUrl(formId), { ...b, revision: 3 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200)!.body;
    const loser = results.find((r) => r.status === 409)!.body;
    expect(loser.details.current).toEqual(winner);
    expect(winner.revision).toBe(4);
    saved = winner;
  });

  it('7) الحفظ المتزامن مع الأرشفة متسق، والمؤرشف لا يُعدَّل', async () => {
    for (let i = 0; i < 3; i++) {
      const body = toBody(saved);
      body.title = `سباق ${i}`;
      const [saveRes, archiveRes] = await Promise.all([
        as(admin).put(draftUrl(formId), { ...body, revision: saved.revision }),
        as(admin).post(`/api/forms/${formId}/archive`),
      ]);
      expect(archiveRes.status).toBe(200);
      const after = (await as(admin).get(draftUrl(formId))).body;
      expect(after.isArchived).toBe(true);
      if (saveRes.status === 200) {
        // فاز الحفظ قبل الأرشفة: المحتوى الجديد كاملًا
        expect(after.title).toBe(`سباق ${i}`);
        expect(after.revision).toBe(saved.revision + 1);
      } else {
        expect(saveRes.status).toBe(409);
        expect(saveRes.body.code).toBe('FORM_ARCHIVED');
        expect({
          ...after,
          isArchived: false,
          archivedAt: null,
          updatedAt: saved.updatedAt,
        }).toEqual(saved);
      }
      const blocked = await as(admin)
        .put(draftUrl(formId), { ...toBody(after), revision: after.revision })
        .expect(409);
      expect(blocked.body.code).toBe('FORM_ARCHIVED');
      await as(admin).post(`/api/forms/${formId}/restore`).expect(200);
      saved = (await as(admin).get(draftUrl(formId))).body;
    }
  });

  it('10) مسار المرحلة الأولى PATCH يحترم revision ولا يحذف الأسئلة', async () => {
    const before = saved;
    await as(admin)
      .patch(`/api/forms/${formId}`, { title: 'من المسار القديم', revision: before.revision - 1 })
      .expect(409);
    const res = await as(admin)
      .patch(`/api/forms/${formId}`, { title: 'من المسار القديم', revision: before.revision })
      .expect(200);
    expect(res.body.revision).toBe(before.revision + 1);
    const after = (await as(admin).get(draftUrl(formId))).body;
    expect(after.title).toBe('من المسار القديم');
    expect(after.questions).toEqual(before.questions);
    // الحفظ الكامل بالنسخة القديمة يُرفض بعد تعديل المسار القديم
    await as(admin)
      .put(draftUrl(formId), { ...toBody(before), revision: before.revision })
      .expect(409);
    // قائمة النماذج ووظائف المرحلة الأولى سليمة
    const list = await as(viewer).get('/api/forms?search=المسار').expect(200);
    expect(list.body.items[0].id).toBe(formId);
    saved = after;
  });

  it('مسودة بالحدود القصوى (100 سؤال × 50 خيارًا) تُحفظ وتُقرأ', async () => {
    const big = Array.from({ length: QUESTION_LIMITS.maxQuestions }, (_, i) => ({
      type: 'MULTIPLE_CHOICE',
      title: `سؤال ${i + 1}`,
      required: false,
      settings: {},
      options: Array.from({ length: QUESTION_LIMITS.maxOptions }, (_, j) => ({
        label: `خيار ${j + 1}`,
      })),
    }));
    const res = await as(admin)
      .put(draftUrl(otherFormId), { revision: 2, title: 'كبير', questions: big })
      .expect(200);
    expect(res.body.questions).toHaveLength(QUESTION_LIMITS.maxQuestions);
    expect(
      await prisma.formDraftQuestionOption.count({
        where: { question: { draft: { formId: otherFormId } } },
      }),
    ).toBe(QUESTION_LIMITS.maxQuestions * QUESTION_LIMITS.maxOptions);
  }, 60_000);

  it('مسودة صحيحة > 1MB بنص عربي تُحفظ على MySQL وتُعدَّل بالمعرّفات، وما يتجاوز الحد يُرفض بـ 413 دون تغيير', async () => {
    const L = QUESTION_LIMITS;
    const ar = (n: number) => 'ع'.repeat(n);
    const created = await as(admin).post('/api/forms', { title: 'مسودة كبيرة' }).expect(201);
    const id = created.body.id;
    const body = {
      revision: 1,
      title: 'مسودة كبيرة',
      description: ar(2000),
      questions: Array.from({ length: L.maxQuestions }, (_, qi) => ({
        type: 'MULTIPLE_CHOICE',
        title: `${qi + 1} ${ar(L.questionTitleMax - 5)}`,
        description: ar(L.questionDescriptionMax),
        required: false,
        settings: { minSelections: 1, maxSelections: L.maxOptions },
        options: Array.from({ length: L.maxOptions }, (_, oi) => ({
          label: `${oi + 1} ${ar(L.optionLabelMax - 5)}`,
        })),
      })),
    };
    const raw = JSON.stringify(body);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(2 * 1024 * 1024);
    const first = await as(admin).put(draftUrl(id), body).expect(200);
    expect(first.body.revision).toBe(2);
    expect(first.body.questions).toHaveLength(L.maxQuestions);
    expect(first.body.questions[99].options[49].label).toBe(`50 ${ar(L.optionLabelMax - 5)}`);

    // القراءة الكاملة من MySQL تطابق ما حُفظ
    const reloaded = await as(admin).get(draftUrl(id)).expect(200);
    expect(reloaded.body).toEqual(first.body);
    expect(Buffer.byteLength(JSON.stringify(reloaded.body))).toBeGreaterThan(2 * 1024 * 1024);

    // إعادة حفظ المحتوى نفسه بالمعرّفات (طلب أكبر من الأول) دون زيادة revision
    const same = toBody(reloaded.body);
    expect(Buffer.byteLength(JSON.stringify(same))).toBeGreaterThan(Buffer.byteLength(raw));
    const unchanged = await as(admin).put(draftUrl(id), same).expect(200);
    expect(unchanged.body.revision).toBe(2);
    expect(unchanged.body).toEqual(reloaded.body);

    // إعادة الحفظ بالمعرّفات مع تعديل نص خيار واحد: مسار التحديث على الحجم الأقصى
    const withIds = toBody(first.body);
    withIds.questions[0].options[0].label = 'خيار معدّل';
    expect(Buffer.byteLength(JSON.stringify(withIds))).toBeGreaterThan(Buffer.byteLength(raw));
    const second = await as(admin).put(draftUrl(id), withIds).expect(200);
    expect(second.body.revision).toBe(3);
    expect(second.body.questions[0].options[0]).toEqual({
      id: first.body.questions[0].options[0].id,
      label: 'خيار معدّل',
    });
    expect(
      await prisma.formDraftQuestionOption.count({
        where: { question: { draft: { formId: id } } },
      }),
    ).toBe(L.maxQuestions * L.maxOptions);

    // تجاوز الحد: 413 برسالة عربية والمسودة كما هي
    const over = { ...toBody(second.body), questions: toBody(second.body).questions };
    const padded = JSON.stringify(over).replace(
      /}$/,
      `,"pad":"${'x'.repeat(DRAFT_REQUEST_MAX_BYTES)}"}`,
    );
    const tooBig = await request(app.getHttpServer())
      .put(draftUrl(id))
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .set('x-csrf-token', admin.csrf)
      .set('Content-Type', 'application/json')
      .send(padded)
      .expect(413);
    expect(tooBig.body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(tooBig.body.message).toMatch(/حجم المسودة يتجاوز الحد المسموح/);
    const after = await as(admin).get(draftUrl(id)).expect(200);
    expect(after.body.revision).toBe(3);
  }, 120_000);

  it('9) المحرر لا ينشئ ردودًا ولا إصدارات، ولا توجد جداول رفع ملفات', async () => {
    // جداول الردود أُضيفت في المرحلة الثالثة؛ المطلوب هنا أن الحفظ والمعاينة لا ينشئان أي رد أو إصدار.
    const tables: { t: string }[] = await prisma.$queryRaw`
      SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`;
    const names = tables.map((r) => r.t);
    expect(names.some((n) => /submission|upload|file/i.test(n))).toBe(false);
    const forms = await prisma.form.findMany({
      where: { createdBy: { username: { startsWith: 'p2.' } } },
      select: { id: true },
    });
    const formIds = forms.map((f) => f.id);
    expect(formIds.length).toBeGreaterThan(0);
    expect(await prisma.formResponse.count({ where: { formId: { in: formIds } } })).toBe(0);
    expect(await prisma.formVersion.count({ where: { formId: { in: formIds } } })).toBe(0);
  });
});

/** يحوّل استجابة المسودة إلى جسم حفظ (مع المعرّفات). */
function toBody(draft: any): any {
  return {
    revision: draft.revision,
    title: draft.title,
    description: draft.description,
    questions: draft.questions.map((q: any) => ({
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
