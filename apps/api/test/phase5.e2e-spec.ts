import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient, UserRole } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { UploadsService } from '../src/files/uploads.service';
import { buildZip, samples, startFakeClamd } from './fixtures/files';

/**
 * المرحلة النهائية: رفع الملفات الفعلي. فاحص clamd وهمي على منفذ عشوائي (البروتوكول الحقيقي INSTREAM)
 * يكتشف سلسلة EICAR؛ فحص ClamAV الحقيقي يُختبر بعد النشر (docs/verification/final-acceptance.md).
 */

const ORIGIN = 'http://localhost:3000';
const ADMIN = { username: 'p5.admin', password: 'P5-admin-pass-2026!' };
const VIEWER = { username: 'p5.viewer', password: 'P5-viewer-pass-2026!' };
const DOWNLOADER = { username: 'p5.downloader', password: 'P5-download-pass-2026!' };
const USERNAMES = [ADMIN, VIEWER, DOWNLOADER].map((u) => u.username);

let app: NestExpressApplication;
let prisma: PrismaClient;
let fake: Awaited<ReturnType<typeof startFakeClamd>>;
let uploadDir: string;
const savedEnv = { ...process.env };

interface Session {
  cookie: string[];
  csrf: string;
}

async function startApp(extra: Record<string, string | undefined> = {}) {
  Object.assign(process.env, extra);
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete process.env[k];
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

const pub = {
  form: async (publicId: string) =>
    (await request(app.getHttpServer()).get(`/api/public/forms/${publicId}`).expect(200)).body,
  session: (publicId: string) =>
    request(app.getHttpServer())
      .post(`/api/public/forms/${publicId}/upload-sessions`)
      .set('Origin', ORIGIN)
      .send({}),
  upload: (
    publicId: string,
    token: string | null,
    questionId: string,
    name: string,
    data: Buffer,
  ) => {
    const r = request(app.getHttpServer())
      .post(`/api/public/forms/${publicId}/files?questionId=${questionId}`)
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/octet-stream')
      .set('x-file-name', encodeURIComponent(name));
    return (token ? r.set('x-fill-session', token) : r).send(data);
  },
  remove: (publicId: string, token: string, fileId: string) =>
    request(app.getHttpServer())
      .delete(`/api/public/forms/${publicId}/files/${fileId}`)
      .set('Origin', ORIGIN)
      .set('x-fill-session', token),
  submit: (publicId: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/public/forms/${publicId}/responses`)
      .set('Origin', ORIGIN)
      .send(body),
};

let admin: Session;
let viewer: Session;
let downloader: Session;
let formId: string;
let publicId: string;
let form: any; // النموذج العام
let qDocs: string; // سؤال الملفات متعدد الأنواع
let qCv: string; // سؤال PDF اختياري
let qName: string;
let otherPublicId: string;
let otherFormId: string;

const fileCount = (where: object = {}) => prisma.uploadedFile.count({ where });
const storedFiles = async () => {
  const out: string[] = [];
  const base = join(uploadDir, 'files');
  for (const d of await readdir(base).catch(() => [] as string[])) {
    for (const f of await readdir(join(base, d))) out.push(f);
  }
  return out;
};

async function createPublished(title: string, questions: object[]) {
  const id = (await as(admin).post('/api/forms', { title }).expect(201)).body.id;
  await as(admin).put(`/api/forms/${id}/draft`, { revision: 1, title, questions }).expect(200);
  const draft = (await as(admin).get(`/api/forms/${id}/draft`).expect(200)).body;
  const res = await as(admin)
    .post(`/api/forms/${id}/publish`, {
      revision: draft.revision,
      publishKey: randomUUID(),
      openResponses: true,
    })
    .expect(200);
  return { id, publicId: res.body.form.publication.publicId as string };
}

beforeAll(async () => {
  prisma = new PrismaClient();
  fake = await startFakeClamd();
  uploadDir = await mkdtemp(join(tmpdir(), 'lawha-p5-'));
  app = await startApp({
    CLAMAV_HOST: '127.0.0.1',
    CLAMAV_PORT: String(fake.port),
    CLAMAV_TIMEOUT_MS: '2000',
    UPLOAD_DIR: uploadDir,
    PUBLIC_UPLOAD_PER_IP_PER_MINUTE: '100000',
    PUBLIC_UPLOAD_PER_FORM_PER_MINUTE: '100000',
  });
  await prisma.user.create({
    data: {
      username: ADMIN.username,
      displayName: 'مدير المرحلة النهائية',
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
  viewer = await login(VIEWER);
  downloader = await login(DOWNLOADER);

  const created = await createPublished('نموذج الملفات', [
    { type: 'SHORT_TEXT', title: 'الاسم', required: true, settings: {} },
    {
      type: 'FILE_UPLOAD',
      title: 'المستندات',
      required: true,
      settings: {
        allowedTypes: ['pdf', 'jpg', 'png', 'webp', 'docx', 'xlsx', 'txt'],
        maxFileSizeMb: 1,
        maxFiles: 7,
      },
    },
    {
      type: 'FILE_UPLOAD',
      title: 'السيرة',
      required: false,
      settings: { allowedTypes: ['pdf'], maxFileSizeMb: 1, maxFiles: 1 },
    },
  ]);
  formId = created.id;
  publicId = created.publicId;
  form = await pub.form(publicId);
  const q = (t: string) => form.questions.find((x: any) => x.title === t).id;
  qDocs = q('المستندات');
  qCv = q('السيرة');
  qName = q('الاسم');
  const other = await createPublished('نموذج آخر', [
    {
      type: 'FILE_UPLOAD',
      title: 'ملف',
      required: true,
      settings: { allowedTypes: ['pdf'], maxFileSizeMb: 1, maxFiles: 1 },
    },
  ]);
  otherPublicId = other.publicId;
  otherFormId = other.id;
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
  fake?.server.close();
  await rm(uploadDir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe('المرحلة النهائية: رفع الملفات', () => {
  let token: string;
  const accepted: Record<string, string> = {};

  it('الصلاحية الجديدة في الفهرس وتتطلب عرض الردود', async () => {
    const cat = (await as(admin).get('/api/users/permissions').expect(200)).body;
    expect(cat.find((p: any) => p.key === 'RESPONSES_FILES_DOWNLOAD').requires).toBe(
      'RESPONSES_VIEW',
    );
  });

  it('جلسة التعبئة: مجهولة، للنموذج المفتوح فقط', async () => {
    const res = await pub.session(publicId).expect(201);
    token = res.body.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await prisma.fillSession.findFirst({ where: { formId } });
    expect(row!.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(row!.tokenHash).not.toContain(token);
    await pub.session('doesNotExist12345678').expect(404);
  });

  it('رفع صحيح لكل نوع مدعوم، مع التحقق من النوع الفعلي والتجزئة', async () => {
    const cases: [keyof typeof samples, string, string][] = [
      ['pdf', 'تقرير.pdf', 'PDF'],
      ['jpg', 'صورة.jpg', 'JPG'],
      ['png', 'شعار.png', 'PNG'],
      ['webp', 'صورة.webp', 'WEBP'],
      ['docx', 'خطاب.docx', 'DOCX'],
      ['xlsx', 'جدول.xlsx', 'XLSX'],
      ['txt', 'ملاحظات.txt', 'TXT'],
    ];
    for (const [key, name, kind] of cases) {
      const res = await pub.upload(publicId, token, qDocs, name, samples[key]()).expect(201);
      expect(res.body).toMatchObject({ name, kind, size: samples[key]().length });
      accepted[key] = res.body.id;
      const row = await prisma.uploadedFile.findUnique({ where: { id: res.body.id } });
      expect(row!.sha256).toBe(createHash('sha256').update(samples[key]()).digest('hex'));
      expect(row!.storageKey).toMatch(/^[a-f0-9]{64}$/);
      expect(row!.scanEngine).toMatch(/ClamAV/);
    }
    expect((await storedFiles()).length).toBe(7);
  });

  it('رفض: امتداد مزيف، نوع غير مسموح، حجم زائد، عدد زائد، ZIP bomb', async () => {
    const before = await fileCount();
    const s2 = (await pub.session(publicId).expect(201)).body.token;
    const fake1 = await pub.upload(publicId, s2, qDocs, 'cv.pdf', samples.png()).expect(400);
    expect(
      (await pub.upload(publicId, s2, qCv, 'cv.pdf', samples.png()).expect(400)).body.message,
    ).toMatch(/غير مسموح/);
    expect(fake1.body).toMatchObject({
      code: 'FILE_REJECTED',
      message: expect.stringMatching(/لا يطابق/),
    });
    expect(
      (await pub.upload(publicId, token, qCv, 'cv.docx', samples.docx()).expect(400)).body.code,
    ).toBe('FILE_REJECTED');
    const big = Buffer.concat([samples.pdf(), Buffer.alloc(1024 * 1024 + 10, 0x20)]);
    expect((await pub.upload(publicId, token, qCv, 'big.pdf', big).expect(413)).body.code).toBe(
      'FILE_TOO_LARGE',
    );
    const count = await pub.upload(publicId, token, qDocs, 'extra.pdf', samples.pdf()).expect(409);
    expect(count.body.code).toBe('FILE_COUNT_LIMIT');
    const bomb = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<x/>') },
      { name: 'word/document.xml', data: Buffer.alloc(60 * 1024 * 1024) },
    ]);
    expect((await pub.upload(publicId, s2, qDocs, 'bomb.docx', bomb).expect(400)).body.code).toBe(
      'FILE_REJECTED',
    );
    expect(await fileCount()).toBe(before);
    expect(await readdir(join(uploadDir, 'tmp'))).toEqual([]);
  }, 60_000);

  it('EICAR يُرفض، وتعطل الفاحص أو مهلته لا يقبل الملف', async () => {
    const before = await fileCount();
    const s = (await pub.session(publicId).expect(201)).body.token;
    const eicar = await pub.upload(publicId, s, qDocs, 'eicar.txt', samples.eicar()).expect(422);
    expect(eicar.body.code).toBe('FILE_INFECTED');
    for (const mode of ['down', 'slow', 'garbage'] as const) {
      fake.mode.current = mode;
      const res = await pub.upload(publicId, s, qDocs, 'ok.pdf', samples.pdf()).expect(503);
      expect(res.body).toMatchObject({
        code: 'SCAN_UNAVAILABLE',
        message: expect.stringMatching(/أعد المحاولة/),
      });
    }
    fake.mode.current = 'ok';
    expect(await fileCount()).toBe(before);
    expect(await readdir(join(uploadDir, 'tmp'))).toEqual([]);
    // إعادة المحاولة بعد عودة الفاحص تنجح
    await pub.upload(publicId, s, qDocs, 'ok.pdf', samples.pdf()).expect(201);
  }, 30_000);

  it('العبث بالجلسة: دونها، أو لنموذج آخر، أو إزالة ملف جلسة أخرى', async () => {
    expect(
      (await pub.upload(publicId, null, qDocs, 'a.pdf', samples.pdf()).expect(401)).body.code,
    ).toBe('FILL_SESSION_INVALID');
    await pub.upload(publicId, 'x'.repeat(43), qDocs, 'a.pdf', samples.pdf()).expect(401);
    const otherToken = (await pub.session(otherPublicId).expect(201)).body.token;
    await pub.upload(publicId, otherToken, qDocs, 'a.pdf', samples.pdf()).expect(401);
    const otherQ = (await pub.form(otherPublicId)).questions[0].id;
    await pub.upload(publicId, token, otherQ, 'a.pdf', samples.pdf()).expect(400);
    await pub.upload(publicId, token, qName, 'a.pdf', samples.pdf()).expect(400);
    const s3 = (await pub.session(publicId).expect(201)).body.token;
    await pub.remove(publicId, s3, accepted.pdf!).expect(404);
    expect(await fileCount({ id: accepted.pdf })).toBe(1);
    const wrongType = await request(app.getHttpServer())
      .post(`/api/public/forms/${publicId}/files?questionId=${qDocs}`)
      .set('Origin', ORIGIN)
      .set('x-fill-session', token)
      .set('Content-Type', 'application/json')
      .send({ a: 1 });
    expect(wrongType.status).toBe(400);
  });

  let submitBody: any;
  let referenceCode: string;
  let responseId: string;

  it('الإرسال يرفض ملفات جلسة أخرى أو سؤال آخر أو نموذج آخر، ويحفظ الملفات الصالحة عند الفشل', async () => {
    const answersWith = (ids: string[], q = qDocs) => [
      { questionId: qName, value: 'سارة' },
      { questionId: q, value: ids },
    ];
    const s4 = (await pub.session(publicId).expect(201)).body.token;
    const foreign = (await pub.upload(publicId, s4, qDocs, 'f.pdf', samples.pdf()).expect(201)).body
      .id;
    const otherToken = (await pub.session(otherPublicId).expect(201)).body.token;
    const otherQ = (await pub.form(otherPublicId)).questions[0].id;
    const otherFile = (
      await pub.upload(otherPublicId, otherToken, otherQ, 'o.pdf', samples.pdf()).expect(201)
    ).body.id;
    const base = { versionId: form.versionId, fillSession: token };
    for (const [ids, q] of [
      [[foreign], qDocs],
      [[otherFile], qDocs],
      [[accepted.pdf!], qCv],
      [[randomUUID()], qDocs],
    ] as const) {
      const res = await pub
        .submit(publicId, {
          ...base,
          idempotencyKey: randomUUID(),
          answers: answersWith([...ids], q),
        })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    // دون رمز الجلسة
    await pub
      .submit(publicId, {
        versionId: form.versionId,
        idempotencyKey: randomUUID(),
        answers: answersWith([accepted.pdf!]),
      })
      .expect(400);
    // فشل تحقق آخر (الاسم الإلزامي مفقود): الملفات تبقى غير مرتبطة لإعادة المحاولة
    await pub
      .submit(publicId, {
        ...base,
        idempotencyKey: randomUUID(),
        answers: [{ questionId: qDocs, value: [accepted.pdf!] }],
      })
      .expect(400);
    expect(await fileCount({ id: accepted.pdf, responseId: null })).toBe(1);

    const ids = Object.values(accepted);
    submitBody = { ...base, idempotencyKey: randomUUID(), answers: answersWith(ids) };
    const ok = await pub.submit(publicId, submitBody).expect(201);
    referenceCode = ok.body.referenceCode;
    const resp = await prisma.formResponse.findUnique({ where: { referenceCode } });
    responseId = resp!.id;
    const attached = await prisma.uploadedFile.findMany({ where: { id: { in: ids } } });
    expect(attached.every((f) => f.responseId === responseId && f.answerId && f.attachedAt)).toBe(
      true,
    );
  });

  it('إعادة المحاولة بالمفتاح نفسه تعيد الرقم الأصلي دون تكرار الرد أو نسخ الملفات؛ ومحتوى مختلف ⇒ 409', async () => {
    const files = await fileCount();
    const stored = (await storedFiles()).length;
    const replay = await pub.submit(publicId, submitBody).expect(200);
    expect(replay.body.referenceCode).toBe(referenceCode);
    expect(await prisma.formResponse.count({ where: { formId } })).toBe(1);
    expect(await fileCount()).toBe(files);
    expect((await storedFiles()).length).toBe(stored);
    const different = {
      ...submitBody,
      answers: [submitBody.answers[0], { questionId: qDocs, value: [accepted.pdf] }],
    };
    expect((await pub.submit(publicId, different).expect(409)).body.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    // ملف مرتبط لا يُزال ولا يُستخدم في رد آخر
    await pub.remove(publicId, token, accepted.pdf!).expect(404);
    const reuse = await pub
      .submit(publicId, {
        versionId: form.versionId,
        fillSession: token,
        idempotencyKey: randomUUID(),
        answers: [
          { questionId: qName, value: 'خالد' },
          { questionId: qDocs, value: [accepted.pdf!] },
        ],
      })
      .expect(400);
    expect(reuse.body.code).toBe('VALIDATION_FAILED');
  });

  it('التفاصيل تعرض الملفات، والتنزيل بصلاحية مستقلة وبرؤوس آمنة، ولا وصول لملف رد آخر', async () => {
    const url = `/api/forms/${formId}/responses/${responseId}`;
    const detail = (await as(viewer).get(url).expect(200)).body;
    const docs = detail.answers.find((a: any) => a.title === 'المستندات');
    expect(docs.kind).toBe('files');
    expect(docs.files.map((f: any) => f.name)).toEqual([
      'تقرير.pdf',
      'صورة.jpg',
      'شعار.png',
      'صورة.webp',
      'خطاب.docx',
      'جدول.xlsx',
      'ملاحظات.txt',
    ]);
    expect(JSON.stringify(detail)).not.toMatch(/[a-f0-9]{64}/); // لا مفاتيح تخزين
    expect(detail.answers.find((a: any) => a.title === 'السيرة').kind).toBe('empty');

    const fileUrl = `${url}/files/${accepted.pdf}`;
    expect((await as(viewer).get(fileUrl).expect(403)).body.code).toBe('FORBIDDEN');
    await request(app.getHttpServer()).get(fileUrl).expect(401);
    const dl = await as(downloader)
      .get(fileUrl)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(dl.body as Buffer, samples.pdf())).toBe(0);
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['content-disposition']).toBe(
      `attachment; filename="_____.pdf"; filename*=UTF-8''${encodeURIComponent('تقرير.pdf')}`,
    );
    expect(dl.headers['cache-control']).toBe('no-store, private');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-security-policy']).toContain('sandbox');
    await as(admin).get(fileUrl).expect(200);
    // ملف لا يخص هذا الرد، أو عبر نموذج آخر، أو معرّف عشوائي
    const loose = (await prisma.uploadedFile.findFirst({ where: { formId, responseId: null } }))!
      .id;
    await as(admin).get(`${url}/files/${loose}`).expect(404);
    await as(admin)
      .get(`/api/forms/${otherFormId}/responses/${responseId}/files/${accepted.pdf}`)
      .expect(404);
    await as(admin).get(`${url}/files/${randomUUID()}`).expect(404);
    const audit = await prisma.auditLog.count({
      where: { action: 'response.file_downloaded', entityId: responseId },
    });
    expect(audit).toBe(2);
  });

  it('CSV يضيف أسماء الملفات فقط', async () => {
    const res = await as(admin).get(`/api/forms/${formId}/responses/export`).expect(200);
    expect(res.text).toContain('تقرير.pdf، صورة.jpg، شعار.png');
    expect(res.text).not.toMatch(/[a-f0-9]{64}/);
    expect(res.text).not.toContain(uploadDir);
  });

  it('إزالة ملف قبل الإرسال تحذفه من القاعدة والتخزين', async () => {
    const s = (await pub.session(publicId).expect(201)).body.token;
    const id = (await pub.upload(publicId, s, qCv, 'cv.pdf', samples.pdf()).expect(201)).body.id;
    const key = (await prisma.uploadedFile.findUnique({ where: { id } }))!.storageKey;
    await pub.remove(publicId, s, id).expect(204);
    expect(await fileCount({ id })).toBe(0);
    expect(await storedFiles()).not.toContain(key);
  });

  it('رفع مقطوع لا يترك أجزاء ولا سجلات', async () => {
    const server = app.getHttpServer();
    if (!server.listening) await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    const s = (await pub.session(publicId).expect(201)).body.token;
    const before = await fileCount();
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/api/public/forms/${publicId}/files?questionId=${qCv}`,
        headers: {
          Origin: ORIGIN,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(900 * 1024),
          'x-fill-session': s,
          'x-file-name': 'cut.pdf',
        },
      });
      req.on('error', () => resolve());
      req.write(Buffer.concat([samples.pdf(), Buffer.alloc(100 * 1024, 0x20)]));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 300);
    });
    for (let i = 0; i < 20 && (await readdir(join(uploadDir, 'tmp'))).length; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await readdir(join(uploadDir, 'tmp'))).toEqual([]);
    expect(await fileCount()).toBe(before);
  });

  it('التنظيف: يحذف المؤقت المنتهي فقط ولا يمس ملفات الردود، ويتعامل بأمان مع الإرسال المتزامن', async () => {
    const uploads = app.get(UploadsService);
    const s = (await pub.session(publicId).expect(201)).body.token;
    const stale = (await pub.upload(publicId, s, qCv, 'old.pdf', samples.pdf()).expect(201)).body
      .id;
    const staleKey = (await prisma.uploadedFile.findUnique({ where: { id: stale } }))!.storageKey;
    await prisma.uploadedFile.update({
      where: { id: stale },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const attachedBefore = await fileCount({ responseId: { not: null } });
    const r = await uploads.cleanup();
    expect(r.files).toBeGreaterThanOrEqual(1);
    expect(await fileCount({ id: stale })).toBe(0);
    expect(await storedFiles()).not.toContain(staleKey);
    expect(await fileCount({ responseId: { not: null } })).toBe(attachedBefore);
    for (const f of await prisma.uploadedFile.findMany({ where: { responseId: { not: null } } })) {
      expect(await storedFiles()).toContain(f.storageKey);
    }

    // سباق الإرسال والتنظيف: أيهما فاز، لا يوجد ملف مرتبط برد دون محتواه في التخزين
    for (let i = 0; i < 5; i++) {
      const t = (await pub.session(publicId).expect(201)).body.token;
      const fid = (await pub.upload(publicId, t, qDocs, `r${i}.pdf`, samples.pdf()).expect(201))
        .body.id;
      const soon = new Date(Date.now() + 300);
      await prisma.uploadedFile.update({ where: { id: fid }, data: { expiresAt: soon } });
      const later = new Date(Date.now() + 5000);
      const [sub] = await Promise.all([
        pub.submit(publicId, {
          versionId: form.versionId,
          fillSession: t,
          idempotencyKey: randomUUID(),
          answers: [
            { questionId: qName, value: `سباق ${i}` },
            { questionId: qDocs, value: [fid] },
          ],
        }),
        uploads.cleanup(later),
      ]);
      const row = await prisma.uploadedFile.findUnique({ where: { id: fid } });
      if (sub.status === 201) {
        expect(row?.responseId).toBeTruthy();
        expect(await storedFiles()).toContain(row!.storageKey);
      } else {
        expect(sub.status).toBe(400);
        expect(row).toBeNull();
      }
    }
  }, 60_000);

  it('جلسة إصدار قديم ⇒ VERSION_OUTDATED، والإصدارات والردود القديمة لا تتأثر', async () => {
    const s = (await pub.session(publicId).expect(201)).body.token;
    const draft = (await as(admin).get(`/api/forms/${formId}/draft`).expect(200)).body;
    await as(admin)
      .put(`/api/forms/${formId}/draft`, {
        revision: draft.revision,
        title: draft.title,
        questions: draft.questions.map((q: any) => ({
          id: q.id,
          type: q.type,
          title: q.title === 'الاسم' ? 'الاسم الكامل' : q.title,
          description: q.description,
          required: q.required,
          settings: q.settings,
          options: q.options.map((o: any) => ({ id: o.id, label: o.label })),
        })),
      })
      .expect(200);
    const d2 = (await as(admin).get(`/api/forms/${formId}/draft`).expect(200)).body;
    await as(admin)
      .post(`/api/forms/${formId}/publish`, { revision: d2.revision, publishKey: randomUUID() })
      .expect(200);
    expect((await pub.upload(publicId, s, qCv, 'a.pdf', samples.pdf()).expect(409)).body.code).toBe(
      'VERSION_OUTDATED',
    );
    const old = (await as(admin).get(`/api/forms/${formId}/responses/${responseId}`).expect(200))
      .body;
    expect(old.version.versionNumber).toBe(1);
    expect(old.answers[0].title).toBe('الاسم');
    expect(old.answers.find((a: any) => a.title === 'المستندات').files).toHaveLength(7);
  });

  it('البيانات والملفات محفوظة بعد إعادة تشغيل التطبيق', async () => {
    await app.close();
    app = await startApp();
    admin = await login(ADMIN);
    await as(admin)
      .get(`/api/forms/${formId}/responses/${responseId}/files/${accepted.png}`)
      .expect(200);
  });

  it('دون فاحص مضبوط: الرفع 503 ونشر سؤال الملفات ممنوع بسبب واضح', async () => {
    await app.close();
    app = await startApp({ CLAMAV_HOST: undefined });
    admin = await login(ADMIN);
    expect((await pub.session(publicId).expect(503)).body.code).toBe('UPLOADS_UNAVAILABLE');
    const id = (await as(admin).post('/api/forms', { title: 'دون فاحص' }).expect(201)).body.id;
    await as(admin)
      .put(`/api/forms/${id}/draft`, {
        revision: 1,
        title: 'دون فاحص',
        questions: [
          {
            type: 'FILE_UPLOAD',
            title: 'ملف',
            required: false,
            settings: { allowedTypes: ['pdf'], maxFileSizeMb: 1, maxFiles: 1 },
          },
        ],
      })
      .expect(200);
    const blocked = await as(admin)
      .post(`/api/forms/${id}/publish`, { revision: 2, publishKey: randomUUID() })
      .expect(409);
    expect(blocked.body.details.reasons[0]).toMatch(/رفع الملفات غير مفعّل/);
  });

  it('UPLOAD_SCAN_MODE=disabled: الرفع دون فاحص مع بقاء قيود النوع والحجم، والملفات معلّمة «غير مفحوصة»', async () => {
    await app.close();
    app = await startApp({ CLAMAV_HOST: undefined, UPLOAD_SCAN_MODE: 'disabled' });
    admin = await login(ADMIN);
    const created = await createPublished('نموذج دون فاحص', [
      {
        type: 'FILE_UPLOAD',
        title: 'مرفق',
        required: true,
        settings: { allowedTypes: ['pdf', 'png', 'txt'], maxFileSizeMb: 1, maxFiles: 3 },
      },
    ]);
    const f = await pub.form(created.publicId);
    expect(f.fileScanning).toBe(false);
    const q = f.questions[0].id;
    const token = (await pub.session(created.publicId).expect(201)).body.token;
    const pdf = (await pub.upload(created.publicId, token, q, 'a.pdf', samples.pdf()).expect(201))
      .body;
    const png = (await pub.upload(created.publicId, token, q, 'b.png', samples.png()).expect(201))
      .body;
    // التحقق من النوع والامتداد والحجم ما زال مطبقًا
    expect(
      (await pub.upload(created.publicId, token, q, 'c.exe', samples.pdf()).expect(400)).body.code,
    ).toBe('FILE_REJECTED');
    expect(
      (await pub.upload(created.publicId, token, q, 'd.pdf', samples.png()).expect(400)).body.code,
    ).toBe('FILE_REJECTED');
    const big = Buffer.concat([samples.pdf(), Buffer.alloc(1024 * 1024 + 10, 0x20)]);
    expect(
      (await pub.upload(created.publicId, token, q, 'big.pdf', big).expect(413)).body.code,
    ).toBe('FILE_TOO_LARGE');
    // لا فحص برمجيات خبيثة في هذا الوضع: سلسلة EICAR داخل ملف نصي صالح تُقبل وتُعلَّم غير مفحوصة
    const eicar = (
      await pub.upload(created.publicId, token, q, 'e.txt', samples.eicar()).expect(201)
    ).body;
    const rows = await prisma.uploadedFile.findMany({
      where: { id: { in: [pdf.id, png.id, eicar.id] } },
    });
    expect(rows.every((r) => r.scanEngine === 'not-scanned:UPLOAD_SCAN_MODE=disabled')).toBe(true);
    const sub = await pub
      .submit(created.publicId, {
        versionId: f.versionId,
        fillSession: token,
        idempotencyKey: randomUUID(),
        answers: [{ questionId: q, value: [pdf.id, png.id] }],
      })
      .expect(201);
    const resp = await prisma.formResponse.findUnique({
      where: { referenceCode: sub.body.referenceCode },
    });
    const detail = (
      await as(admin).get(`/api/forms/${created.id}/responses/${resp!.id}`).expect(200)
    ).body;
    const files = detail.answers[0].files;
    expect(files.map((x: any) => [x.name, x.malwareScanned])).toEqual([
      ['a.pdf', false],
      ['b.png', false],
    ]);
    await as(admin)
      .get(`/api/forms/${created.id}/responses/${resp!.id}/files/${pdf.id}`)
      .expect(200);
    await as(viewer)
      .get(`/api/forms/${created.id}/responses/${resp!.id}/files/${pdf.id}`)
      .expect(403);
  });
});
