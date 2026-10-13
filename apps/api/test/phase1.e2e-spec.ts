import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { BootstrapError, createInitialAdmin } from '../src/cli/create-admin';
import { loadEnv } from '../src/config/env';

/**
 * تحقق المرحلة الأولى من طرف إلى طرف: HTTP حقيقي -> NestJS -> Prisma -> MySQL.
 * الاختبارات متسلسلة وتعتمد على حالة القاعدة التي يبنيها كل اختبار للذي يليه.
 */

const ORIGIN = 'http://localhost:3000';
const ADMIN = { username: 'site.admin', displayName: 'مدير النظام', password: 'Admin-pass-2026!' };
const SUP = { username: 'sara.ali', displayName: 'سارة علي', password: 'Sara-pass-2026!' };

let app: NestExpressApplication;
let prisma: PrismaClient;

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
  const cookie = res.headers['set-cookie'] as unknown as string[];
  return { cookie, csrf: res.body.csrfToken, userId: res.body.user.id };
}

function as(session: Session) {
  const server = app.getHttpServer();
  const withAuth = (req: request.Test) =>
    req.set('Cookie', session.cookie).set('Origin', ORIGIN).set('x-csrf-token', session.csrf);
  return {
    get: (url: string) => request(server).get(url).set('Cookie', session.cookie),
    post: (url: string, body?: object) => withAuth(request(server).post(url)).send(body ?? {}),
    patch: (url: string, body: object) => withAuth(request(server).patch(url)).send(body),
    delete: (url: string) => withAuth(request(server).delete(url)),
  };
}

beforeAll(async () => {
  prisma = new PrismaClient();
  app = await startApp();
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
});

describe('المرحلة الأولى', () => {
  let admin: Session;
  let sup: Session;
  let supId: string;
  let formId: string;

  it('فحص الحالة يعيد حالة قاعدة البيانات', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
  });

  it('إنشاء المدير الأول بأمر الإعداد، ورفض تكراره', async () => {
    const created = await createInitialAdmin(prisma, ADMIN);
    expect(created.username).toBe(ADMIN.username);
    await expect(
      createInitialAdmin(prisma, { ...ADMIN, username: 'second.admin' }),
    ).rejects.toBeInstanceOf(BootstrapError);
    const stored = await prisma.user.findUniqueOrThrow({ where: { username: ADMIN.username } });
    expect(stored.passwordHash).not.toContain(ADMIN.password);
  });

  it('رفض الطلبات غير المصرح بها من الـ Backend', async () => {
    const server = app.getHttpServer();
    for (const url of ['/api/forms', '/api/users', '/api/auth/me', '/api/dashboard/summary']) {
      const res = await request(server).get(url).expect(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
    }
    await request(server).post('/api/forms').send({ title: 'x' }).expect(401);
    await request(server).get('/api/forms').set('Cookie', 'lp_session=forged').expect(401);
  });

  it('رفض بيانات دخول خاطئة برسالة عامة', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: ADMIN.username, password: 'wrong-password-1' })
      .expect(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expect(res.body.message).toMatch(/غير صحيحة/);
  });

  it('تسجيل دخول المدير بجلسة HttpOnly', async () => {
    admin = await login(ADMIN.username, ADMIN.password);
    const sessionCookie = admin.cookie.find((c) => c.startsWith('lp_session='))!;
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    const me = await as(admin).get('/api/auth/me').expect(200);
    expect(me.body).toMatchObject({ username: ADMIN.username, role: 'ADMIN' });
    expect(me.body.permissions).toEqual([
      'FORMS_VIEW',
      'FORMS_CREATE',
      'FORMS_EDIT',
      'FORMS_ARCHIVE',
    ]);
    // الجلسة مخزنة كتجزئة فقط
    const token = sessionCookie.split(';')[0]!.split('=')[1]!;
    expect(await prisma.session.count({ where: { tokenHash: token } })).toBe(0);
  });

  it('رفض الطلب المعدِّل دون رمز CSRF أو من Origin أجنبي', async () => {
    const server = app.getHttpServer();
    const noCsrf = await request(server)
      .post('/api/forms')
      .set('Cookie', admin.cookie)
      .send({ title: 'x' })
      .expect(403);
    expect(noCsrf.body.code).toBe('CSRF_INVALID');
    await request(server)
      .post('/api/forms')
      .set('Cookie', admin.cookie)
      .set('x-csrf-token', admin.csrf)
      .set('Origin', 'https://evil.example')
      .send({ title: 'x' })
      .expect(403);
  });

  it('المدير ينشئ مشرفًا ويحدد صلاحياته، مع رفض الإدخال غير الصحيح', async () => {
    const bad = await as(admin)
      .post('/api/users', {
        username: 'x',
        displayName: '',
        password: 'short',
        permissions: ['NOPE'],
      })
      .expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    expect(bad.body.fields.map((f: { field: string }) => f.field)).toEqual(
      expect.arrayContaining(['username', 'displayName', 'permissions']),
    );
    expect(bad.body.fields.every((f: { message: string }) => /[؀-ۿ]/.test(f.message))).toBe(true);

    const weak = await as(admin)
      .post('/api/users', { ...SUP, password: 'short', permissions: ['FORMS_VIEW'] })
      .expect(400);
    expect(weak.body.fields[0].field).toBe('password');

    const prereq = await as(admin)
      .post('/api/users', { ...SUP, permissions: ['FORMS_EDIT'] })
      .expect(400);
    expect(prereq.body.fields[0].message).toMatch(/عرض النماذج/);

    const created = await as(admin)
      .post('/api/users', { ...SUP, username: 'Sara.Ali', permissions: ['FORMS_VIEW'] })
      .expect(201);
    expect(created.body).toMatchObject({
      username: 'sara.ali',
      role: 'SUPERVISOR',
      isActive: true,
      permissions: ['FORMS_VIEW'],
    });
    expect(created.body.passwordHash).toBeUndefined();
    supId = created.body.id;

    const dup = await as(admin)
      .post('/api/users', { ...SUP, permissions: ['FORMS_VIEW'] })
      .expect(409);
    expect(dup.body.code).toBe('USERNAME_TAKEN');
  });

  it('المدير ينشئ نموذجًا كمسودة غير منشورة', async () => {
    const res = await as(admin)
      .post('/api/forms', { title: '  نموذج طلب خدمة  ', description: 'وصف أولي' })
      .expect(201);
    expect(res.body).toMatchObject({
      title: 'نموذج طلب خدمة',
      description: 'وصف أولي',
      publicationStatus: 'draft',
      isArchived: false,
      revision: 1,
      createdBy: { displayName: ADMIN.displayName },
    });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    formId = res.body.id;

    const invalid = await as(admin).post('/api/forms', { title: '' }).expect(400);
    expect(invalid.body.fields).toEqual([{ field: 'title', message: 'عنوان النموذج مطلوب.' }]);
  });

  it('المشرف لا يتجاوز صلاحياته بطلب مباشر', async () => {
    sup = await login(SUP.username, SUP.password);
    const api = as(sup);
    await api.get('/api/forms').expect(200);
    await api.get(`/api/forms/${formId}`).expect(200);
    expect((await api.post('/api/forms', { title: 'محاولة' }).expect(403)).body.code).toBe(
      'FORBIDDEN',
    );
    await api.patch(`/api/forms/${formId}`, { title: 'محاولة', revision: 1 }).expect(403);
    await api.post(`/api/forms/${formId}/archive`).expect(403);
    await api.get('/api/users').expect(403);
    await api.post('/api/users', { ...SUP, username: 'evil.user', permissions: [] }).expect(403);
    await api
      .patch(`/api/users/${supId}`, { permissions: ['FORMS_VIEW', 'FORMS_EDIT'] })
      .expect(403);
    await api
      .post(`/api/users/${supId}/reset-password`, { newPassword: 'Another-pass-1' })
      .expect(403);

    const summary = await api.get('/api/dashboard/summary').expect(200);
    expect(summary.body.forms).toEqual({ active: 1, archived: 0 });
    expect(summary.body.users).toBeUndefined();
  });

  it('تغيير الصلاحيات يسري فورًا على جلسة المشرف القائمة', async () => {
    await as(admin)
      .patch(`/api/users/${supId}`, {
        displayName: 'سارة علي الأحمد',
        permissions: ['FORMS_VIEW', 'FORMS_CREATE', 'FORMS_EDIT'],
      })
      .expect(200);
    const created = await as(sup).post('/api/forms', { title: 'نموذج المشرف' }).expect(201);
    expect(created.body.createdBy.displayName).toBe('سارة علي الأحمد');

    await as(admin)
      .patch(`/api/users/${supId}`, { permissions: ['FORMS_VIEW'] })
      .expect(200);
    await as(sup).post('/api/forms', { title: 'بعد السحب' }).expect(403);
    const me = await as(sup).get('/api/auth/me').expect(200);
    expect(me.body.permissions).toEqual(['FORMS_VIEW']);

    // إعادة صلاحية التعديل لاختبار التزامن
    await as(admin)
      .patch(`/api/users/${supId}`, { permissions: ['FORMS_VIEW', 'FORMS_EDIT', 'FORMS_ARCHIVE'] })
      .expect(200);
  });

  it('حساب مدير النظام محمي من إدارة المستخدمين', async () => {
    const res = await as(admin).post(`/api/users/${admin.userId}/deactivate`).expect(403);
    expect(res.body.code).toBe('ADMIN_ACCOUNT_PROTECTED');
  });

  it('البحث والتصفية وترقيم الصفحات في قائمة النماذج', async () => {
    const search = await as(admin).get('/api/forms?search=طلب').expect(200);
    expect(search.body.items.map((f: { id: string }) => f.id)).toEqual([formId]);
    const page = await as(admin).get('/api/forms?pageSize=1&page=2').expect(200);
    expect(page.body.meta).toMatchObject({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
    expect(page.body.items).toHaveLength(1);
    const bad = await as(admin).get('/api/forms?status=deleted&pageSize=500').expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    await as(admin).get('/api/forms/not-a-uuid').expect(404);
    await as(admin).get('/api/forms/0190d6b4-0000-7000-8000-000000000000').expect(404);
  });

  it('التعديل المتزامن لا يكتب بصمت فوق تعديل أحدث', async () => {
    const first = await as(admin)
      .patch(`/api/forms/${formId}`, {
        title: 'عنوان المدير',
        description: 'وصف المدير',
        revision: 1,
      })
      .expect(200);
    expect(first.body.revision).toBe(2);

    // المشرف فتح النسخة 1 قبل حفظ المدير
    const stale = await as(sup)
      .patch(`/api/forms/${formId}`, { title: 'عنوان المشرف', revision: 1 })
      .expect(409);
    expect(stale.body.code).toBe('REVISION_CONFLICT');
    expect(stale.body.details.current).toMatchObject({ title: 'عنوان المدير', revision: 2 });

    // طلبان متزامنان على نفس المراجعة: ينجح واحد فقط
    const results = await Promise.all([
      as(admin).patch(`/api/forms/${formId}`, { title: 'متزامن أ', revision: 2 }),
      as(sup).patch(`/api/forms/${formId}`, { title: 'متزامن ب', revision: 2 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const stored = await prisma.formDraft.findUniqueOrThrow({ where: { formId } });
    expect(stored.revision).toBe(3);
    const winner = results.find((r) => r.status === 200)!;
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.code).toBe('REVISION_CONFLICT');
    expect(loser.body.details.current).toMatchObject({
      revision: 3,
      title: winner.body.title,
      description: winner.body.description,
    });
  });

  it('archive holds parent lock until commit and waiting edit is rejected', async () => {
    const audit = app.get(AuditService);
    const original = audit.record.bind(audit);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const locked = new Promise<void>((r) => {
      entered = r;
    });
    const spy = jest.spyOn(audit, 'record').mockImplementation(async (event, tx) => {
      if (event.action === 'form.archived' && event.entityId === formId) {
        entered();
        await held;
      }
      return original(event, tx);
    });
    const archiving = as(admin)
      .post(`/api/forms/${formId}/archive`)
      .then((r) => r);
    let editing: Promise<request.Response> | undefined;
    let transactionSpy: jest.SpyInstance | undefined;
    try {
      await locked; // Archive has changed the row but has not committed.
      transactionSpy = jest.spyOn(app.get(PrismaService), '$transaction');
      let settled = false;
      editing = as(sup)
        .patch(`/api/forms/${formId}`, { title: 'must not persist', revision: 3 })
        .then((r) => {
          settled = true;
          return r;
        });
      const deadline = Date.now() + 2000;
      while (!transactionSpy.mock.calls.length && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(transactionSpy).toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 50));
      expect(settled).toBe(false);
      release();
      expect((await archiving).status).toBe(200);
      const rejected = await editing;
      expect(rejected.status).toBe(409);
      expect(rejected.body.code).toBe('FORM_ARCHIVED');
      const stored = await prisma.formDraft.findUniqueOrThrow({ where: { formId } });
      expect(stored.revision).toBe(3);
      expect(stored.title).not.toBe('must not persist');
    } finally {
      release();
      await Promise.allSettled([archiving, ...(editing ? [editing] : [])]);
      transactionSpy?.mockRestore();
      spy.mockRestore();
      await as(admin).post(`/api/forms/${formId}/restore`).expect(200);
    }
  });

  it('أرشفة النموذج واستعادته', async () => {
    const archived = await as(sup).post(`/api/forms/${formId}/archive`).expect(200);
    expect(archived.body.isArchived).toBe(true);
    expect(archived.body.archivedAt).not.toBeNull();
    expect((await as(sup).post(`/api/forms/${formId}/archive`).expect(409)).body.code).toBe(
      'FORM_ALREADY_ARCHIVED',
    );
    const edit = await as(admin)
      .patch(`/api/forms/${formId}`, { title: 'تعديل مؤرشف', revision: 3 })
      .expect(409);
    expect(edit.body.code).toBe('FORM_ARCHIVED');

    const active = await as(admin).get('/api/forms').expect(200);
    expect(active.body.items.some((f: { id: string }) => f.id === formId)).toBe(false);
    const list = await as(admin).get('/api/forms?status=archived').expect(200);
    expect(list.body.items.map((f: { id: string }) => f.id)).toEqual([formId]);

    const restored = await as(sup).post(`/api/forms/${formId}/restore`).expect(200);
    expect(restored.body).toMatchObject({ isArchived: false, archivedAt: null });
    await as(admin).post(`/api/forms/${formId}/archive`).expect(200);
  });

  it('البيانات محفوظة بعد إعادة تشغيل التطبيق', async () => {
    await app.close();
    app = await startApp();
    admin = await login(ADMIN.username, ADMIN.password);
    const res = await as(admin).get(`/api/forms/${formId}`).expect(200);
    expect(res.body).toMatchObject({ isArchived: true, revision: 3 });
    expect(['متزامن أ', 'متزامن ب']).toContain(res.body.title);
    // جلسة المشرف القديمة ما زالت صالحة لأنها في القاعدة وليست في الذاكرة
    await as(sup).get('/api/auth/me').expect(200);
  });

  it('تعطيل المستخدم يبطل جلساته ويمنع دخوله، والتفعيل يعيده', async () => {
    await as(admin).post(`/api/users/${supId}/deactivate`).expect(200);
    await as(sup).get('/api/auth/me').expect(401);
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: SUP.username, password: SUP.password })
      .expect(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expect(await prisma.session.count({ where: { userId: supId, revokedAt: null } })).toBe(0);

    await as(admin).post(`/api/users/${supId}/activate`).expect(200);
    sup = await login(SUP.username, SUP.password);
  });

  it('إعادة تعيين كلمة المرور بواسطة المدير تبطل جلسات المشرف', async () => {
    const newPassword = 'Reset-pass-2026!';
    await as(admin).post(`/api/users/${supId}/reset-password`, { newPassword }).expect(204);
    await as(sup).get('/api/auth/me').expect(401);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: SUP.username, password: SUP.password })
      .expect(401);
    sup = await login(SUP.username, newPassword);
    SUP.password = newPassword;
  });

  it('تغيير المستخدم لكلمة مروره يتطلب الحالية ويبطل جلساته الأخرى', async () => {
    const other = await login(SUP.username, SUP.password);
    const wrong = await as(sup)
      .post('/api/auth/change-password', {
        currentPassword: 'wrong-pass-123',
        newPassword: 'New-pass-2026!!',
      })
      .expect(400);
    expect(wrong.body.fields[0]).toEqual({
      field: 'currentPassword',
      message: 'كلمة المرور الحالية غير صحيحة.',
    });
    await as(sup)
      .post('/api/auth/change-password', {
        currentPassword: SUP.password,
        newPassword: 'New-pass-2026!!',
      })
      .expect(204);
    await as(sup).get('/api/auth/me').expect(200);
    await as(other).get('/api/auth/me').expect(401);
    SUP.password = 'New-pass-2026!!';
  });

  it('تسجيل الخروج يبطل الجلسة في الخادم', async () => {
    const res = await as(sup).post('/api/auth/logout').expect(204);
    expect(String(res.headers['set-cookie'])).toMatch(/lp_session=;/);
    // إعادة استخدام Cookie القديمة بعد الخروج تُرفض
    await as(sup).get('/api/auth/me').expect(401);
  });

  it('إيقاف الدخول مؤقتًا بعد محاولات فاشلة متكررة', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 3; i++) {
      await request(server)
        .post('/api/auth/login')
        .send({ username: SUP.username, password: 'wrong-password!' })
        .expect(401);
    }
    const locked = await request(server)
      .post('/api/auth/login')
      .send({ username: SUP.username, password: SUP.password })
      .expect(429);
    expect(locked.body.code).toBe('LOGIN_TEMPORARILY_LOCKED');
    // المدير يعيد تعيين كلمة المرور فيفك الإيقاف
    await as(admin)
      .post(`/api/users/${supId}/reset-password`, { newPassword: 'Unlock-pass-2026!' })
      .expect(204);
    await login(SUP.username, 'Unlock-pass-2026!');
  });

  it('حذف مشرف: يختفي ويُمنع دخوله وتُبطل جلساته، ويبقى سجله', async () => {
    const tempPassword = 'Temp-pass-2026!';
    const created = await as(admin)
      .post('/api/users', {
        username: 'temp.sup',
        displayName: 'مشرف مؤقت',
        password: tempPassword,
        permissions: ['FORMS_VIEW', 'FORMS_CREATE'],
      })
      .expect(201);
    const tempId: string = created.body.id;
    const temp = await login('temp.sup', tempPassword);
    const form = await as(temp).post('/api/forms', { title: 'نموذج المشرف المؤقت' }).expect(201);

    // المشرف لا يستطيع حذف أحد، والمدير لا يُحذف
    await as(temp).delete(`/api/users/${supId}`).expect(403);
    expect((await as(admin).delete(`/api/users/${admin.userId}`).expect(403)).body.code).toBe(
      'ADMIN_ACCOUNT_PROTECTED',
    );
    // CSRF مطلوب للحذف
    await request(app.getHttpServer())
      .delete(`/api/users/${tempId}`)
      .set('Cookie', admin.cookie)
      .expect(403);

    await as(admin).delete(`/api/users/${tempId}`).expect(204);

    await as(temp).get('/api/auth/me').expect(401);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'temp.sup', password: tempPassword })
      .expect(401);
    await as(admin).get(`/api/users/${tempId}`).expect(404);
    await as(admin).delete(`/api/users/${tempId}`).expect(404);
    await as(admin).post(`/api/users/${tempId}/activate`).expect(404);
    const list = await as(admin).get('/api/users').expect(200);
    expect(list.body.items.some((u: { id: string }) => u.id === tempId)).toBe(false);

    // النموذج الذي أنشأه يبقى باسمه، واسم المستخدم يبقى محجوزًا
    const kept = await as(admin).get(`/api/forms/${form.body.id}`).expect(200);
    expect(kept.body.createdBy.displayName).toBe('مشرف مؤقت');
    const reuse = await as(admin)
      .post('/api/users', {
        username: 'temp.sup',
        displayName: 'آخر',
        password: tempPassword,
        permissions: [],
      })
      .expect(409);
    expect(reuse.body.code).toBe('USERNAME_TAKEN');

    // أرشفة نموذج المشرف المؤقت (الملخص النهائي يتوقع نموذجين مؤرشفين)
    await as(admin).post(`/api/forms/${form.body.id}/archive`).expect(200);
  });

  it('سجل العمليات يغطي العمليات المهمة ولا يحتوي أسرارًا', async () => {
    const logs = await prisma.auditLog.findMany();
    const actions = new Set(logs.map((l) => l.action));
    for (const action of [
      'user.bootstrap_admin',
      'user.created',
      'user.updated',
      'user.permissions_changed',
      'user.deactivated',
      'user.activated',
      'user.password_reset',
      'auth.password_changed',
      'auth.login',
      'auth.logout',
      'form.created',
      'form.updated',
      'form.archived',
      'form.restored',
      'user.deleted',
    ]) {
      expect(actions).toContain(action);
    }
    const serialized = JSON.stringify(logs);
    for (const secret of [
      ADMIN.password,
      'Sara-pass-2026!',
      'Reset-pass-2026!',
      'New-pass-2026!!',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toMatch(/scrypt\$/);
  });

  it('ملخص المدير بأرقام حقيقية', async () => {
    const res = await as(admin).get('/api/dashboard/summary').expect(200);
    expect(res.body).toEqual({
      forms: { active: 1, archived: 2 },
      users: { supervisors: 1, activeSupervisors: 1, inactiveSupervisors: 0 },
    });
  });
});
