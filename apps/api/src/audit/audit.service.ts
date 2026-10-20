import { Global, Injectable, Module } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.login_locked'
  | 'auth.logout'
  | 'auth.password_changed'
  | 'user.bootstrap_admin'
  | 'user.created'
  | 'user.updated'
  | 'user.permissions_changed'
  | 'user.activated'
  | 'user.deactivated'
  | 'user.password_reset'
  | 'user.deleted'
  | 'form.created'
  | 'form.updated'
  | 'form.draft_saved'
  | 'form.published'
  | 'form.responses_opened'
  | 'form.responses_closed'
  | 'form.archived'
  | 'form.restored'
  | 'response.status_changed'
  | 'response.edited'
  | 'response.rejection_share_opened'
  | 'responses.exported'
  | 'response.file_downloaded'
  | 'response.file_previewed'
  | 'response.flowmax_approved'
  | 'response.flowmax_retried'
  | 'response.flowmax_published'
  | 'form.flowmax_mapping_updated';

export interface AuditEntry {
  actorId: string | null;
  action: AuditAction;
  entityType: 'user' | 'form' | 'session' | 'response';
  entityId?: string | null;
  /** لا تضع هنا أي كلمة مرور أو رمز أو تجزئة. */
  details?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}

type Db = Pick<PrismaService, 'auditLog'> | Prisma.TransactionClient;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** يُمرَّر tx لتسجيل العملية داخل نفس المعاملة فلا يُحفظ تغيير دون سجله. */
  async record(entry: AuditEntry, db: Db = this.prisma): Promise<void> {
    await db.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        details: entry.details,
        ipAddress: entry.ipAddress ?? null,
      },
    });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
