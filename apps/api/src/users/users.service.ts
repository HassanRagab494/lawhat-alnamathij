import { HttpStatus, Injectable } from '@nestjs/common';
import { Permission, Prisma, User, UserRole } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import type { RequestMeta } from '../auth/decorators';
import { hashPassword, passwordPolicyError } from '../auth/password';
import {
  ALL_PERMISSIONS,
  PERMISSION_LABELS,
  PERMISSION_REQUIRES,
  effectivePermissions,
  missingPrerequisites,
} from '../auth/permissions';
import { SessionService } from '../auth/session.service';
import { AppError, Errors } from '../common/errors';
import { PageQueryDto, pageMeta } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateSupervisorDto,
  PermissionOptionDto,
  UpdateSupervisorDto,
  UserDto,
  UserListDto,
} from './dto';

type UserWithPermissions = User & { permissions: { permission: Permission }[] };

const withPermissions = { permissions: { select: { permission: true } } } as const;

const USER_NOT_FOUND = 'المستخدم غير موجود.';

export function toUserDto(user: UserWithPermissions): UserDto {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    isActive: user.isActive,
    permissions: effectivePermissions(
      user.role,
      user.permissions.map((p) => p.permission),
    ),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  permissionCatalog(): PermissionOptionDto[] {
    return ALL_PERMISSIONS.map((key) => ({
      key,
      label: PERMISSION_LABELS[key],
      requires: PERMISSION_REQUIRES[key] ?? null,
    }));
  }

  async list(query: PageQueryDto): Promise<UserListDto> {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(query.search
        ? {
            OR: [
              { username: { contains: query.search } },
              { displayName: { contains: query.search } },
            ],
          }
        : {}),
    };
    const [total, users] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        include: withPermissions,
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { items: users.map(toUserDto), meta: pageMeta(query.page, query.pageSize, total) };
  }

  async get(id: string): Promise<UserDto> {
    const user = await this.prisma.user.findUnique({ where: { id }, include: withPermissions });
    if (!user || user.deletedAt) throw Errors.notFound(USER_NOT_FOUND);
    return toUserDto(user);
  }

  async createSupervisor(
    actor: AuthContext,
    dto: CreateSupervisorDto,
    meta: RequestMeta,
  ): Promise<UserDto> {
    const policy = passwordPolicyError(dto.password, dto.username);
    if (policy) throw Errors.validation([{ field: 'password', message: policy }]);
    this.assertPrerequisites(dto.permissions);

    const passwordHash = await hashPassword(dto.password);
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            username: dto.username,
            displayName: dto.displayName,
            passwordHash,
            role: UserRole.SUPERVISOR,
            createdById: actor.userId,
            permissions: {
              create: dto.permissions.map((permission) => ({
                permission,
                grantedById: actor.userId,
              })),
            },
          },
          include: withPermissions,
        });
        await this.audit.record(
          {
            actorId: actor.userId,
            action: 'user.created',
            entityType: 'user',
            entityId: created.id,
            details: {
              username: created.username,
              displayName: created.displayName,
              permissions: dto.permissions,
            },
            ipAddress: meta.ipAddress,
          },
          tx,
        );
        return created;
      });
      return toUserDto(user);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(HttpStatus.CONFLICT, 'USERNAME_TAKEN', 'اسم المستخدم مستخدم بالفعل.', {
          fields: [{ field: 'username', message: 'اسم المستخدم مستخدم بالفعل.' }],
        });
      }
      throw error;
    }
  }

  /**
   * يعدّل الاسم و/أو الصلاحيات. الصلاحيات تُقرأ من القاعدة في كل طلب،
   * لذا يسري التغيير على جلسات المشرف القائمة فورًا دون إبطالها.
   */
  async updateSupervisor(
    actor: AuthContext,
    id: string,
    dto: UpdateSupervisorDto,
    meta: RequestMeta,
  ): Promise<UserDto> {
    if (dto.permissions) this.assertPrerequisites(dto.permissions);

    const user = await this.prisma.$transaction(async (tx) => {
      const current = await this.loadSupervisor(id, tx);
      const before = current.permissions.map((p) => p.permission);

      if (dto.displayName !== undefined && dto.displayName !== current.displayName) {
        await tx.user.update({ where: { id }, data: { displayName: dto.displayName } });
        await this.audit.record(
          {
            actorId: actor.userId,
            action: 'user.updated',
            entityType: 'user',
            entityId: id,
            details: { displayName: { from: current.displayName, to: dto.displayName } },
            ipAddress: meta.ipAddress,
          },
          tx,
        );
      }

      if (dto.permissions) {
        const after = dto.permissions;
        const added = after.filter((p) => !before.includes(p));
        const removed = before.filter((p) => !after.includes(p));
        if (added.length || removed.length) {
          if (removed.length) {
            await tx.userPermission.deleteMany({
              where: { userId: id, permission: { in: removed } },
            });
          }
          if (added.length) {
            await tx.userPermission.createMany({
              data: added.map((permission) => ({
                userId: id,
                permission,
                grantedById: actor.userId,
              })),
            });
          }
          await tx.user.update({ where: { id }, data: { updatedAt: new Date() } });
          await this.audit.record(
            {
              actorId: actor.userId,
              action: 'user.permissions_changed',
              entityType: 'user',
              entityId: id,
              details: { added, removed, permissions: after },
              ipAddress: meta.ipAddress,
            },
            tx,
          );
        }
      }

      return tx.user.findUniqueOrThrow({ where: { id }, include: withPermissions });
    });
    return toUserDto(user);
  }

  async setActive(
    actor: AuthContext,
    id: string,
    isActive: boolean,
    meta: RequestMeta,
  ): Promise<UserDto> {
    const user = await this.prisma.$transaction(async (tx) => {
      const current = await this.loadSupervisor(id, tx);
      if (current.isActive === isActive) {
        throw Errors.conflict(
          isActive ? 'USER_ALREADY_ACTIVE' : 'USER_ALREADY_INACTIVE',
          isActive ? 'الحساب مفعّل بالفعل.' : 'الحساب معطّل بالفعل.',
        );
      }
      await tx.user.update({
        where: { id },
        data: isActive ? { isActive, failedLoginCount: 0, lockedUntil: null } : { isActive },
      });
      const revoked = isActive
        ? 0
        : await this.sessions.revokeAllForUser(id, 'user_deactivated', { db: tx });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: isActive ? 'user.activated' : 'user.deactivated',
          entityType: 'user',
          entityId: id,
          details: isActive ? undefined : { revokedSessions: revoked },
          ipAddress: meta.ipAddress,
        },
        tx,
      );
      return tx.user.findUniqueOrThrow({ where: { id }, include: withPermissions });
    });
    return toUserDto(user);
  }

  /** إعادة تعيين كلمة مرور المشرف بواسطة المدير، مع إبطال كل جلساته القائمة. */
  async resetPassword(
    actor: AuthContext,
    id: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    const target = await this.loadSupervisor(id, this.prisma);
    const policy = passwordPolicyError(newPassword, target.username);
    if (policy) throw Errors.validation([{ field: 'newPassword', message: policy }]);
    const passwordHash = await hashPassword(newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      const revoked = await this.sessions.revokeAllForUser(id, 'password_reset', { db: tx });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'user.password_reset',
          entityType: 'user',
          entityId: id,
          details: { revokedSessions: revoked },
          ipAddress: meta.ipAddress,
        },
        tx,
      );
    });
  }

  /**
   * حذف ناعم للمشرف: يختفي من القوائم والإحصاءات، ويُعطَّل، وتُبطل كل جلساته.
   * لا يُحذف الصف فعليًا حتى تبقى النماذج التي أنشأها وسجل العمليات مرتبطة باسمه.
   * اسم المستخدم يبقى محجوزًا ولا يمكن إعادة استخدامه لحساب جديد.
   */
  async deleteSupervisor(actor: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const current = await this.loadSupervisor(id, tx);
      await tx.user.update({
        where: { id },
        data: { deletedAt: new Date(), deletedById: actor.userId, isActive: false },
      });
      const revoked = await this.sessions.revokeAllForUser(id, 'user_deleted', { db: tx });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'user.deleted',
          entityType: 'user',
          entityId: id,
          details: {
            username: current.username,
            displayName: current.displayName,
            revokedSessions: revoked,
          },
          ipAddress: meta.ipAddress,
        },
        tx,
      );
    });
  }

  private async loadSupervisor(
    id: string,
    db: PrismaService | Prisma.TransactionClient,
  ): Promise<UserWithPermissions> {
    const user = await db.user.findUnique({ where: { id }, include: withPermissions });
    if (!user || user.deletedAt) throw Errors.notFound(USER_NOT_FOUND);
    if (user.role !== UserRole.SUPERVISOR) {
      throw new AppError(
        HttpStatus.FORBIDDEN,
        'ADMIN_ACCOUNT_PROTECTED',
        'لا يمكن تعديل حساب مدير النظام من إدارة المستخدمين.',
      );
    }
    return user;
  }

  private assertPrerequisites(permissions: Permission[]): void {
    const missing = missingPrerequisites(permissions);
    if (missing.length) {
      const labels = missing.map((p) => `«${PERMISSION_LABELS[p]}»`).join('، ');
      throw Errors.validation([
        { field: 'permissions', message: `الصلاحيات المختارة تتطلب أيضًا ${labels}.` },
      ]);
    }
  }
}
