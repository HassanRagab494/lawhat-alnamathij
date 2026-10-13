import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import type { RequestMeta } from '../auth/decorators';
import { Errors } from '../common/errors';
import { pageMeta } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateFormDto, FormDto, FormListDto, FormListQueryDto, UpdateFormDto } from './dto';
import { RevisionConflict, lockForm, runFormTransaction } from './form-transaction';

const formInclude = {
  draft: true,
  createdBy: { select: { id: true, displayName: true } },
} satisfies Prisma.FormInclude;

type FormWithDraft = Prisma.FormGetPayload<{ include: typeof formInclude }>;

const FORM_NOT_FOUND = 'النموذج غير موجود.';

export function toFormDto(form: FormWithDraft): FormDto {
  if (!form.draft) throw new Error(`Form ${form.id} has no draft`);
  return {
    id: form.id,
    title: form.draft.title,
    description: form.draft.description,
    publicationStatus: 'draft',
    isArchived: form.archivedAt !== null,
    revision: form.draft.revision,
    createdBy: form.createdBy,
    createdAt: form.createdAt.toISOString(),
    updatedAt: form.updatedAt.toISOString(),
    archivedAt: form.archivedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class FormsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: FormListQueryDto): Promise<FormListDto> {
    const where: Prisma.FormWhereInput = {
      archivedAt: query.status === 'archived' ? { not: null } : null,
      ...(query.search ? { draft: { is: { title: { contains: query.search } } } } : {}),
    };
    const [total, forms] = await this.prisma.$transaction([
      this.prisma.form.count({ where }),
      this.prisma.form.findMany({
        where,
        include: formInclude,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { items: forms.map(toFormDto), meta: pageMeta(query.page, query.pageSize, total) };
  }

  async get(id: string): Promise<FormDto> {
    const form = await this.prisma.form.findUnique({ where: { id }, include: formInclude });
    if (!form) throw Errors.notFound(FORM_NOT_FOUND);
    return toFormDto(form);
  }

  /** ينشئ سجل النموذج ومسودته الأولى معًا. كل نموذج جديد مسودة غير منشورة. */
  async create(actor: AuthContext, dto: CreateFormDto, meta: RequestMeta): Promise<FormDto> {
    const form = await this.formTransaction(async (tx) => {
      const created = await tx.form.create({
        data: {
          createdById: actor.userId,
          draft: {
            create: {
              title: dto.title,
              description: dto.description ?? null,
              updatedById: actor.userId,
            },
          },
        },
        include: formInclude,
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'form.created',
          entityType: 'form',
          entityId: created.id,
          details: { title: dto.title },
          ipAddress: meta.ipAddress,
        },
        tx,
      );
      return created;
    });
    return toFormDto(form);
  }

  /**
   * تحديث متفائل: يُطبق فقط إذا طابق revision المرسل رقم المراجعة الحالي،
   * وإلا يُرفض بـ 409 ومعه النسخة الحالية حتى لا يُكتب بصمت فوق تعديل أحدث.
   */
  async update(
    actor: AuthContext,
    id: string,
    dto: UpdateFormDto,
    meta: RequestMeta,
  ): Promise<FormDto> {
    const description = dto.description ?? null;
    let form: FormWithDraft;
    try {
      form = await this.formTransaction(async (tx) => {
        // Always lock parent before draft; the first consistent read follows lock acquisition.
        // هذا المسار يعدّل العنوان والوصف فقط ويحترم revision نفسه، ولا يلمس أسئلة المسودة.
        await lockForm(tx, id);
        const current = await tx.form.findUnique({ where: { id }, include: formInclude });
        if (!current?.draft) throw Errors.notFound(FORM_NOT_FOUND);
        if (current.archivedAt) {
          throw Errors.conflict('FORM_ARCHIVED', 'لا يمكن تعديل نموذج مؤرشف. استعده أولًا.');
        }

        const changes: Record<string, { from: string | null; to: string | null }> = {};
        if (current.draft.title !== dto.title) {
          changes.title = { from: current.draft.title, to: dto.title };
        }
        if (current.draft.description !== description) {
          changes.description = { from: current.draft.description, to: description };
        }

        if (!Object.keys(changes).length) {
          if (current.draft.revision !== dto.revision) throw new RevisionConflict();
          return current;
        }

        // الشرط على revision يُقيَّم أثناء الكتابة بقفل الصف، فيفوز تعديل واحد فقط من تعديلين متزامنين.
        const updated = await tx.formDraft.updateMany({
          where: { formId: id, revision: dto.revision },
          data: {
            title: dto.title,
            description,
            revision: { increment: 1 },
            updatedById: actor.userId,
          },
        });
        if (updated.count === 0) throw new RevisionConflict();

        await tx.form.update({ where: { id }, data: { updatedAt: new Date() } });
        await this.audit.record(
          {
            actorId: actor.userId,
            action: 'form.updated',
            entityType: 'form',
            entityId: id,
            details: { changes, revision: dto.revision + 1 },
            ipAddress: meta.ipAddress,
          },
          tx,
        );
        return tx.form.findUniqueOrThrow({ where: { id }, include: formInclude });
      });
    } catch (error) {
      if (!(error instanceof RevisionConflict)) throw error;
      // A separate autocommit read cannot reuse the failed transaction's snapshot.
      const current = await this.get(id);
      throw Errors.conflict(
        'REVISION_CONFLICT',
        'عدّل شخص آخر هذا النموذج بعد أن فتحته. راجع النسخة الحالية ثم أعد تطبيق تعديلاتك.',
        { current },
      );
    }
    return toFormDto(form);
  }

  async archive(actor: AuthContext, id: string, meta: RequestMeta): Promise<FormDto> {
    return this.setArchived(actor, id, true, meta);
  }

  async restore(actor: AuthContext, id: string, meta: RequestMeta): Promise<FormDto> {
    return this.setArchived(actor, id, false, meta);
  }

  private formTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return runFormTransaction(this.prisma, work);
  }

  private async setArchived(
    actor: AuthContext,
    id: string,
    archive: boolean,
    meta: RequestMeta,
  ): Promise<FormDto> {
    const form = await this.formTransaction(async (tx) => {
      await lockForm(tx, id);
      const now = new Date();
      const result = await tx.form.updateMany({
        where: { id, archivedAt: archive ? null : { not: null } },
        data: archive
          ? { archivedAt: now, archivedById: actor.userId, updatedAt: now }
          : { archivedAt: null, archivedById: null, updatedAt: now },
      });
      if (result.count === 0) {
        const exists = await tx.form.count({ where: { id } });
        if (!exists) throw Errors.notFound(FORM_NOT_FOUND);
        throw archive
          ? Errors.conflict('FORM_ALREADY_ARCHIVED', 'النموذج مؤرشف بالفعل.')
          : Errors.conflict('FORM_NOT_ARCHIVED', 'النموذج غير مؤرشف.');
      }
      await this.audit.record(
        {
          actorId: actor.userId,
          action: archive ? 'form.archived' : 'form.restored',
          entityType: 'form',
          entityId: id,
          ipAddress: meta.ipAddress,
        },
        tx,
      );
      return tx.form.findUniqueOrThrow({ where: { id }, include: formInclude });
    });
    return toFormDto(form);
  }
}
