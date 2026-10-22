import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import type { RequestMeta } from '../auth/decorators';
import { Errors, type FieldError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import type { FormDraftDto, QuestionDto } from './draft-dto';
import { RevisionConflict, lockForm, runFormTransaction } from './form-transaction';
import { latestVersionInclude, toFormDto } from './forms.service';
import {
  parseSaveDraft,
  type OptionInput,
  type QuestionInput,
  type SaveDraftInput,
  type ShowIfInput,
} from './questions/draft-schema';
import type { QuestionTypeKey } from './questions/limits';
import { readShowIf } from './questions/visibility';
import { applyConditions, applyQuestions } from './draft-apply';

const draftInclude = {
  createdBy: { select: { id: true, displayName: true } },
  versions: latestVersionInclude,
  draft: {
    include: {
      questions: {
        orderBy: { position: 'asc' },
        include: { options: { orderBy: { position: 'asc' } } },
      },
    },
  },
} satisfies Prisma.FormInclude;

type FormWithFullDraft = Prisma.FormGetPayload<{ include: typeof draftInclude }>;
type StoredQuestion = NonNullable<FormWithFullDraft['draft']>['questions'][number];

const FORM_NOT_FOUND = 'النموذج غير موجود.';
/** الحفظ قد يشمل 100 سؤال × 50 خيارًا؛ مهلة أطول من الافتراضي مع بقاء القفل محدودًا. */
const SAVE_TIMEOUT_MS = 20_000;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

function questionToDto(q: StoredQuestion): QuestionDto {
  return {
    id: q.id,
    type: q.type as QuestionTypeKey,
    title: q.title,
    description: q.description,
    required: q.required,
    settings: (q.settings ?? {}) as Record<string, unknown>,
    showIf: readShowIf(q.showIf),
    semanticKey: q.semanticKey,
    options: q.options.map((o) => ({ id: o.id, label: o.label, semanticKey: o.semanticKey })),
  };
}

/**
 * يحوّل شروط الأسئلة المخزّنة (بالمعرّفات) إلى مواقع في القائمة المرتبة نفسها، كما يرسلها المحرر.
 * الشرط الذي يشير إلى سؤال أو خيارات لم تعد موجودة يُعامل كأنه غير موجود.
 */
export function storedShowIfIndexes(
  questions: { id: string; showIf: unknown; options: { id: string }[] }[],
): (ShowIfInput | null)[] {
  const position = new Map(questions.map((q, i) => [q.id, i]));
  return questions.map((q) => {
    const cond = readShowIf(q.showIf);
    const qi = cond ? position.get(cond.questionId) : undefined;
    if (!cond || qi === undefined) return null;
    const target = questions[qi]!;
    const optionIndexes = cond.optionIds
      .map((id) => target.options.findIndex((o) => o.id === id))
      .filter((i) => i >= 0);
    return optionIndexes.length ? { questionIndex: qi, optionIndexes } : null;
  });
}

export function toDraftDto(form: FormWithFullDraft): FormDraftDto {
  if (!form.draft) throw new Error(`Form ${form.id} has no draft`);
  return { ...toFormDto(form), questions: form.draft.questions.map(questionToDto) };
}

/** تمثيل قابل للمقارنة لمحتوى المسودة (بلا أوقات أو revision). */
function contentKey(
  title: string,
  description: string | null,
  questions: {
    id?: string;
    type: string;
    title: string;
    description: string | null;
    required: boolean;
    settings: unknown;
    showIf: ShowIfInput | null;
    semanticKey: string | null;
    options: OptionInput[];
  }[],
): string {
  return JSON.stringify(
    sortKeys({
      title,
      description,
      questions: questions.map((q) => ({
        id: q.id ?? null,
        type: q.type,
        title: q.title,
        description: q.description,
        required: q.required,
        settings: q.settings,
        showIf: q.showIf ?? null,
        semanticKey: q.semanticKey ?? null,
        options: q.options.map((o) => ({
          id: o.id ?? null,
          label: o.label,
          semanticKey: o.semanticKey ?? null,
        })),
      })),
    }),
  );
}

@Injectable()
export class DraftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getDraft(formId: string): Promise<FormDraftDto> {
    const form = await this.prisma.form.findUnique({
      where: { id: formId, deletedAt: null },
      include: draftInclude,
    });
    if (!form?.draft) throw Errors.notFound(FORM_NOT_FOUND);
    return toDraftDto(form);
  }

  /**
   * يحفظ المسودة كاملة (العنوان والوصف والأسئلة والخيارات والترتيب) في معاملة واحدة:
   * قفل النموذج ⇒ رفض المؤرشف ⇒ مطابقة revision ⇒ التحقق من ملكية المعرّفات ⇒ التطبيق ⇒ زيادة revision مرة واحدة.
   * أي فشل يلغي كل شيء، فلا يوجد حفظ جزئي.
   */
  async saveDraft(
    actor: AuthContext,
    formId: string,
    body: unknown,
    meta: RequestMeta,
  ): Promise<FormDraftDto> {
    const input = parseSaveDraft(body);
    try {
      const form = await runFormTransaction(
        this.prisma,
        async (tx) => {
          await lockForm(tx, formId);
          const current = await tx.form.findUnique({
            where: { id: formId, deletedAt: null },
            include: draftInclude,
          });
          if (!current?.draft) throw Errors.notFound(FORM_NOT_FOUND);
          if (current.archivedAt) {
            throw Errors.conflict('FORM_ARCHIVED', 'لا يمكن تعديل نموذج مؤرشف. استعده أولًا.');
          }
          const draft = current.draft;
          if (draft.revision !== input.revision) throw new RevisionConflict();
          assertOwnership(draft.questions, input.questions);

          const storedConditions = storedShowIfIndexes(draft.questions);
          const storedKey = contentKey(
            draft.title,
            draft.description,
            draft.questions.map((q, i) => ({
              ...q,
              showIf: storedConditions[i] ?? null,
              options: q.options,
            })),
          );
          const incomingKey = contentKey(
            input.title,
            input.description,
            input.questions.map((q) => ({ ...q, options: q.options as OptionInput[] })),
          );
          if (storedKey === incomingKey) return current; // لا تغيير: لا زيادة في revision.

          const summary = await applyQuestions(tx, draft.id, draft.questions, input.questions);
          await applyConditions(
            tx,
            draft.id,
            input.questions,
            draft.questions.some((q) => q.showIf),
          );

          const bumped = await tx.formDraft.updateMany({
            where: { id: draft.id, revision: input.revision },
            data: {
              title: input.title,
              description: input.description,
              revision: { increment: 1 },
              updatedById: actor.userId,
            },
          });
          if (bumped.count === 0) throw new RevisionConflict();
          await tx.form.update({ where: { id: formId }, data: { updatedAt: new Date() } });
          await this.audit.record(
            {
              actorId: actor.userId,
              action: 'form.draft_saved',
              entityType: 'form',
              entityId: formId,
              details: {
                revision: input.revision + 1,
                titleChanged: draft.title !== input.title,
                descriptionChanged: draft.description !== input.description,
                questions: input.questions.length,
                ...summary,
              },
              ipAddress: meta.ipAddress,
            },
            tx,
          );
          return tx.form.findUniqueOrThrow({ where: { id: formId }, include: draftInclude });
        },
        { timeoutMs: SAVE_TIMEOUT_MS },
      );
      return toDraftDto(form);
    } catch (error) {
      if (!(error instanceof RevisionConflict)) throw error;
      // قراءة مستقلة بعد إلغاء المعاملة لإرجاع المسودة الكاملة الأحدث (مع الأسئلة والخيارات).
      const latest = await this.getDraft(formId);
      throw Errors.conflict(
        'REVISION_CONFLICT',
        'عدّل شخص آخر هذا النموذج بعد أن فتحته. لم يُحفظ شيء؛ راجع النسخة الحالية ثم أعد تطبيق تعديلاتك.',
        { current: latest },
      );
    }
  }
}

/** كل معرّف مُرسَل يجب أن يخص هذه المسودة، وكل معرّف خيار يجب أن يخص السؤال نفسه. */
function assertOwnership(stored: StoredQuestion[], incoming: QuestionInput[]): void {
  const optionOwner = new Map<string, string>();
  const questionIds = new Set<string>();
  for (const q of stored) {
    questionIds.add(q.id);
    for (const o of q.options) optionOwner.set(o.id, q.id);
  }
  const errors: FieldError[] = [];
  incoming.forEach((q, qi) => {
    if (q.id && !questionIds.has(q.id)) {
      errors.push({ field: `questions.${qi}.id`, message: 'هذا السؤال لا يخص النموذج الحالي.' });
    }
    (q.options as OptionInput[]).forEach((o, oi) => {
      if (o.id && (!q.id || optionOwner.get(o.id) !== q.id)) {
        errors.push({
          field: `questions.${qi}.options.${oi}.id`,
          message: 'هذا الخيار لا يخص السؤال الحالي.',
        });
      }
    });
  });
  if (errors.length) throw Errors.validation(errors);
}

export type { SaveDraftInput };
