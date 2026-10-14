import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient, UserRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';

/**
 * المرحلة الرابعة من طرف إلى طرف: قائمة الردود وتفاصيلها وتغيير حالتها وتصديرها، والصلاحيات والملكية.
 * مستقل عن المراحل السابقة (مستخدمون بأسماء p4.*) وينظف بياناته في النهاية.
 */

const ORIGIN = 'http://localhost:3000';
const ADMIN = { username: 'p4.admin', password: 'P4-admin-pass-2026!' };
const FORMS_ONLY = { username: 'p4.formsonly', password: 'P4-forms-pass-2026!' };
const VIEWER = { username: 'p4.viewer', password: 'P4-viewer-pass-2026!' };
const REVIEWER = { username: 'p4.reviewer', password: 'P4-review-pass-2026!' };
const USERNAMES = [ADMIN, FORMS_ONLY, VIEWER, REVIEWER].map((u) => u.username);

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

async function login(u: { username: string; password: string }, a = app): Promise<Session> {
  const res = await request(a.getHttpServer())
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

function as(s: Session, a = app) {
  const server = a.getHttpServer();
  const auth = (req: request.Test) =>
    req.set('Cookie', s.cookie).set('Origin', ORIGIN).set('x-csrf-token', s.csrf);
  return {
    get: (url: string) => request(server).get(url).set('Cookie', s.cookie),
    post: (url: string, body?: object) => auth(request(server).post(url)).send(body ?? {}),
    put: (url: string, body: object) => auth(request(server).put(url)).send(body),
    patch: (url: string, body: object) => auth(request(server).patch(url)).send(body),
  };
}

const submit = (publicId: string, body: object) =>
  request(app.getHttpServer())
    .post(`/api/public/forms/${publicId}/responses`)
    .set('Origin', ORIGIN)
    .send(body);

/** محلل CSV بسيط: كل الخلايا بين علامتي تنصيص (كما يكتبها الخادم). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    if (text[i] === '"') {
      let cell = '';
      i++;
      for (;;) {
        if (text[i] === '"' && text[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else if (text[i] === '"') {
          i++;
          break;
        } else cell += text[i++];
      }
      row.push(cell);
    }
    if (text[i] === ',') i++;
    else if (text[i] === '\r' && text[i + 1] === '\n') {
      rows.push(row);
      row = [];
      i += 2;
    } else if (i < text.length && text[i] !== '"') throw new Error(`csv parse error at ${i}`);
  }
  return rows;
}

let admin: Session;
let formsOnly: Session;
let viewer: Session;
let reviewer: Session;
let formA: string;
let formB: string;
let publicA: string;
/** ردود النموذج A: الرقم المرجعي ⇒ المعرّف */
const refs: Record<string, { id: string; code: string }> = {};
let responseB: { id: string; code: string };

const url = (form: string, rest = '') => `/api/forms/${form}/responses${rest}`;

async function publish(form: string, openResponses?: boolean) {
  const draft = (await as(admin).get(`/api/forms/${form}/draft`).expect(200)).body;
  await as(admin)
    .post(`/api/forms/${form}/publish`, {
      revision: draft.revision,
      publishKey: randomUUID(),
      ...(openResponses !== undefined && { openResponses }),
    })
    .expect(200);
}

async function publicForm(publicId: string) {
  return (await request(app.getHttpServer()).get(`/api/public/forms/${publicId}`).expect(200)).body;
}

async function send(publicId: string, values: Record<string, unknown>): Promise<string> {
  const form = await publicForm(publicId);
  const answers = Object.entries(values)
    .map(([title, value]) => {
      const q = form.questions.find((x: any) => x.title === title);
      if (!q) throw new Error(`no question ${title}`);
      const opt = (label: string) => q.options.find((o: any) => o.label === label).id;
      const v = Array.isArray(value)
        ? value.map(opt)
        : q.options.length
          ? opt(String(value))
          : value;
      return { questionId: q.id, value: v };
    })
    .filter((a) => a.value !== undefined);
  const res = await submit(publicId, {
    versionId: form.versionId,
    idempotencyKey: randomUUID(),
    answers,
  }).expect(201);
  return res.body.referenceCode;
}

beforeAll(async () => {
  prisma = new PrismaClient();
  app = await startApp();
  await prisma.user.create({
    data: {
      username: ADMIN.username,
      displayName: 'مدير المرحلة الرابعة',
      passwordHash: await hashPassword(ADMIN.password),
      role: UserRole.ADMIN,
    },
  });
  admin = await login(ADMIN);
  const create = (u: typeof VIEWER, displayName: string, permissions: string[]) =>
    as(admin)
      .post('/api/users', { username: u.username, displayName, password: u.password, permissions })
      .expect(201);
  await create(FORMS_ONLY, 'نماذج فقط', ['FORMS_VIEW']);
  await create(VIEWER, 'عارض الردود', ['FORMS_VIEW', 'RESPONSES_VIEW']);
  await create(REVIEWER, 'مراجع الردود', ['FORMS_VIEW', 'RESPONSES_VIEW', 'RESPONSES_REVIEW']);
  formsOnly = await login(FORMS_ONLY);
  viewer = await login(VIEWER);
  reviewer = await login(REVIEWER);

  // النموذج A بإصدارين؛ ردود على كل منهما.
  formA = (await as(admin).post('/api/forms', { title: 'نموذج الردود' }).expect(201)).body.id;
  await as(admin)
    .put(`/api/forms/${formA}/draft`, {
      revision: 1,
      title: 'نموذج الردود',
      questions: [
        { type: 'SHORT_TEXT', title: 'الاسم', required: true, settings: {} },
        { type: 'PARAGRAPH', title: 'ملاحظات', required: false, settings: {} },
        {
          type: 'MULTIPLE_CHOICE',
          title: 'الاهتمامات',
          required: false,
          settings: {},
          options: [{ label: 'تقنية' }, { label: 'تصميم' }, { label: 'إدارة' }],
        },
        { type: 'NUMBER', title: 'المبلغ', required: false, settings: { allowDecimals: true } },
        { type: 'DATE', title: 'التاريخ', required: false, settings: {} },
      ],
    })
    .expect(200);
  await publish(formA, true);
  publicA = (await as(admin).get(`/api/forms/${formA}`).expect(200)).body.publication.publicId;

  const r1 = await send(publicA, {
    الاسم: '=HYPERLINK("http://evil.example","اضغط")',
    الاهتمامات: ['تقنية', 'إدارة'],
    المبلغ: '-12.5',
    التاريخ: '2026-10-01',
  });
  const r2 = await send(publicA, {
    الاسم: '+966500000000',
    ملاحظات: 'سطر أول\nسطر "ثانٍ", وفاصلة',
  });
  const r3 = await send(publicA, { الاسم: '@SUM(1,2)' });

  // تعديل المسودة بعد النشر: إعادة تسمية سؤال، حذف آخر، تغيير نص خيار؛ ثم نشر الإصدار 2.
  const draft = (await as(admin).get(`/api/forms/${formA}/draft`).expect(200)).body;
  const body = {
    revision: draft.revision,
    title: draft.title,
    description: draft.description,
    questions: draft.questions
      .filter((q: any) => q.title !== 'ملاحظات')
      .map((q: any) => ({
        id: q.id,
        type: q.type,
        title: q.title === 'الاسم' ? 'الاسم الكامل' : q.title,
        description: q.description,
        required: q.required,
        settings: q.settings,
        options: q.options.map((o: any) => ({
          id: o.id,
          label: o.label === 'تقنية' ? 'تقنية المعلومات' : o.label,
        })),
      })),
  };
  await as(admin).put(`/api/forms/${formA}/draft`, body).expect(200);
  await publish(formA);
  const r4 = await send(publicA, { 'الاسم الكامل': 'خالد', الاهتمامات: ['تقنية المعلومات'] });
  const r5 = await send(publicA, { 'الاسم الكامل': 'نورة' });

  const codes = [r1, r2, r3, r4, r5];
  const rows = await prisma.formResponse.findMany({
    where: { referenceCode: { in: codes } },
    select: { id: true, referenceCode: true },
  });
  codes.forEach((code, i) => {
    refs[`r${i + 1}`] = { id: rows.find((r) => r.referenceCode === code)!.id, code };
  });
  // أوقات إرسال محددة لاختبار حدود أيام الرياض (UTC+3) والترتيب.
  const times: Record<string, string> = {
    r1: '2026-09-30T20:59:59.000Z', // 23:59:59 يوم 30 سبتمبر بالرياض
    r2: '2026-09-30T21:00:00.000Z', // 00:00:00 يوم 1 أكتوبر بالرياض
    r3: '2026-10-02T09:00:00.000Z',
    r4: '2026-10-05T09:00:00.000Z',
    r5: '2026-10-06T09:00:00.000Z',
  };
  for (const [k, t] of Object.entries(times)) {
    await prisma.formResponse.update({
      where: { id: refs[k]!.id },
      data: { submittedAt: new Date(t) },
    });
  }

  // النموذج B برد واحد (للتحقق من رفض الوصول عبر نموذج آخر).
  formB = (await as(admin).post('/api/forms', { title: 'نموذج آخر' }).expect(201)).body.id;
  await as(admin)
    .put(`/api/forms/${formB}/draft`, {
      revision: 1,
      title: 'نموذج آخر',
      questions: [{ type: 'SHORT_TEXT', title: 'سؤال', required: true, settings: {} }],
    })
    .expect(200);
  await publish(formB, true);
  const publicB = (await as(admin).get(`/api/forms/${formB}`).expect(200)).body.publication
    .publicId;
  const codeB = await send(publicB, { سؤال: 'إجابة' });
  responseB = {
    code: codeB,
    id: (await prisma.formResponse.findUnique({ where: { referenceCode: codeB } }))!.id,
  };
}, 120_000);

afterAll(async () => {
  if (prisma) {
    const users = await prisma.user.findMany({
      where: { username: { in: USERNAMES } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    const forms = await prisma.form.findMany({
      where: { createdById: { in: ids } },
      select: { id: true },
    });
    const formIds = forms.map((f) => f.id);
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
});

describe('المرحلة الرابعة: إدارة الردود', () => {
  it('الصلاحيات الجديدة في الفهرس بالاعتماديات الصحيحة', async () => {
    const cat = (await as(admin).get('/api/users/permissions').expect(200)).body;
    const byKey = Object.fromEntries(cat.map((p: any) => [p.key, p]));
    expect(byKey.RESPONSES_VIEW.requires).toBe('FORMS_VIEW');
    expect(byKey.RESPONSES_REVIEW.requires).toBe('RESPONSES_VIEW');
    expect(byKey.RESPONSES_EXPORT.requires).toBe('RESPONSES_VIEW');
    const bad = await as(admin)
      .post('/api/users', {
        username: 'p4.bad',
        displayName: 'خطأ',
        password: 'P4-bad-pass-2026!',
        permissions: ['FORMS_VIEW', 'RESPONSES_REVIEW'],
      })
      .expect(400);
    expect(bad.body.fields[0].message).toMatch(/عرض الردود/);
  });

  it('1) المصرح له يرى القائمة والتفاصيل؛ القائمة لا تتضمن الإجابات', async () => {
    for (const s of [admin, viewer, reviewer]) {
      const list = await as(s).get(url(formA)).expect(200);
      expect(list.body.meta.total).toBe(5);
      expect(Object.keys(list.body.items[0]).sort()).toEqual(
        ['id', 'referenceCode', 'status', 'submittedAt', 'versionNumber'].sort(),
      );
      await as(s)
        .get(url(formA, `/${refs.r1!.id}`))
        .expect(200);
    }
    const me = (await as(viewer).get('/api/auth/me').expect(200)).body;
    expect(me.permissions).toEqual(['FORMS_VIEW', 'RESPONSES_VIEW']);
  });

  it('2) دون RESPONSES_VIEW: 403 على كل المسارات بطلب مباشر', async () => {
    const r = refs.r1!.id;
    for (const res of [
      await as(formsOnly).get(url(formA)),
      await as(formsOnly).get(url(formA, `/${r}`)),
      await as(formsOnly).get(url(formA, '/export')),
      await as(formsOnly).patch(url(formA, `/${r}/status`), { status: 'ACCEPTED' }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
    // دون جلسة: 401
    await request(app.getHttpServer()).get(url(formA)).expect(401);
  });

  it('3) دون RESPONSES_REVIEW لا يتغير الحالة بطلب مباشر، ودون CSRF يُرفض', async () => {
    const r = refs.r1!.id;
    expect(
      (
        await as(viewer)
          .patch(url(formA, `/${r}/status`), { status: 'ACCEPTED' })
          .expect(403)
      ).body.code,
    ).toBe('FORBIDDEN');
    await request(app.getHttpServer())
      .patch(url(formA, `/${r}/status`))
      .set('Cookie', reviewer.cookie)
      .set('Origin', ORIGIN)
      .send({ status: 'ACCEPTED' })
      .expect(403);
    const row = await prisma.formResponse.findUnique({ where: { id: r } });
    expect(row!.status).toBe('NEW');
  });

  it('4) دون RESPONSES_EXPORT لا يُصدّر', async () => {
    for (const s of [viewer, reviewer]) {
      expect((await as(s).get(url(formA, '/export')).expect(403)).body.code).toBe('FORBIDDEN');
    }
  });

  it('5) البحث بالرقم المرجعي: كاملًا، وبدايته بأحرف صغيرة ودون شرطات', async () => {
    const code = refs.r3!.code;
    const full = (
      await as(viewer)
        .get(url(formA, `?search=${code}`))
        .expect(200)
    ).body;
    expect(full.items.map((i: any) => i.referenceCode)).toEqual([code]);
    const prefix = code.replace(/-/g, '').slice(0, 6).toLowerCase();
    const part = (
      await as(viewer)
        .get(url(formA, `?search=${prefix}`))
        .expect(200)
    ).body;
    expect(part.items.map((i: any) => i.referenceCode)).toContain(code);
    // رقم من نموذج آخر لا يظهر
    expect(
      (
        await as(viewer)
          .get(url(formA, `?search=${responseB.code}`))
          .expect(200)
      ).body.meta.total,
    ).toBe(0);
    const bad = await as(viewer).get(url(formA, '?search=<script>')).expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
  });

  it('6) فلاتر الحالة والتاريخ (أيام الرياض) والإصدار، ورفض القيم غير الصالحة', async () => {
    await as(reviewer)
      .patch(url(formA, `/${refs.r2!.id}/status`), { status: 'IN_REVIEW' })
      .expect(200);
    const inReview = (await as(viewer).get(url(formA, '?status=IN_REVIEW')).expect(200)).body;
    expect(inReview.items.map((i: any) => i.id)).toEqual([refs.r2!.id]);

    const codes = async (q: string) =>
      (
        await as(viewer)
          .get(url(formA, `?sort=oldest&${q}`))
          .expect(200)
      ).body.items.map((i: any) => i.referenceCode);
    // r1 = 23:59:59 يوم 30/9 بالرياض، r2 = 00:00 يوم 1/10 بالرياض
    expect(await codes('to=2026-09-30')).toEqual([refs.r1!.code]);
    expect(await codes('from=2026-10-01&to=2026-10-02')).toEqual([refs.r2!.code, refs.r3!.code]);
    expect(await codes('from=2026-10-05')).toEqual([refs.r4!.code, refs.r5!.code]);
    expect(await codes('version=1')).toEqual([refs.r1!.code, refs.r2!.code, refs.r3!.code]);
    expect(await codes('version=2')).toEqual([refs.r4!.code, refs.r5!.code]);
    expect(await codes('version=9')).toEqual([]);

    for (const q of [
      'status=DELETED',
      'from=2026-02-30',
      'from=2026-10-05&to=2026-10-01',
      'from=yesterday',
      'sort=random',
      'page=0',
      'pageSize=51',
      'unknown=1',
    ]) {
      const res = await as(viewer).get(url(formA, `?${q}`));
      expect([q, res.status]).toEqual([q, 400]);
    }
  });

  it('7) الترقيم والترتيب من قاعدة البيانات', async () => {
    const page = async (n: number, sort: string) =>
      (
        await as(viewer)
          .get(url(formA, `?pageSize=2&page=${n}&sort=${sort}`))
          .expect(200)
      ).body;
    const p1 = await page(1, 'newest');
    expect(p1.meta).toEqual({ page: 1, pageSize: 2, total: 5, totalPages: 3 });
    expect(p1.items.map((i: any) => i.referenceCode)).toEqual([refs.r5!.code, refs.r4!.code]);
    expect((await page(3, 'newest')).items.map((i: any) => i.referenceCode)).toEqual([
      refs.r1!.code,
    ]);
    expect((await page(1, 'oldest')).items.map((i: any) => i.referenceCode)).toEqual([
      refs.r1!.code,
      refs.r2!.code,
    ]);
    expect((await page(9, 'oldest')).items).toEqual([]);
  });

  it('8) و11) التفاصيل تعرض أسئلة الإصدار الأصلي وإجاباته بعد تعديل المسودة ونشر إصدار جديد', async () => {
    const d = (
      await as(viewer)
        .get(url(formA, `/${refs.r1!.id}`))
        .expect(200)
    ).body;
    expect(d).toMatchObject({
      referenceCode: refs.r1!.code,
      status: 'NEW',
      formTitle: 'نموذج الردود',
      version: { versionNumber: 1, title: 'نموذج الردود' },
      statusHistory: [],
    });
    const byTitle = Object.fromEntries(d.answers.map((a: any) => [a.title, a]));
    // عنوان السؤال كما كان في الإصدار 1 (قبل إعادة التسمية)، والسؤال المحذوف من المسودة ما زال ظاهرًا.
    expect(Object.keys(byTitle)).toEqual(['الاسم', 'ملاحظات', 'الاهتمامات', 'المبلغ', 'التاريخ']);
    expect(byTitle['الاسم']).toMatchObject({
      kind: 'text',
      value: '=HYPERLINK("http://evil.example","اضغط")',
      required: true,
    });
    expect(byTitle['ملاحظات']).toMatchObject({ kind: 'empty', required: false });
    expect(byTitle['الاهتمامات'].options).toEqual([
      { label: 'تقنية', selected: true },
      { label: 'تصميم', selected: false },
      { label: 'إدارة', selected: true },
    ]);
    expect(byTitle['المبلغ']).toMatchObject({ kind: 'number', value: '-12.5' });
    expect(byTitle['التاريخ']).toMatchObject({ kind: 'date', value: '2026-10-01' });

    const d4 = (
      await as(viewer)
        .get(url(formA, `/${refs.r4!.id}`))
        .expect(200)
    ).body;
    expect(d4.version.versionNumber).toBe(2);
    expect(d4.answers.map((a: any) => a.title)).toEqual([
      'الاسم الكامل',
      'الاهتمامات',
      'المبلغ',
      'التاريخ',
    ]);
    expect(d4.answers[1].options[0]).toEqual({ label: 'تقنية المعلومات', selected: true });
  });

  it('9) و10) تغيير الحالة يسجل القديمة والجديدة والمستخدم والوقت، والحالة نفسها لا تكرر السجل', async () => {
    const r = refs.r3!.id;
    const answersBefore = await prisma.formAnswer.findMany({
      where: { responseId: r },
      orderBy: { id: 'asc' },
    });
    const before = Date.now();
    const first = await as(reviewer)
      .patch(url(formA, `/${r}/status`), { status: 'ACCEPTED' })
      .expect(200);
    expect(first.body.changed).toBe(true);
    expect(first.body.response.status).toBe('ACCEPTED');
    expect(first.body.response.statusHistory).toHaveLength(1);
    const h = first.body.response.statusHistory[0];
    expect(h).toMatchObject({ fromStatus: 'NEW', toStatus: 'ACCEPTED', changedBy: 'مراجع الردود' });
    expect(h.changedAt).toMatch(/Z$/);
    expect(new Date(h.changedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);

    const same = await as(reviewer)
      .patch(url(formA, `/${r}/status`), { status: 'ACCEPTED' })
      .expect(200);
    expect(same.body.changed).toBe(false);
    const parallel = await Promise.all(
      Array.from({ length: 5 }, () =>
        as(reviewer).patch(url(formA, `/${r}/status`), { status: 'REJECTED' }),
      ),
    );
    expect(parallel.map((p) => [p.status, p.body.code ?? null])).toEqual(
      parallel.map(() => [200, null]),
    );
    expect(parallel.filter((p) => p.body.changed).length).toBe(1);
    const history = await prisma.formResponseStatusChange.findMany({
      where: { responseId: r },
      orderBy: { changedAt: 'asc' },
    });
    expect(history.map((x) => [x.fromStatus, x.toStatus])).toEqual([
      ['NEW', 'ACCEPTED'],
      ['ACCEPTED', 'REJECTED'],
    ]);
    expect(history.every((x) => x.changedById === reviewer.userId)).toBe(true);

    // الإجابات والإصدار لم يتغيرا
    const answersAfter = await prisma.formAnswer.findMany({
      where: { responseId: r },
      orderBy: { id: 'asc' },
    });
    expect(answersAfter).toEqual(answersBefore);
    const row = await prisma.formResponse.findUnique({ where: { id: r } });
    expect(row!.versionId).toBe(answersBefore[0]!.versionId);

    for (const status of ['DELETED', 'new', '', null]) {
      await as(reviewer)
        .patch(url(formA, `/${r}/status`), { status })
        .expect(400);
    }
    await as(reviewer)
      .patch(url(formA, `/${r}/status`), { status: 'NEW', extra: 1 })
      .expect(400);

    const audit = await prisma.auditLog.findMany({
      where: { action: 'response.status_changed', entityId: r },
    });
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit.map((a) => a.details))).not.toMatch(/SUM|سارة|@/);
  });

  it('12) رد من نموذج آخر مرفوض بتغيير المعرّف في الرابط', async () => {
    await as(admin)
      .get(url(formA, `/${responseB.id}`))
      .expect(404);
    await as(admin)
      .get(url(formB, `/${refs.r1!.id}`))
      .expect(404);
    await as(admin)
      .patch(url(formB, `/${refs.r1!.id}/status`), { status: 'ACCEPTED' })
      .expect(404);
    expect((await prisma.formResponse.findUnique({ where: { id: refs.r1!.id } }))!.status).toBe(
      'NEW',
    );
    const listB = (await as(admin).get(url(formB)).expect(200)).body;
    expect(listB.items.map((i: any) => i.id)).toEqual([responseB.id]);
    await as(admin).get(url(randomUUID())).expect(404);
    await as(admin).get(url(formA, '/not-an-id')).expect(404);
  });

  it('13) التصدير يحترم الصلاحية والفلاتر ويمنع حقن الصيغ', async () => {
    const res = await as(admin).get(url(formA, '/export?sort=oldest')).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="responses-\d{8}\.csv"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const text = res.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(text);
    // الأعمدة الثابتة ثم الأسئلة بالمفتاح المنطقي (عناوين أحدث إصدار، والسؤال المحذوف بعنوانه القديم).
    expect(rows[0]).toEqual([
      'الرقم المرجعي',
      'تاريخ الإرسال (توقيت الرياض)',
      'الحالة',
      'الإصدار',
      'الاسم الكامل',
      'الاهتمامات',
      'المبلغ',
      'التاريخ',
      'ملاحظات',
    ]);
    expect(rows).toHaveLength(6);
    const r1 = rows.find((r) => r[0] === refs.r1!.code)!;
    expect(r1.slice(1)).toEqual([
      '2026-09-30 23:59:59',
      'جديد',
      '1',
      `'=HYPERLINK("http://evil.example","اضغط")`,
      'تقنية، إدارة',
      `'-12.5`,
      '2026-10-01',
      '',
    ]);
    const r2 = rows.find((r) => r[0] === refs.r2!.code)!;
    expect(r2[4]).toBe(`'+966500000000`);
    expect(r2[8]).toBe('سطر أول\nسطر "ثانٍ", وفاصلة');
    expect(rows.find((r) => r[0] === refs.r3!.code)![4]).toBe(`'@SUM(1,2)`);
    expect(rows.some((r) => r.some((c) => /^[=+\-@]/.test(c)))).toBe(false);

    const filtered = parseCsv(
      (await as(admin).get(url(formA, '/export?version=2&sort=newest')).expect(200)).text,
    );
    expect(filtered.slice(1).map((r) => r[0])).toEqual([refs.r5!.code, refs.r4!.code]);
    const byStatus = parseCsv(
      (await as(admin).get(url(formA, '/export?status=IN_REVIEW')).expect(200)).text,
    );
    expect(byStatus.slice(1).map((r) => [r[0], r[2]])).toEqual([[refs.r2!.code, 'قيد المراجعة']]);
    const none = parseCsv((await as(admin).get(url(formA, '/export?version=9')).expect(200)).text);
    expect(none).toHaveLength(1);
    await as(admin).get(url(formA, '/export?status=BAD')).expect(400);

    const audit = await prisma.auditLog.findMany({
      where: { action: 'responses.exported', entityId: formA },
    });
    expect(audit.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(audit.map((a) => a.details))).not.toMatch(/HYPERLINK|966/);
  });

  it('حدود المعدل لمسارات الإدارة والتصدير لكل مستخدم', async () => {
    const saved = {
      list: process.env.RESPONSES_RATE_LIMIT_PER_MINUTE,
      exp: process.env.RESPONSES_EXPORT_PER_MINUTE,
    };
    process.env.RESPONSES_RATE_LIMIT_PER_MINUTE = '3';
    process.env.RESPONSES_EXPORT_PER_MINUTE = '1';
    let limited: NestExpressApplication | undefined;
    try {
      limited = await startApp();
      const v = await login(VIEWER, limited);
      const a = await login(ADMIN, limited);
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await as(v, limited).get(url(formA))).status);
      expect(statuses).toEqual([200, 200, 200, 429]);
      // مستخدم آخر لا يتأثر بحد الأول
      expect((await as(a, limited).get(url(formA))).status).toBe(200);
      expect((await as(a, limited).get(url(formA, '/export'))).status).toBe(200);
      expect((await as(a, limited).get(url(formA, '/export'))).status).toBe(429);
    } finally {
      await limited?.close();
      process.env.RESPONSES_RATE_LIMIT_PER_MINUTE = saved.list;
      process.env.RESPONSES_EXPORT_PER_MINUTE = saved.exp;
    }
  }, 60_000);

  it('14) البيانات والحالات وسجلها محفوظة بعد إعادة تشغيل التطبيق', async () => {
    await app.close();
    app = await startApp();
    admin = await login(ADMIN);
    const d = (
      await as(admin)
        .get(url(formA, `/${refs.r3!.id}`))
        .expect(200)
    ).body;
    expect(d.status).toBe('REJECTED');
    expect(d.statusHistory).toHaveLength(2);
    expect((await as(admin).get(url(formA)).expect(200)).body.meta.total).toBe(5);
  });

  it('15) الدخول والنماذج والنشر والصفحة العامة تعمل كما هي، ولا مسار عام للردود', async () => {
    await as(admin).get('/api/forms').expect(200);
    const pubForm = await publicForm(publicA);
    expect(pubForm.acceptingResponses).toBe(true);
    await send(publicA, { 'الاسم الكامل': 'تجربة' });
    await request(app.getHttpServer()).get(`/api/public/forms/${publicA}/responses`).expect(404);
    await request(app.getHttpServer()).get(`/api/responses/${refs.r1!.id}`).expect(404);
    expect((await as(admin).get(url(formA)).expect(200)).body.meta.total).toBe(6);
  });
});
