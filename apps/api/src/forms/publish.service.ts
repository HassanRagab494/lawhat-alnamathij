import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import type { RequestMeta } from '../auth/decorators';
import { Errors } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../files/uploads.service';
import { DraftService } from './draft.service';
import type { FormDto } from './dto';
import { RevisionConflict, lockForm, runFormTransaction } from './form-transaction';
import { FormsService } from './forms.service';
import { saveDraftSchema } from './questions/draft-schema';

const FORM_NOT_FOUND = 'النموذج غير موجود.';
/** نسخ 100 سؤال × 50 خيارًا قد يستغرق وقتًا؛ القفل يبقى على النموذج نفسه فقط. */
const PUBLISH_TIMEOUT_MS = 30_000;

export interface PublishInput {
  revision: number;
  publishKey: string;
  openResponses?: boolean;
}

export interface PublishResult {
  form: FormDto;
  version: { id: string; versionNumber: number };
  /** true إن كان الطلب إعادة لطلب نشر سابق بالمفتاح نفسه (لم يُنشأ إصدار جديد). */
  replayed: boolean;
}

/** معرّف عام عشوائي (128 بت) للرابط /f/<publicId>؛ لا يكشف معرّف النموذج الداخلي. */
export function generatePublicId(): string {
  return randomBytes(16).toString('base64url');
}

type DraftForPublish = Prisma.FormDraftGetPayload<{
  include: { questions: { include: { options: true } } };
}>;

/**
 * أسباب منع النشر بالعربية؛ قائمة فارغة تعني أن المسودة قابلة للنشر.
 * سؤال الملفات مسموح فقط حين يكون الرفع مفعّلًا (فاحص ملفات مضبوط).
 */
export function publishBlockers(draft: DraftForPublish, uploadsEnabled = false): string[] {
  const reasons: string[] = [];
  if (draft.questions.length === 0) reasons.push('لا يمكن نشر نموذج بلا أسئلة.');
  draft.questions.forEach((q, i) => {
    if (q.type === 'FILE_UPLOAD' && !uploadsEnabled) {
      reasons.push(
        `السؤال ${i + 1} «${q.title}» من نوع رفع ملفات، ورفع الملفات غير مفعّل على هذا الخادم (لا يوجد فاحص ملفات مضبوط). احذفه أو غيّر نوعه، أو فعّل الفاحص.`,
      );
    }
  });
  // إعادة التحقق من المحتوى المحفوظ بالمخطط نفسه الذي يطبقه الحفظ (حماية من بيانات قديمة أو معدلة يدويًا).
  const check = saveDraftSchema.safeParse({
    revision: draft.revision,
    title: draft.title,
    description: draft.description,
    questions: draft.questions.map((q) => ({
      id: q.id,
      type: q.type,
      title: q.title,
      description: q.description,
      required: q.required,
      settings: q.settings,
      options: q.options.map((o) => ({ id: o.id, label: o.label })),
    })),
  });
  if (!check.success) {
    reasons.push('بعض بيانات المسودة المحفوظة غير صحيحة. افتح المحرر وصحّحها ثم احفظ قبل النشر.');
  }
  return reasons;
}

@Injectable()
export class PublishService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly forms: FormsService,
    private readonly drafts: DraftService,
    private readonly uploads: UploadsService,
  ) {}

  /**
   * ينشر المسودة المحفوظة كإصدار ثابت في معاملة واحدة بقفل النموذج (نفس قفل الحفظ والأرشفة والاستقبال):
   * إعادة طلب بنفس publishKey ⇒ الإصدار نفسه؛ مؤرشف ⇒ 409؛ revision قديم ⇒ 409 مع المسودة الحالية؛
   * موانع النشر ⇒ 409 PUBLISH_BLOCKED؛ ثم نسخ المحتوى ورقم إصدار = الأعلى + 1 (مع قيد فريد).
   */
  async publish(
    actor: AuthContext,
    formId: string,
    input: PublishInput,
    meta: RequestMeta,
  ): Promise<PublishResult> {
    let outcome: { versionId: string; versionNumber: number; replayed: boolean };
    // فتح الاستقبال مع أول نشر يتطلب صلاحية الاستقبال أيضًا، حتى لا تتجاوز صلاحية النشر وحدها ذلك.
    if (
      input.openResponses === true &&
      actor.role !== 'ADMIN' &&
      !actor.permissions.includes('FORMS_INTAKE')
    ) {
      throw Errors.forbidden();
    }
    try {
      outcome = await runFormTransaction(
        this.prisma,
        async (tx) => {
          await lockForm(tx, formId);
          const current = await tx.form.findUnique({
            where: { id: formId },
            include: {
              draft: {
                include: {
                  questions: {
                    orderBy: { position: 'asc' },
                    include: { options: { orderBy: { position: 'asc' } } },
                  },
                },
              },
              versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
            },
          });
          if (!current?.draft) throw Errors.notFound(FORM_NOT_FOUND);

          const prior = await tx.formVersion.findUnique({
            where: { formId_publishKey: { formId, publishKey: input.publishKey } },
          });
          if (prior) {
            if (prior.sourceDraftRevision !== input.revision) {
              throw Errors.conflict(
                'PUBLISH_KEY_REUSED',
                'استُخدم مفتاح النشر هذا لنشر نسخة أخرى. أعد فتح نافذة النشر وحاول مجددًا.',
              );
            }
            return { versionId: prior.id, versionNumber: prior.versionNumber, replayed: true };
          }

          if (current.archivedAt) {
            throw Errors.conflict('FORM_ARCHIVED', 'لا يمكن نشر نموذج مؤرشف. استعده أولًا.');
          }
          const draft = current.draft;
          if (draft.revision !== input.revision) throw new RevisionConflict();
          const reasons = publishBlockers(draft, this.uploads.enabled);
          if (reasons.length) {
            throw Errors.conflict('PUBLISH_BLOCKED', 'لا يمكن نشر النموذج بحالته الحالية.', {
              reasons,
            });
          }

          const previous = current.versions[0];
          const versionNumber = (previous?.versionNumber ?? 0) + 1;
          const version = await tx.formVersion.create({
            data: {
              formId,
              versionNumber,
              title: draft.title,
              description: draft.description,
              sourceDraftRevision: draft.revision,
              publishKey: input.publishKey,
              publishedById: actor.userId,
              questions: {
                create: draft.questions.map((q) => ({
                  logicalId: q.id,
                  position: q.position,
                  type: q.type,
                  title: q.title,
                  description: q.description,
                  required: q.required,
                  settings: q.settings as Prisma.InputJsonValue,
                  options: {
                    create: q.options.map((o) => ({
                      logicalId: o.id,
                      position: o.position,
                      label: o.label,
                    })),
                  },
                })),
              },
            },
            select: { id: true },
          });

          const firstPublish = !previous;
          const openNow = firstPublish && input.openResponses === true;
          await tx.form.update({
            where: { id: formId },
            data: {
              updatedAt: new Date(),
              ...(current.publicId ? {} : { publicId: generatePublicId() }),
              // أول نشر: الاستقبال حسب اختيار الناشر الصريح. التحديثات اللاحقة تحافظ على الحالة.
              ...(firstPublish ? { acceptingResponses: openNow } : {}),
            },
          });
          await this.audit.record(
            {
              actorId: actor.userId,
              action: 'form.published',
              entityType: 'form',
              entityId: formId,
              details: {
                versionNumber,
                sourceDraftRevision: draft.revision,
                questions: draft.questions.length,
                ...(firstPublish ? { openedResponses: openNow } : {}),
              },
              ipAddress: meta.ipAddress,
            },
            tx,
          );
          return { versionId: version.id, versionNumber, replayed: false };
        },
        { timeoutMs: PUBLISH_TIMEOUT_MS },
      );
    } catch (error) {
      if (!(error instanceof RevisionConflict)) throw error;
      const latest = await this.drafts.getDraft(formId);
      throw Errors.conflict(
        'REVISION_CONFLICT',
        'تغيّرت المسودة بعد أن فتحت نافذة النشر، فلم يُنشر شيء. راجع النسخة الحالية ثم انشر مجددًا.',
        { current: latest },
      );
    }
    return {
      form: await this.forms.get(formId),
      version: { id: outcome.versionId, versionNumber: outcome.versionNumber },
      replayed: outcome.replayed,
    };
  }

  /**
   * فتح الاستقبال أو إغلاقه بقفل النموذج. أي إرسال رد يأخذ القفل نفسه ويتحقق من الحالة داخله،
   * فلا يُكتب رد بعد إغلاق سبقه. الطلب على الحالة القائمة نفسها لا يغيّر شيئًا (آمن للإعادة).
   */
  async setIntake(
    actor: AuthContext,
    formId: string,
    open: boolean,
    meta: RequestMeta,
  ): Promise<FormDto> {
    await runFormTransaction(this.prisma, async (tx) => {
      await lockForm(tx, formId);
      const form = await tx.form.findUnique({
        where: { id: formId },
        select: {
          archivedAt: true,
          acceptingResponses: true,
          _count: { select: { versions: true } },
        },
      });
      if (!form) throw Errors.notFound(FORM_NOT_FOUND);
      if (form.acceptingResponses === open) return;
      if (open && form.archivedAt) {
        throw Errors.conflict('FORM_ARCHIVED', 'لا يمكن فتح الاستقبال لنموذج مؤرشف. استعده أولًا.');
      }
      if (open && form._count.versions === 0) {
        throw Errors.conflict('NOT_PUBLISHED', 'انشر النموذج أولًا ثم افتح استقبال الردود.');
      }
      await tx.form.update({
        where: { id: formId },
        data: { acceptingResponses: open, updatedAt: new Date() },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: open ? 'form.responses_opened' : 'form.responses_closed',
          entityType: 'form',
          entityId: formId,
          ipAddress: meta.ipAddress,
        },
        tx,
      );
    });
    return this.forms.get(formId);
  }
}
