import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../app.module';
import { SessionService } from '../auth/session.service';
import { sha256 } from '../auth/tokens';
import { configureApp } from '../bootstrap';
import { loadEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { DRAFT_REQUEST_MAX_BYTES, QUESTION_LIMITS as L } from './questions/limits';

/**
 * اختبار HTTP لحدود حجم الطلب دون MySQL: التطبيق الحقيقي بنفس configureApp (المحللان والمرشح والحارس)،
 * مع استبدال طبقة القاعدة والجلسة فقط. طلب المسودة الكبيرة يمر عبر المحلل والتحقق ومنطق الحفظ الفعلي
 * (DraftService.saveDraft وapplyQuestions) حتى استدعاءات الكتابة.
 */

process.env.DATABASE_URL ??= 'mysql://unit:unit@localhost:3306/unit';
process.env.WEB_ORIGIN ??= 'http://localhost:3000';

const ORIGIN = process.env.WEB_ORIGIN;
const CSRF = 'test-csrf-token';
const FORM_ID = '0190d6b4-0000-7000-8000-0000000000f1';
const ARABIC = 'ع'; // 2 بايت في UTF-8

function storedForm() {
  return {
    id: FORM_ID,
    createdById: 'u',
    createdAt: new Date('2026-10-13T00:00:00Z'),
    updatedAt: new Date('2026-10-13T00:00:00Z'),
    archivedAt: null,
    archivedById: null,
    createdBy: { id: 'u', displayName: 'المدير' },
    draft: {
      id: 'd1',
      formId: FORM_ID,
      title: 'نموذج',
      description: null,
      revision: 1,
      updatedById: 'u',
      createdAt: new Date(),
      updatedAt: new Date(),
      questions: [],
    },
  };
}

function largeDraft(char: string, questions = L.maxQuestions) {
  const s = (n: number) => char.repeat(n);
  return {
    revision: 1,
    title: 'نموذج كبير',
    description: s(2000),
    questions: Array.from({ length: questions }, (_, qi) => ({
      type: 'MULTIPLE_CHOICE',
      title: `${qi + 1} ${s(L.questionTitleMax - 5)}`,
      description: s(L.questionDescriptionMax),
      required: false,
      settings: { minSelections: 1, maxSelections: L.maxOptions },
      options: Array.from({ length: L.maxOptions }, (_, oi) => ({
        label: `${oi + 1} ${s(L.optionLabelMax - 5)}`,
      })),
    })),
  };
}

let app: NestExpressApplication;
const writes = { questionsCreated: 0, optionsCreated: 0, revisionBumps: 0, transactions: 0 };

beforeAll(async () => {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    form: {
      findUnique: jest.fn().mockResolvedValue(storedForm()),
      findUniqueOrThrow: jest.fn().mockResolvedValue(storedForm()),
      update: jest.fn(),
    },
    formDraft: {
      updateMany: jest.fn(async () => {
        writes.revisionBumps++;
        return { count: 1 };
      }),
    },
    formDraftQuestion: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn(async () => ({ id: `q${++writes.questionsCreated}` })),
      update: jest.fn(),
    },
    formDraftQuestionOption: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn(async ({ data }: { data: unknown[] }) => {
        writes.optionsCreated += data.length;
        return { count: data.length };
      }),
      update: jest.fn(),
    },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => {
      writes.transactions++;
      return fn(tx);
    }),
    form: { findUnique: jest.fn().mockResolvedValue(storedForm()) },
    $disconnect: jest.fn(),
  };
  const sessions = {
    resolve: jest.fn(async () => ({
      csrfTokenHash: sha256(CSRF),
      auth: {
        sessionId: 's',
        userId: 'u',
        username: 'admin',
        displayName: 'المدير',
        role: UserRole.ADMIN,
        permissions: [],
      },
    })),
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .overrideProvider(SessionService)
    .useValue(sessions)
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: ['error'],
  });
  configureApp(app, loadEnv());
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  Object.assign(writes, {
    questionsCreated: 0,
    optionsCreated: 0,
    revisionBumps: 0,
    transactions: 0,
  });
});

function put(path: string, raw: string) {
  return request(app.getHttpServer())
    .put(path)
    .set('Cookie', 'lp_session=fake')
    .set('Origin', ORIGIN)
    .set('x-csrf-token', CSRF)
    .set('Content-Type', 'application/json')
    .send(raw);
}

describe('حد حجم طلب حفظ المسودة', () => {
  it('مسودة صحيحة بأقصى الحدود بنص عربي (> 1MB) تُقبل وتصل إلى منطق الحفظ', async () => {
    const raw = JSON.stringify(largeDraft(ARABIC));
    const bytes = Buffer.byteLength(raw);
    expect(bytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(bytes).toBeLessThan(DRAFT_REQUEST_MAX_BYTES);

    const res = await put(`/api/forms/${FORM_ID}/draft`, raw);
    expect(res.status).toBe(200);
    expect(writes.transactions).toBe(1);
    expect(writes.questionsCreated).toBe(L.maxQuestions);
    expect(writes.optionsCreated).toBe(L.maxQuestions * L.maxOptions);
    expect(writes.revisionBumps).toBe(1);
  }, 60_000);

  it('نص 3 بايت/حرف بأقصى الحدود (> 3MB) تُقبل أيضًا', async () => {
    const raw = JSON.stringify(largeDraft('ﻻ'));
    // بلا معرّفات (أسئلة جديدة) ≈ 3.25 MiB؛ مع المعرّفات ≈ 3.53 MiB (انظر limits.ts).
    expect(Buffer.byteLength(raw)).toBeGreaterThan(3 * 1024 * 1024);
    const res = await put(`/api/forms/${FORM_ID}/draft`, raw);
    expect(res.status).toBe(200);
    expect(writes.optionsCreated).toBe(L.maxQuestions * L.maxOptions);
  }, 60_000);

  it('طلب يتجاوز الحد الجديد ⇒ 413 برسالة عربية ودون الوصول إلى الحفظ', async () => {
    const raw = JSON.stringify({
      ...largeDraft(ARABIC),
      padding: 'x'.repeat(DRAFT_REQUEST_MAX_BYTES),
    });
    expect(Buffer.byteLength(raw)).toBeGreaterThan(DRAFT_REQUEST_MAX_BYTES);
    const res = await put(`/api/forms/${FORM_ID}/draft`, raw);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message:
        'حجم المسودة يتجاوز الحد المسموح (4 ميغابايت). لم يُحفظ شيء؛ قلّل المحتوى ثم أعد المحاولة.',
    });
    expect(writes.transactions).toBe(0);
  }, 60_000);

  it('بقية المسارات تبقى عند 100KB', async () => {
    const big = JSON.stringify({ title: 'ن', description: 'x'.repeat(150 * 1024) });
    const create = await request(app.getHttpServer())
      .post('/api/forms')
      .set('Cookie', 'lp_session=fake')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', CSRF)
      .set('Content-Type', 'application/json')
      .send(big);
    expect(create.status).toBe(413);
    expect(create.body).toEqual({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'حجم البيانات المرسلة يتجاوز الحد المسموح.',
    });
    const patch = await request(app.getHttpServer())
      .patch(`/api/forms/${FORM_ID}`)
      .set('Cookie', 'lp_session=fake')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', CSRF)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ title: 'ن', revision: 1, description: 'x'.repeat(150 * 1024) }));
    expect(patch.status).toBe(413);
    expect(writes.transactions).toBe(0);
  });

  it('الطلبات الصغيرة على المسارات الأخرى ما زالت تُحلَّل (المحلل العام يعمل بعد محلل المسودة)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/forms')
      .set('Cookie', 'lp_session=fake')
      .set('Origin', ORIGIN)
      .set('x-csrf-token', CSRF)
      .send({ title: '' });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual([{ field: 'title', message: 'عنوان النموذج مطلوب.' }]);
  });
});
