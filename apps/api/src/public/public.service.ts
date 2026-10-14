import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { Errors } from '../common/errors';
import { lockForm, runFormTransaction } from '../forms/form-transaction';
import type { QuestionTypeKey } from '../forms/questions/limits';
import { UploadsService } from '../files/uploads.service';
import { PrismaService } from '../prisma/prisma.service';
import type { PublicFormDto, SubmitResultDto } from './public-dto';
import { parseSubmitResponse, requestHash, validateAgainstVersion } from './response-schema';

const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{16,32}$/;
const NOT_FOUND = 'النموذج غير موجود أو لم يُنشر بعد.';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const latestVersionWithQuestions = {
  orderBy: { versionNumber: 'desc' },
  take: 1,
  include: {
    questions: {
      orderBy: { position: 'asc' },
      include: { options: { orderBy: { position: 'asc' } } },
    },
  },
} satisfies Prisma.Form$versionsArgs;

/** رقم مرجعي عشوائي (60 بت) بصيغة XXXX-XXXX-XXXX من أبجدية Crockford (بلا أحرف ملتبسة). */
export function generateReferenceCode(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += CROCKFORD[bytes[i]! % 32];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

function uniqueTarget(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = error.meta?.target;
    return Array.isArray(target) ? target.join(',') : String(target ?? '');
  }
  return null;
}

export interface SubmitOutcome {
  result: SubmitResultDto;
  replayed: boolean;
}

@Injectable()
export class PublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
  ) {}

  /**
   * أحدث إصدار منشور فقط. لا يكشف المسودة أو المستخدمين أو الردود.
   * إن كان الاستقبال مغلقًا (أو النموذج مؤرشفًا) يُعاد العنوان والوصف دون الأسئلة.
   */
  async getPublicForm(publicId: string): Promise<PublicFormDto> {
    if (!PUBLIC_ID_RE.test(publicId)) throw Errors.notFound(NOT_FOUND);
    const form = await this.prisma.form.findUnique({
      where: { publicId },
      select: { archivedAt: true, acceptingResponses: true, versions: latestVersionWithQuestions },
    });
    const version = form?.versions[0];
    if (!form || !version) throw Errors.notFound(NOT_FOUND);
    const accepting = form.acceptingResponses && !form.archivedAt;
    return {
      publicId,
      title: version.title,
      description: version.description,
      acceptingResponses: accepting,
      versionId: accepting ? version.id : null,
      questions: accepting
        ? version.questions.map((q) => ({
            id: q.id,
            key: q.logicalId,
            type: q.type as QuestionTypeKey,
            title: q.title,
            description: q.description,
            required: q.required,
            settings: (q.settings ?? {}) as Record<string, unknown>,
            options: q.options.map((o) => ({ id: o.id, key: o.logicalId, label: o.label })),
          }))
        : [],
    };
  }

  /**
   * يحفظ ردًا كاملًا في معاملة واحدة بقفل النموذج (القفل نفسه الذي يأخذه الإغلاق والنشر والأرشفة):
   * 1) إعادة الطلب بنفس المفتاح والمحتوى ⇒ النتيجة الأصلية (حتى لو أُغلق الاستقبال بعدها)؛
   *    المفتاح نفسه بمحتوى مختلف ⇒ 409.
   * 2) مغلق أو مؤرشف ⇒ 409 RESPONSES_CLOSED. 3) إصدار أقدم من المنشور ⇒ 409 VERSION_OUTDATED.
   * 4) التحقق من الإجابات مقابل الإصدار المخزن. 5) الإنشاء؛ القيد الفريد (form_id, idempotency_key)
   *    يمنع التكرار حتى لو تجاوز طلبان الفحص الأول.
   */
  async submit(publicId: string, body: unknown): Promise<SubmitOutcome> {
    if (!PUBLIC_ID_RE.test(publicId)) throw Errors.notFound(NOT_FOUND);
    const input = parseSubmitResponse(body);
    const hash = requestHash(input);
    const form = await this.prisma.form.findUnique({ where: { publicId }, select: { id: true } });
    if (!form) throw Errors.notFound(NOT_FOUND);
    const formId = form.id;

    for (let attempt = 0; ; attempt++) {
      try {
        return await runFormTransaction(this.prisma, async (tx) => {
          await lockForm(tx, formId);
          const existing = await tx.formResponse.findUnique({
            where: { formId_idempotencyKey: { formId, idempotencyKey: input.idempotencyKey } },
            select: { referenceCode: true, submittedAt: true, requestHash: true },
          });
          if (existing) return this.replay(existing, hash);

          const state = await tx.form.findUniqueOrThrow({
            where: { id: formId },
            select: {
              archivedAt: true,
              acceptingResponses: true,
              versions: latestVersionWithQuestions,
            },
          });
          const latest = state.versions[0];
          if (state.archivedAt || !state.acceptingResponses || !latest) {
            throw Errors.conflict(
              'RESPONSES_CLOSED',
              'استقبال الردود على هذا النموذج مغلق حاليًا، فلم يُرسل ردك.',
            );
          }
          if (input.versionId !== latest.id) {
            const belongs = await tx.formVersion.count({ where: { id: input.versionId, formId } });
            if (!belongs) {
              throw Errors.validation([
                { field: 'versionId', message: 'الإصدار غير صالح لهذا النموذج.' },
              ]);
            }
            throw Errors.conflict(
              'VERSION_OUTDATED',
              'نُشر تحديث لهذا النموذج بعد أن فتحته، فلم يُرسل ردك. حدّث النموذج للمتابعة؛ إجاباتك ما زالت في الصفحة.',
            );
          }

          const answers = validateAgainstVersion(
            latest.questions.map((q) => ({
              id: q.id,
              type: q.type as QuestionTypeKey,
              title: q.title,
              required: q.required,
              settings: (q.settings ?? {}) as Record<string, unknown>,
              options: q.options.map((o) => ({ id: o.id })),
            })),
            input.answers,
          );
          // الملفات: من جلسة التعبئة نفسها وللسؤال والإصدار نفسيهما، غير مرتبطة وغير منتهية؛ تُقفل حتى الربط.
          const fileAnswers = answers
            .filter((a) => a.fileIds)
            .map((a) => ({ questionId: a.questionId, fileIds: a.fileIds! }));
          await this.uploads.lockForSubmit(tx, input.fillSession, formId, latest.id, fileAnswers);

          const created = await tx.formResponse.create({
            data: {
              formId,
              versionId: latest.id,
              referenceCode: generateReferenceCode(),
              idempotencyKey: input.idempotencyKey,
              requestHash: hash,
              answers: {
                create: answers.map((a) => ({
                  questionId: a.questionId,
                  textValue: a.textValue,
                  numberValue:
                    a.numberValue !== undefined ? new Prisma.Decimal(a.numberValue) : undefined,
                  dateValue: a.dateValue,
                  options: a.optionIds
                    ? { create: a.optionIds.map((optionId) => ({ optionId })) }
                    : undefined,
                })),
              },
            },
            select: { id: true, referenceCode: true, submittedAt: true },
          });
          await this.uploads.attach(tx, created.id, fileAnswers);
          return {
            replayed: false,
            result: {
              referenceCode: created.referenceCode,
              submittedAt: created.submittedAt.toISOString(),
            },
          };
        });
      } catch (error) {
        const target = uniqueTarget(error);
        if (target?.includes('reference_code') && attempt < 3) continue; // تصادم رقم مرجعي نادر جدًا
        if (target?.includes('idempotency_key')) {
          // حماية إضافية: طلب متزامن حفظ أولًا بالمفتاح نفسه.
          const saved = await this.prisma.formResponse.findUnique({
            where: { formId_idempotencyKey: { formId, idempotencyKey: input.idempotencyKey } },
            select: { referenceCode: true, submittedAt: true, requestHash: true },
          });
          if (saved) return this.replay(saved, hash);
        }
        throw error;
      }
    }
  }

  private replay(
    saved: { referenceCode: string; submittedAt: Date; requestHash: string },
    hash: string,
  ): SubmitOutcome {
    if (saved.requestHash !== hash) {
      throw Errors.conflict(
        'IDEMPOTENCY_KEY_REUSED',
        'استُخدم مفتاح الإرسال هذا لرد بمحتوى مختلف. حدّث الصفحة ثم أعد الإرسال.',
      );
    }
    return {
      replayed: true,
      result: { referenceCode: saved.referenceCode, submittedAt: saved.submittedAt.toISOString() },
    };
  }
}
