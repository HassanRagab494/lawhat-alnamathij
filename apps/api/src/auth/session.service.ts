import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { APP_ENV, AppEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthContext } from './auth-context';
import { effectivePermissions } from './permissions';
import { CSRF_COOKIE, SESSION_COOKIE, generateToken, sha256 } from './tokens';

export type RevokeReason =
  | 'logout'
  | 'password_changed'
  | 'password_reset'
  | 'user_deactivated'
  | 'user_deleted'
  | 'idle_timeout';

export interface IssuedSession {
  sessionId: string;
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface ResolvedSession {
  auth: AuthContext;
  csrfTokenHash: string;
}

/** تحديث lastSeenAt مرة كل دقيقة على الأكثر لتقليل الكتابة. */
const TOUCH_INTERVAL_MS = 60_000;

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async issue(
    userId: string,
    meta: { ipAddress: string | null; userAgent: string | null },
  ): Promise<IssuedSession> {
    const token = generateToken();
    const csrfToken = generateToken();
    const expiresAt = new Date(Date.now() + this.env.SESSION_TTL_HOURS * 3_600_000);
    const session = await this.prisma.session.create({
      data: {
        userId,
        tokenHash: sha256(token),
        csrfTokenHash: sha256(csrfToken),
        expiresAt,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
      select: { id: true },
    });
    return { sessionId: session.id, token, csrfToken, expiresAt };
  }

  /**
   * يحل رمز الجلسة إلى سياق مصادقة، ويقرأ حالة المستخدم وصلاحياته من القاعدة في كل طلب،
   * لذلك يسري تعطيل المستخدم أو تغيير صلاحياته فورًا على الجلسات القائمة.
   */
  async resolve(token: string): Promise<ResolvedSession | null> {
    if (token.length > 256) return null;
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { include: { permissions: { select: { permission: true } } } } },
    });
    if (!session || session.revokedAt) return null;

    const now = Date.now();
    if (session.expiresAt.getTime() <= now) return null;
    if (now - session.lastSeenAt.getTime() > this.env.SESSION_IDLE_MINUTES * 60_000) {
      await this.revoke(session.id, 'idle_timeout');
      return null;
    }
    if (!session.user.isActive || session.user.deletedAt) return null;

    if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(now) },
      });
    }

    const { user } = session;
    return {
      csrfTokenHash: session.csrfTokenHash,
      auth: {
        sessionId: session.id,
        userId: user.id,
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

  async revoke(sessionId: string, reason: RevokeReason, db: Db = this.prisma): Promise<void> {
    await db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** يبطل كل جلسات المستخدم (عدا جلسة محددة اختياريًا) ويعيد عدد الجلسات الملغاة. */
  async revokeAllForUser(
    userId: string,
    reason: RevokeReason,
    options: { exceptSessionId?: string; db?: Db } = {},
  ): Promise<number> {
    const db = options.db ?? this.prisma;
    const result = await db.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  setCookies(res: Response, issued: IssuedSession): void {
    const base = {
      secure: this.env.COOKIE_SECURE,
      sameSite: 'lax' as const,
      path: '/',
      expires: issued.expiresAt,
    };
    res.cookie(SESSION_COOKIE, issued.token, { ...base, httpOnly: true });
    // رمز CSRF مقروء للواجهة لترسله في ترويسة x-csrf-token (نمط double-submit مرتبط بالجلسة).
    res.cookie(CSRF_COOKIE, issued.csrfToken, { ...base, httpOnly: false });
  }

  clearCookies(res: Response): void {
    const base = { secure: this.env.COOKIE_SECURE, sameSite: 'lax' as const, path: '/' };
    res.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true });
    res.clearCookie(CSRF_COOKIE, base);
  }
}
