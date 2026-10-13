import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV, AppEnv } from '../config/env';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthContext } from './auth-context';
import type { RequestMeta } from './decorators';
import type { MeDto } from './dto';
import {
  hashPassword,
  normalizeUsername,
  passwordPolicyError,
  verifyAgainstDummy,
  verifyPassword,
} from './password';
import { effectivePermissions } from './permissions';
import { IssuedSession, SessionService } from './session.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async login(
    rawUsername: string,
    password: string,
    meta: RequestMeta,
  ): Promise<{ me: MeDto; session: IssuedSession }> {
    const username = normalizeUsername(rawUsername);
    const user = await this.prisma.user.findUnique({
      where: { username },
      include: { permissions: { select: { permission: true } } },
    });

    // الحساب المحذوف يُعامل كأنه غير موجود.
    if (!user || user.deletedAt) {
      await verifyAgainstDummy(password);
      throw Errors.invalidCredentials();
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw Errors.loginLocked();
    }

    if (!(await verifyPassword(user.passwordHash, password))) {
      await this.registerFailure(user.id, meta);
      throw Errors.invalidCredentials();
    }

    if (!user.isActive) {
      await this.audit.record({
        actorId: user.id,
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: user.id,
        details: { reason: 'inactive' },
        ipAddress: meta.ipAddress,
      });
      throw Errors.invalidCredentials();
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    const session = await this.sessions.issue(user.id, meta);
    await this.audit.record({
      actorId: user.id,
      action: 'auth.login',
      entityType: 'session',
      entityId: session.sessionId,
      ipAddress: meta.ipAddress,
    });

    return {
      session,
      me: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        permissions: effectivePermissions(
          user.role,
          user.permissions.map((p) => p.permission),
        ),
      },
    };
  }

  private async registerFailure(userId: string, meta: RequestMeta): Promise<void> {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    const locked = updated.failedLoginCount >= this.env.LOGIN_MAX_FAILURES;
    if (locked) {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: 0,
          lockedUntil: new Date(Date.now() + this.env.LOGIN_LOCK_MINUTES * 60_000),
        },
      });
    }
    await this.audit.record({
      actorId: userId,
      action: locked ? 'auth.login_locked' : 'auth.login_failed',
      entityType: 'user',
      entityId: userId,
      details: { reason: 'bad_password' },
      ipAddress: meta.ipAddress,
    });
  }

  async logout(auth: AuthContext, meta: RequestMeta): Promise<void> {
    await this.sessions.revoke(auth.sessionId, 'logout');
    await this.audit.record({
      actorId: auth.userId,
      action: 'auth.logout',
      entityType: 'session',
      entityId: auth.sessionId,
      ipAddress: meta.ipAddress,
    });
  }

  me(auth: AuthContext): MeDto {
    return {
      id: auth.userId,
      username: auth.username,
      displayName: auth.displayName,
      role: auth.role,
      permissions: auth.permissions,
    };
  }

  /** يغيّر كلمة مرور المستخدم الحالي ويبطل كل جلساته الأخرى، ويُبقي الجلسة الحالية. */
  async changePassword(
    auth: AuthContext,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw Errors.validation([
        { field: 'currentPassword', message: 'كلمة المرور الحالية غير صحيحة.' },
      ]);
    }
    const policy = passwordPolicyError(newPassword, user.username);
    if (policy) throw Errors.validation([{ field: 'newPassword', message: policy }]);
    if (await verifyPassword(user.passwordHash, newPassword)) {
      throw Errors.validation([
        { field: 'newPassword', message: 'كلمة المرور الجديدة يجب أن تختلف عن الحالية.' },
      ]);
    }

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, passwordChangedAt: new Date() },
      });
      const revoked = await this.sessions.revokeAllForUser(user.id, 'password_changed', {
        exceptSessionId: auth.sessionId,
        db: tx,
      });
      await this.audit.record(
        {
          actorId: user.id,
          action: 'auth.password_changed',
          entityType: 'user',
          entityId: user.id,
          details: { revokedSessions: revoked },
          ipAddress: meta.ipAddress,
        },
        tx,
      );
    });
  }
}
