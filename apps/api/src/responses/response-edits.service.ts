import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type ResponseStatus } from '@prisma/client';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import type { RequestMeta } from '../auth/decorators';
import { AppError, Errors, type FieldError } from '../common/errors';
import { UploadsService, type UploadedFileDto } from '../files/uploads.service';
import { runFormTransaction } from '../forms/form-transaction';
import { QUESTION_LIMITS as L, type QuestionTypeKey } from '../forms/questions/limits';
import { versionConditions, visibleQuestionIds, type ShowIf } from '../forms/questions/visibility';
import { detectField, extractPhone } from '../integrations/flowmax/auto-property';
import { PrismaService } from '../prisma/prisma.service';
import { versionQuestionsForValidation } from '../public/public.service';
import { validateAgainstVersion, type NormalizedAnswer } from '../public/response-schema';
import type { EditValueDto, ResponseDetailDto } from './dto';
import { ResponsesService } from './responses.service';

/**
 * تعديل إجابات رد قبل اعتماده بواسطة من يملك «مراجعة الردود»:
 * - قفل صف الرد ومطابقة editRevision يمنعان كتابة تعديل فوق تعديل أحدث (409 RESPONSE_EDIT_CONFLICT).
 * - الرد المرسل إلى Flowmax لا يُعدَّل (409 RESPONSE_LOCKED).
 * - الرد كاملًا يُعاد التحقق منه بقواعد إصداره وشروط الظهور بعد التعديل.
 * - كل تغيير يُسجل في form_response_edits بالقيمة قبل وبعد، ومن عدّل ومتى. لا يُحذف شيء:
 *   المرفق المُزال يبقى بملفه وربطه مع removed_at، والقيم السابقة محفوظة في السجل.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCKED_MESSAGE = 'أُرسل هذا الرد إلى Flowmax، فلا يمكن تعديله.';

const editSchema = z
  .object({
    revision: z.number().int().min(0),
    answers: z
      .array(
        z
          .object({
            questionId: z.string().regex(UUID, 'معرّف السؤال غير صالح.'),
            value: z.union([
              z.string().max(L.paragraphMaxLength, 'الإجابة أطول من المسموح.'),
              z.array(z.string().max(64)).max(L.maxOptions),
              z.null(),
            ]),
          })
          .strict(),
      )
      .min(1, 'لا توجد تعديلات.')
      .max(L.maxQuestions),
  })
  .strict();

export type RawValue = string | string[];

export interface EditQuestionDto {
  id: string;
  type: QuestionTypeKey;
  title: string;
  description: string | null;
  required: boolean;
  settings: Record<string, unknown>;
  options: { id: string; label: string }[];
  /** شرط الظهور بمعرّفات هذا الإصدار. */
  showIf: ShowIf | null;
}

export interface EditFormDto {
  revision: number;
  locked: boolean;
  status: ResponseStatus;
  questions: EditQuestionDto[];
  /** القيم الحالية: نص، رقم كنص، تاريخ، معرّف خيار، مصفوفة معرّفات خيارات أو ملفات. */
  values: Record<string, RawValue>;
  files: Record<string, { id: string; name: string; size: number; kind: string }[]>;
}

class EditConflict extends Error {}

const responseSelect = {
  id: true,
  formId: true,
  status: true,
  editRevision: true,
  referenceCode: true,
  flowmaxSync: { select: { id: true } },
  version: {
    select: {
      questions: {
        orderBy: { position: 'asc' },
        include: { options: { orderBy: { position: 'asc' } } },
      },
    },
  },
  answers: {
    include: {
      options: { select: { optionId: true } },
      files: {
        where: { removedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true, originalName: true, sizeBytes: true, kind: true },
      },
    },
  },
} satisfies Prisma.FormResponseSelect;

type LoadedResponse = Prisma.FormResponseGetPayload<{ select: typeof responseSelect }>;
type VersionQuestion = LoadedResponse['version']['questions'][number];
type AnswerRow = LoadedResponse['answers'][number];

/** قيمة الإجابة المخزنة بصيغة الإرسال (كما يرسلها المتصفح). */
function rawOf(q: VersionQuestion, a: AnswerRow | undefined): RawValue | undefined {
  if (!a) return undefined;
  if (q.type === 'FILE_UPLOAD') return a.files.length ? a.files.map((f) => f.id) : undefined;
  if (a.textValue != null) return a.textValue;
  if (a.numberValue != null) return a.numberValue.toFixed();
  if (a.dateValue != null) return a.dateValue.toISOString().slice(0, 10);
  if (!a.options.length) return undefined;
  const ids = q.options.filter((o) => a.options.some((x) => x.optionId === o.id)).map((o) => o.id);
  return q.type === 'MULTIPLE_CHOICE' ? ids : ids[0];
}

/** صيغة مقارنة ثابتة لقيمة مخزنة (قبل التعديل). */
function keyOfRaw(q: VersionQuestion, raw: RawValue | undefined): string {
  if (raw === undefined) return '';
  if (Array.isArray(raw)) return [...raw].sort().join(',');
  if (q.type === 'FILE_UPLOAD' || q.options.length) return raw;
  if (q.type === 'NUMBER') return `n:${new Prisma.Decimal(raw).toFixed()}`;
  if (q.type === 'DATE') return `d:${raw}`;
  return `t:${raw.trim()}`;
}

/** صيغة مقارنة ثابتة لقيمة مطبّعة (بعد التعديل). */
function keyOf(n: NormalizedAnswer | undefined): string {
  if (!n) return '';
  if (n.fileIds) return [...n.fileIds].sort().join(',');
  if (n.optionIds) return [...n.optionIds].sort().join(',');
  if (n.numberValue !== undefined) return `n:${new Prisma.Decimal(n.numberValue).toFixed()}`;
  if (n.dateValue) return `d:${n.dateValue.toISOString().slice(0, 10)}`;
  return `t:${n.textValue ?? ''}`;
}

@Injectable()
export class ResponseEditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly responses: ResponsesService,
    private readonly uploads: UploadsService,
  ) {}

  private async load(
    db: Prisma.TransactionClient | PrismaService,
    formId: string,
    responseId: string,
  ): Promise<LoadedResponse> {
    const r = await db.formResponse.findFirst({
      where: { id: responseId, formId },
      select: responseSelect,
    });
    if (!r) throw Errors.notFound('الرد غير موجود.');
    return r;
  }

  private toEditForm(r: LoadedResponse): EditFormDto {
    const conditions = versionConditions(r.version.questions);
    const byQuestion = new Map(r.answers.map((a) => [a.questionId, a]));
    const values: EditFormDto['values'] = {};
    const files: EditFormDto['files'] = {};
    for (const q of r.version.questions) {
      const a = byQuestion.get(q.id);
      const raw = rawOf(q, a);
      if (raw !== undefined) values[q.id] = raw;
      if (q.type === 'FILE_UPLOAD' && a?.files.length) {
        files[q.id] = a.files.map((f) => ({
          id: f.id,
          name: f.originalName,
          size: f.sizeBytes,
          kind: f.kind,
        }));
      }
    }
    return {
      revision: r.editRevision,
      locked: Boolean(r.flowmaxSync),
      status: r.status,
      questions: r.version.questions.map((q) => ({
        id: q.id,
        type: q.type as QuestionTypeKey,
        title: q.title,
        description: q.description,
        required: q.required,
        settings: (q.settings ?? {}) as Record<string, unknown>,
        options: q.options.map((o) => ({ id: o.id, label: o.label })),
        showIf: conditions.get(q.id) ?? null,
      })),
      values,
      files,
    };
  }

  async editForm(formId: string, responseId: string): Promise<EditFormDto> {
    return this.toEditForm(await this.load(this.prisma, formId, responseId));
  }

  async upload(
    formId: string,
    responseId: string,
    questionId: string | undefined,
    name: string | undefined,
    length: number | undefined,
    body: Readable,
  ): Promise<UploadedFileDto> {
    return this.uploads.uploadForResponse(formId, responseId, questionId, name, length, body);
  }

  async save(
    actor: AuthContext,
    formId: string,
    responseId: string,
    body: unknown,
    meta: RequestMeta,
  ): Promise<ResponseDetailDto> {
    const parsed = editSchema.safeParse(body);
    if (!parsed.success) {
      throw Errors.validation(
        parsed.error.issues.map((i) => ({
          field: i.path.join('.') || 'body',
          message: /[؀-ۿ]/.test(i.message) ? i.message : 'القيمة غير صحيحة.',
        })),
      );
    }
    const input = parsed.data;
    try {
      await runFormTransaction(this.prisma, async (tx) => {
        const rows = await tx.$queryRaw<{ form_id: string; edit_revision: number }[]>`
          SELECT form_id, edit_revision FROM form_responses WHERE id = ${responseId} FOR UPDATE`;
        if (!rows[0] || rows[0].form_id !== formId) throw Errors.notFound('الرد غير موجود.');
        const r = await this.load(tx, formId, responseId);
        if (r.flowmaxSync) throw Errors.conflict('RESPONSE_LOCKED', LOCKED_MESSAGE);
        if (Number(rows[0].edit_revision) !== input.revision) throw new EditConflict();
        await this.apply(tx, actor, r, input.answers, meta);
      });
    } catch (error) {
      if (!(error instanceof EditConflict)) throw error;
      throw Errors.conflict(
        'RESPONSE_EDIT_CONFLICT',
        'عدّل مستخدم آخر هذا الرد بعد أن فتحته، فلم يُحفظ تعديلك. راجع القيم الحالية ثم أعد التعديل.',
        { current: await this.editForm(formId, responseId) },
      );
    }
    return this.responses.get(formId, responseId);
  }

  private async apply(
    tx: Prisma.TransactionClient,
    actor: AuthContext,
    r: LoadedResponse,
    edits: { questionId: string; value: RawValue | null }[],
    meta: RequestMeta,
  ): Promise<void> {
    const questions = new Map(r.version.questions.map((q) => [q.id, q]));
    const answers = new Map(r.answers.map((a) => [a.questionId, a]));
    const merged = new Map<string, RawValue>();
    for (const q of r.version.questions) {
      const raw = rawOf(q, answers.get(q.id));
      if (raw !== undefined) merged.set(q.id, raw);
    }
    const errors: FieldError[] = [];
    const edited = new Set<string>();
    edits.forEach((e, i) => {
      const id = e.questionId.toLowerCase();
      if (!questions.has(id)) {
        errors.push({ field: `answers.${i}.questionId`, message: 'هذا السؤال لا يخص إصدار الرد.' });
      } else if (edited.has(id)) {
        errors.push({ field: `answers.${i}.questionId`, message: 'تكرر تعديل السؤال نفسه.' });
      } else {
        edited.add(id);
        const v = e.value;
        const empty = v === null || (Array.isArray(v) ? v.length === 0 : v.trim() === '');
        if (empty) merged.delete(id);
        else merged.set(id, Array.isArray(v) ? v.map((x) => x.toLowerCase()) : v);
      }
    });
    if (errors.length) throw Errors.validation(errors);

    // الملفات الجديدة: من جلسة رفع هذا الرد نفسه، لسؤالها، غير مرتبطة وغير منتهية (تُقفل حتى الربط)
    const added = new Map<string, string[]>();
    for (const id of edited) {
      const q = questions.get(id)!;
      if (q.type !== 'FILE_UPLOAD') continue;
      const next = merged.get(id);
      const before = new Set(answers.get(id)?.files.map((f) => f.id) ?? []);
      const fresh = (Array.isArray(next) ? next : []).filter((f) => !before.has(f));
      if (fresh.length) added.set(id, fresh);
    }
    const freshIds = [...added.values()].flat();
    if (freshIds.length) {
      if (freshIds.some((f) => !UUID.test(f))) {
        throw Errors.validation([{ field: 'answers', message: 'معرّف ملف غير صالح.' }]);
      }
      const rows = await tx.$queryRaw<
        {
          id: string;
          question_id: string;
          response_id: string | null;
          expires_at: Date;
          session_response: string | null;
        }[]
      >`SELECT f.id, f.question_id, f.response_id, f.expires_at, s.response_id AS session_response
        FROM uploaded_files f LEFT JOIN fill_sessions s ON s.id = f.fill_session_id
        WHERE f.id IN (${Prisma.join(freshIds)}) FOR UPDATE`;
      const byId = new Map(rows.map((x) => [x.id, x]));
      const now = new Date();
      for (const [qid, ids] of added) {
        const ok = ids.every((f) => {
          const row = byId.get(f);
          return (
            row &&
            row.question_id === qid &&
            row.response_id === null &&
            row.session_response === r.id &&
            row.expires_at > now
          );
        });
        if (!ok) {
          errors.push({
            field: `answers.${qid}`,
            message: 'أحد الملفات غير صالح أو انتهت صلاحيته؛ أعد رفعه.',
          });
        }
      }
      if (errors.length) throw Errors.validation(errors);
    }

    // إعادة التحقق من الرد كاملًا بقواعد إصداره وشروط الظهور
    const shape = versionQuestionsForValidation(r.version.questions);
    const normalized = new Map(
      validateAgainstVersion(
        shape,
        [...merged].map(([questionId, value]) => ({ questionId, value })),
        { ignoreHiddenAnswers: true },
      ).map((n) => [n.questionId, n]),
    );
    const visible = visibleQuestionIds(
      shape.map((q) => ({ id: q.id, showIf: q.showIf })),
      new Map(
        [...normalized].flatMap(([id, n]) => (n.optionIds ? [[id, n.optionIds] as const] : [])),
      ),
    );
    for (const id of edited) {
      if (!visible.has(id) && merged.has(id)) {
        errors.push({
          field: `answers.${id}`,
          message: 'هذا السؤال غير ظاهر حسب إجابات الرد بعد التعديل، فلا تُقبل له قيمة.',
        });
      }
    }
    if (errors.length) throw Errors.validation(errors);

    const revision = r.editRevision + 1;
    const now = new Date();
    let changes = 0;
    for (const id of edited) {
      const q = questions.get(id)!;
      const next = normalized.get(id);
      if (keyOfRaw(q, rawOf(q, answers.get(id))) === keyOf(next)) continue;
      changes++;
      const old = answers.get(id);
      const oldValue = this.display(q, old ? rawOf(q, old) : undefined, old);
      const answerId =
        old?.id ??
        (
          await tx.formAnswer.create({
            data: { responseId: r.id, versionId: q.versionId, questionId: q.id },
            select: { id: true },
          })
        ).id;
      await tx.formAnswer.update({
        where: { id: answerId },
        data: {
          textValue: next?.textValue ?? null,
          numberValue:
            next?.numberValue !== undefined ? new Prisma.Decimal(next.numberValue) : null,
          dateValue: next?.dateValue ?? null,
        },
      });
      if (q.type !== 'FILE_UPLOAD' && q.options.length) {
        // الاختيار السابق محفوظ في سجل التعديل
        await tx.formAnswerOption.deleteMany({ where: { answerId } });
        if (next?.optionIds?.length) {
          await tx.formAnswerOption.createMany({
            data: next.optionIds.map((optionId) => ({ answerId, questionId: q.id, optionId })),
          });
        }
      }
      let newFiles: { id: string; originalName: string }[] = [];
      if (q.type === 'FILE_UPLOAD') {
        const keep = new Set(next?.fileIds ?? []);
        const removed = (old?.files ?? []).filter((f) => !keep.has(f.id)).map((f) => f.id);
        if (removed.length) {
          // إزالة دون حذف: الملف وربطه يبقيان، ولا يمسهما التنظيف لأنهما مرتبطان برد
          await tx.uploadedFile.updateMany({
            where: { id: { in: removed }, responseId: r.id },
            data: { removedAt: now, removedById: actor.userId },
          });
        }
        const fresh = added.get(id) ?? [];
        if (fresh.length) {
          const { count } = await tx.uploadedFile.updateMany({
            where: { id: { in: fresh }, responseId: null },
            data: { responseId: r.id, answerId, attachedAt: now },
          });
          if (count !== fresh.length) {
            throw Errors.validation([
              { field: `answers.${id}`, message: 'تعذر ربط أحد الملفات؛ أعد رفعه.' },
            ]);
          }
        }
        newFiles = await tx.uploadedFile.findMany({
          where: { id: { in: [...keep] } },
          orderBy: { createdAt: 'asc' },
          select: { id: true, originalName: true },
        });
      }
      await tx.formResponseEdit.create({
        data: {
          responseId: r.id,
          revision,
          questionId: q.id,
          questionTitle: q.title,
          oldValue: (oldValue ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue,
          newValue: (this.displayNormalized(q, next, newFiles) ??
            Prisma.DbNull) as unknown as Prisma.InputJsonValue,
          editedById: actor.userId,
          editedAt: now,
        },
      });
    }
    if (!changes) return;
    await tx.formResponse.update({ where: { id: r.id }, data: { editRevision: revision } });
    await this.audit.record(
      {
        actorId: actor.userId,
        action: 'response.edited',
        entityType: 'response',
        entityId: r.id,
        details: { formId: r.formId, revision, fields: changes },
        ipAddress: meta.ipAddress,
      },
      tx,
    );
  }

  /** قيمة مخزنة بصيغة العرض في سجل التعديل. */
  private display(
    q: VersionQuestion,
    raw: RawValue | undefined,
    row: AnswerRow | undefined,
  ): EditValueDto | null {
    if (raw === undefined) return null;
    if (q.type === 'FILE_UPLOAD') {
      return {
        kind: 'files',
        files: (row?.files ?? []).map((f) => ({ id: f.id, name: f.originalName })),
      };
    }
    if (q.options.length) {
      const ids = Array.isArray(raw) ? raw : [raw];
      return {
        kind: 'choice',
        options: q.options.filter((o) => ids.includes(o.id)).map((o) => o.label),
      };
    }
    return {
      kind: q.type === 'NUMBER' ? 'number' : q.type === 'DATE' ? 'date' : 'text',
      value: raw as string,
    };
  }

  private displayNormalized(
    q: VersionQuestion,
    n: NormalizedAnswer | undefined,
    files: { id: string; originalName: string }[],
  ): EditValueDto | null {
    if (!n) return null;
    if (n.fileIds)
      return { kind: 'files', files: files.map((f) => ({ id: f.id, name: f.originalName })) };
    if (n.optionIds) {
      return {
        kind: 'choice',
        options: q.options.filter((o) => n.optionIds!.includes(o.id)).map((o) => o.label),
      };
    }
    if (n.numberValue !== undefined) {
      return { kind: 'number', value: new Prisma.Decimal(n.numberValue).toFixed() };
    }
    if (n.dateValue) return { kind: 'date', value: n.dateValue.toISOString().slice(0, 10) };
    return { kind: 'text', value: n.textValue ?? '' };
  }

  /**
   * رابط واتساب لمشاركة سبب الرفض مع العميل: لا يُرسل شيئًا، ويُسجَّل فتحه فقط.
   * الرقم من إجابة الجوال في الرد نفسه بعد التحقق منه، والنص بلا بيانات داخلية أو بيانات عميل آخر.
   */
  async rejectionShare(
    actor: AuthContext,
    formId: string,
    responseId: string,
    meta: RequestMeta,
  ): Promise<{ url: string; text: string; phone: string }> {
    const r = await this.load(this.prisma, formId, responseId);
    if (r.status !== 'REJECTED') {
      throw Errors.conflict('RESPONSE_NOT_REJECTED', 'مشاركة سبب الرفض متاحة للرد المرفوض فقط.');
    }
    const last = await this.prisma.formResponseStatusChange.findFirst({
      where: { responseId, toStatus: 'REJECTED' },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      select: { reason: true },
    });
    const reason = last?.reason?.trim();
    if (!reason) {
      throw Errors.conflict('REJECTION_REASON_MISSING', 'لا يوجد سبب رفض محفوظ لهذا الرد.');
    }
    const { phone, name } = this.contactOf(r);
    if (!phone) {
      throw new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'REJECTION_SHARE_NO_PHONE',
        'لا يوجد رقم جوال صالح في هذا الرد، فلا يمكن فتح المشاركة عبر واتساب. تواصل مع العميل بطريقة أخرى.',
      );
    }
    const text = [
      `السلام عليكم${name ? ` ${name}` : ''}،`,
      'شكرًا لتواصلك معنا.',
      `نعتذر عن عدم قبول ردك ذي الرقم المرجعي ${r.referenceCode}.`,
      `سبب الرفض: ${reason}`,
      'يسعدنا تواصلك معنا لأي استفسار.',
    ].join('\n');
    await this.audit.record({
      actorId: actor.userId,
      action: 'response.rejection_share_opened',
      entityType: 'response',
      entityId: responseId,
      details: { formId },
      ipAddress: meta.ipAddress,
    });
    return { url: `https://wa.me/${phone.slice(1)}?text=${encodeURIComponent(text)}`, text, phone };
  }

  /** الجوال والاسم من الرد: الهوية الدلالية في نماذج القالب، وإلا التعرّف من عناوين الأسئلة. */
  private contactOf(r: LoadedResponse): { phone: string | null; name: string | null } {
    const answers = new Map(r.answers.map((a) => [a.questionId, a]));
    let phone: string | null = null;
    let name: string | null = null;
    for (const q of r.version.questions) {
      const text = answers.get(q.id)?.textValue?.trim();
      if (!text) continue;
      const field =
        q.semanticKey === 'contact.phone'
          ? 'phone'
          : q.semanticKey === 'contact.name'
            ? 'contact_name'
            : q.semanticKey
              ? null
              : detectField(q.title, false);
      if (field === 'phone' && !phone) phone = extractPhone(text);
      if (field === 'contact_name' && !name) name = text.slice(0, 60);
    }
    return { phone, name };
  }
}
