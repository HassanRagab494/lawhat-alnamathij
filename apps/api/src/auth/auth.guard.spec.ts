import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission, UserRole } from '@prisma/client';
import type { AppEnv } from '../config/env';
import { AuthGuard } from './auth.guard';
import { ADMIN_ONLY, IS_PUBLIC, REQUIRED_PERMISSIONS } from './decorators';
import type { ResolvedSession, SessionService } from './session.service';
import { sha256 } from './tokens';

const env = { WEB_ORIGIN: 'http://localhost:3000' } as AppEnv;
const CSRF = 'csrf-token-value';

function resolved(role: UserRole, permissions: Permission[]): ResolvedSession {
  return {
    csrfTokenHash: sha256(CSRF),
    auth: {
      sessionId: 's1',
      userId: 'u1',
      username: 'sara',
      displayName: 'سارة',
      role,
      permissions,
    },
  };
}

function handlerWith(metadata: Record<string, unknown>): () => void {
  const handler = () => undefined;
  for (const [key, value] of Object.entries(metadata)) Reflect.defineMetadata(key, value, handler);
  return handler;
}

function context(
  req: { method: string; cookies?: Record<string, string>; headers?: Record<string, string> },
  handler: () => void,
): { ctx: ExecutionContext; request: Record<string, unknown> } {
  const headers = Object.fromEntries(
    Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const request: Record<string, unknown> = {
    method: req.method,
    cookies: req.cookies ?? {},
    get: (name: string) => headers[name.toLowerCase()],
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  return { ctx, request };
}

async function statusOf(promise: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return (error as HttpException).getStatus();
  }
}

describe('AuthGuard', () => {
  let resolve: jest.Mock;
  let guard: AuthGuard;

  beforeEach(() => {
    resolve = jest.fn();
    guard = new AuthGuard(new Reflector(), { resolve } as unknown as SessionService, env);
  });

  it('يسمح بالمسارات العامة دون جلسة', async () => {
    const { ctx } = context({ method: 'GET' }, handlerWith({ [IS_PUBLIC]: true }));
    expect(await statusOf(guard.canActivate(ctx))).toBe('ok');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('يرفض الطلب المعدِّل من Origin أجنبي حتى على المسار العام', async () => {
    const { ctx } = context(
      { method: 'POST', headers: { origin: 'https://evil.example' } },
      handlerWith({ [IS_PUBLIC]: true }),
    );
    expect(await statusOf(guard.canActivate(ctx))).toBe(403);
  });

  it('401 دون Cookie جلسة', async () => {
    const { ctx } = context({ method: 'GET' }, handlerWith({}));
    expect(await statusOf(guard.canActivate(ctx))).toBe(401);
  });

  it('401 لجلسة ملغاة أو منتهية أو لمستخدم معطل (resolve يعيد null)', async () => {
    resolve.mockResolvedValue(null);
    const { ctx } = context({ method: 'GET', cookies: { lp_session: 'x' } }, handlerWith({}));
    expect(await statusOf(guard.canActivate(ctx))).toBe(401);
  });

  it('403 لطلب معدِّل دون رمز CSRF صحيح', async () => {
    resolve.mockResolvedValue(resolved(UserRole.ADMIN, []));
    const missing = context({ method: 'POST', cookies: { lp_session: 'x' } }, handlerWith({}));
    expect(await statusOf(guard.canActivate(missing.ctx))).toBe(403);
    const wrong = context(
      { method: 'POST', cookies: { lp_session: 'x' }, headers: { 'x-csrf-token': 'nope' } },
      handlerWith({}),
    );
    expect(await statusOf(guard.canActivate(wrong.ctx))).toBe(403);
  });

  it('يقبل طلبًا معدِّلًا برمز CSRF صحيح ويضع سياق المصادقة', async () => {
    resolve.mockResolvedValue(resolved(UserRole.ADMIN, []));
    const { ctx, request } = context(
      {
        method: 'POST',
        cookies: { lp_session: 'x' },
        headers: { 'x-csrf-token': CSRF, origin: 'http://localhost:3000' },
      },
      handlerWith({}),
    );
    expect(await statusOf(guard.canActivate(ctx))).toBe('ok');
    expect((request.auth as { userId: string }).userId).toBe('u1');
  });

  it('403 لمشرف على مسار للمدير فقط', async () => {
    resolve.mockResolvedValue(resolved(UserRole.SUPERVISOR, [Permission.FORMS_VIEW]));
    const { ctx } = context(
      { method: 'GET', cookies: { lp_session: 'x' } },
      handlerWith({ [ADMIN_ONLY]: true }),
    );
    expect(await statusOf(guard.canActivate(ctx))).toBe(403);
  });

  it('403 لمشرف لا يملك الصلاحية المطلوبة، ويقبل من يملكها', async () => {
    const handler = handlerWith({ [REQUIRED_PERMISSIONS]: [Permission.FORMS_EDIT] });
    resolve.mockResolvedValue(resolved(UserRole.SUPERVISOR, [Permission.FORMS_VIEW]));
    expect(
      await statusOf(
        guard.canActivate(context({ method: 'GET', cookies: { lp_session: 'x' } }, handler).ctx),
      ),
    ).toBe(403);

    resolve.mockResolvedValue(
      resolved(UserRole.SUPERVISOR, [Permission.FORMS_VIEW, Permission.FORMS_EDIT]),
    );
    expect(
      await statusOf(
        guard.canActivate(context({ method: 'GET', cookies: { lp_session: 'x' } }, handler).ctx),
      ),
    ).toBe('ok');
  });
});
