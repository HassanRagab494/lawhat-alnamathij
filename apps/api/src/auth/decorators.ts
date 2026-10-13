import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Permission } from '@prisma/client';
import type { Request } from 'express';
import type { AuthContext } from './auth-context';
import { Errors } from '../common/errors';

export const IS_PUBLIC = 'auth:isPublic';
export const REQUIRED_PERMISSIONS = 'auth:permissions';
export const ADMIN_ONLY = 'auth:adminOnly';

/** مسار لا يتطلب جلسة (تسجيل الدخول وفحص الحالة فقط). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** يتطلب كل الصلاحيات المذكورة. مدير النظام يتجاوزها دائمًا. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/** متاح لمدير النظام فقط. */
export const AdminOnly = () => SetMetadata(ADMIN_ONLY, true);

export const CurrentAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.auth) throw Errors.unauthenticated();
    return req.auth;
  },
);

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

export const RequestMetaData = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RequestMeta => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return {
      ipAddress: req.ip ? req.ip.slice(0, 45) : null,
      userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
    };
  },
);
