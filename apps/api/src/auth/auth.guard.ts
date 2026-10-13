import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission } from '@prisma/client';
import type { Request } from 'express';
import { APP_ENV, AppEnv } from '../config/env';
import { Errors } from '../common/errors';
import { ADMIN_ONLY, IS_PUBLIC, REQUIRED_PERMISSIONS } from './decorators';
import { isAuthorized } from './permissions';
import { SessionService } from './session.service';
import { CSRF_HEADER, SESSION_COOKIE, csrfMatches } from './tokens';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * حارس عام على كل المسارات (APP_GUARD):
 * 1) يرفض الطلبات المعدِّلة القادمة من Origin غير الواجهة المعتمدة،
 * 2) يتحقق من الجلسة ما لم يكن المسار @Public،
 * 3) يشترط رمز CSRF للطلبات المعدِّلة،
 * 4) يطبق @AdminOnly و@RequirePermissions.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const mutating = !SAFE_METHODS.has(req.method);
    const targets = [context.getHandler(), context.getClass()];

    if (mutating) {
      const origin = req.get('origin');
      if (origin && origin !== this.env.WEB_ORIGIN) throw Errors.csrf();
    }

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length === 0) throw Errors.unauthenticated();

    const resolved = await this.sessions.resolve(token);
    if (!resolved) throw Errors.unauthenticated();

    if (mutating && !csrfMatches(req.get(CSRF_HEADER), resolved.csrfTokenHash)) {
      throw Errors.csrf();
    }

    req.auth = resolved.auth;

    const adminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY, targets) ?? false;
    const permissions =
      this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    if (!isAuthorized(resolved.auth, { adminOnly, permissions })) throw Errors.forbidden();

    return true;
  }
}
