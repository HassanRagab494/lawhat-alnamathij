import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Errors, type FieldError } from '../common/errors';
import {
  ANSWER_MAX_DECIMALS,
  QUESTION_LIMITS as L,
  type QuestionTypeKey,
} from '../forms/questions/limits';

/**
 * التحقق من الردود العامة. البنية يتحقق منها zod؛ المعنى (الأسئلة والخيارات والقيود)
 * يتحقق منه validateAgainstVersion بناءً على الإصدار المنشور المخزن فقط، لا على ما يرسله المتصفح.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (message: string) =>
  z
    .string({ required_error: message, invalid_type_error: message })
    .regex(UUID, message)
    .transform((v) => v.toLowerCase());

/** أطول قيمة نصية مقبولة بنيويًا (أكبر حد يمكن ضبطه لسؤال الفقرة). */
const MAX_TEXT = L.paragraphMaxLength;

const answer = z
  .object({
    questionId: uuid('معرّف السؤال غير صالح.'),
    value: z.union(
      [
        z.string().max(MAX_TEXT, `الإجابة يجب ألا تزيد عن ${MAX_TEXT} حرف.`),
        z
          .array(z.string().max(64, 'معرّف الخيار غير صالح.'))
          .max(L.maxOptions, `الحد الأقصى ${L.maxOptions} خيارًا.`),
      ],
      { errorMap: () => ({ message: 'نوع الإجابة غير صحيح.' }) },
    ),
  })
  .strict();

export const submitResponseSchema = z
  .object({
    versionId: uuid('معرّف الإصدار غير صالح.'),
    idempotencyKey: uuid('مفتاح الإرسال غير صالح.'),
    /** رمز جلسة التعبئة؛ مطلوب فقط إن أُرفقت ملفات. لا يدخل في بصمة الطلب. */
    fillSession: z.string().max(64, 'رمز جلسة التعبئة غير صالح.').optional(),
    answers: z
      .array(answer, { required_error: 'قائمة الإجابات مطلوبة.' })
      .max(L.maxQuestions, `الحد الأقصى ${L.maxQuestions} إجابة.`),
  })
  .strict();

export type SubmitResponseInput = z.output<typeof submitResponseSchema>;

const errorMap: z.ZodErrorMap = (issue, ctx) => {
  if (issue.code === z.ZodIssueCode.invalid_type) {
    return { message: issue.received === 'undefined' ? 'هذا الحقل مطلوب.' : 'القيمة غير صحيحة.' };
  }
  if (issue.code === z.ZodIssueCode.unrecognized_keys) return { message: 'حقل غير مسموح به.' };
  return { message: /[؀-ۿ]/.test(ctx.defaultError) ? ctx.defaultError : 'القيمة غير صحيحة.' };
};

export function parseSubmitResponse(body: unknown): SubmitResponseInput {
  const result = submitResponseSchema.safeParse(body, { errorMap });
  if (!result.success) {
    const seen = new Set<string>();
    const fields: FieldError[] = [];
    for (const issue of result.error.issues) {
      let field = issue.path.join('.');
      if (issue.code === z.ZodIssueCode.unrecognized_keys && issue.keys[0]) {
        field = field ? `${field}.${issue.keys[0]}` : issue.keys[0];
      }
      if (seen.has(field)) continue;
      seen.add(field);
      fields.push({ field, message: issue.message });
    }
    throw Errors.validation(fields);
  }
  return result.data;
}

/* ---------- التحقق مقابل الإصدار المنشور ---------- */

export interface VersionQuestionForValidation {
  id: string;
  type: QuestionTypeKey;
  title: string;
  required: boolean;
  settings: Record<string, unknown>;
  options: { id: string }[];
}

/** إجابة جاهزة للحفظ: عمود واحد حسب النوع. */
export interface NormalizedAnswer {
  questionId: string;
  textValue?: string;
  numberValue?: string;
  dateValue?: Date;
  optionIds?: string[];
  /** معرّفات ملفات مرفوعة؛ ملكيتها وصلاحيتها تُتحقق داخل معاملة الإرسال. */
  fileIds?: string[];
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function num(settings: Record<string, unknown>, key: string): number | undefined {
  const v = settings[key];
  return typeof v === 'number' ? v : undefined;
}
function str(settings: Record<string, unknown>, key: string): string | undefined {
  const v = settings[key];
  return typeof v === 'string' ? v : undefined;
}

function isValidDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * يتحقق من الإجابات وفق أسئلة الإصدار وإعداداتها، ويعيد إجابات مطبّعة للحفظ.
 * الأخطاء بمسار answers.<questionId> (أو answers.<index>.questionId للسؤال غير المعروف) ورسائل عربية.
 * السؤال الاختياري الفارغ لا يُحفظ؛ قيوده تُطبق فقط إذا أُجيب عنه.
 */
export function validateAgainstVersion(
  questions: VersionQuestionForValidation[],
  input: SubmitResponseInput['answers'],
): NormalizedAnswer[] {
  const errors: FieldError[] = [];
  const byId = new Map(questions.map((q) => [q.id, q]));
  const provided = new Map<string, string | string[]>();

  input.forEach((a, i) => {
    if (!byId.has(a.questionId)) {
      errors.push({
        field: `answers.${i}.questionId`,
        message: 'هذا السؤال لا يخص الإصدار الحالي.',
      });
    } else if (provided.has(a.questionId)) {
      errors.push({ field: `answers.${i}.questionId`, message: 'تكررت الإجابة على السؤال نفسه.' });
    } else {
      provided.set(a.questionId, a.value);
    }
  });

  const out: NormalizedAnswer[] = [];
  for (const q of questions) {
    const field = `answers.${q.id}`;
    const fail = (message: string) => errors.push({ field, message });
    const raw = provided.get(q.id);
    const s = q.settings ?? {};

    const empty = raw === undefined || (Array.isArray(raw) ? raw.length === 0 : raw.trim() === '');
    if (empty) {
      if (q.required) fail('هذا السؤال إجباري.');
      continue;
    }

    switch (q.type) {
      case 'SHORT_TEXT':
      case 'PARAGRAPH': {
        if (typeof raw !== 'string') {
          fail('نوع الإجابة غير صحيح.');
          break;
        }
        const text = raw.trim();
        const cap = q.type === 'SHORT_TEXT' ? L.shortTextMaxLength : L.paragraphMaxLength;
        const min = num(s, 'minLength');
        const max = Math.min(num(s, 'maxLength') ?? cap, cap);
        if (min !== undefined && text.length < min) fail(`يجب ألا تقل الإجابة عن ${min} حرف.`);
        else if (text.length > max) fail(`يجب ألا تزيد الإجابة عن ${max} حرف.`);
        else out.push({ questionId: q.id, textValue: text });
        break;
      }
      case 'NUMBER': {
        if (typeof raw !== 'string') {
          fail('نوع الإجابة غير صحيح.');
          break;
        }
        const text = raw.trim();
        if (!NUMBER_RE.test(text)) {
          fail('أدخل رقمًا صحيحًا.');
          break;
        }
        const decimals = text.includes('.') ? text.split('.')[1]!.length : 0;
        const value = Number(text);
        const allowDecimals = s.allowDecimals === true;
        if (!Number.isFinite(value) || Math.abs(value) > L.numberAbsMax) {
          fail('الرقم خارج الحدود المسموحة.');
        } else if (!allowDecimals && decimals > 0) {
          fail('أدخل عددًا صحيحًا دون كسور.');
        } else if (decimals > ANSWER_MAX_DECIMALS) {
          fail(`يُسمح بـ ${ANSWER_MAX_DECIMALS} خانات عشرية كحد أقصى.`);
        } else if (num(s, 'min') !== undefined && value < num(s, 'min')!) {
          fail(`يجب ألا يقل الرقم عن ${num(s, 'min')}.`);
        } else if (num(s, 'max') !== undefined && value > num(s, 'max')!) {
          fail(`يجب ألا يزيد الرقم عن ${num(s, 'max')}.`);
        } else {
          out.push({ questionId: q.id, numberValue: text });
        }
        break;
      }
      case 'DATE': {
        if (typeof raw !== 'string') {
          fail('نوع الإجابة غير صحيح.');
          break;
        }
        const v = raw.trim();
        const min = str(s, 'minDate');
        const max = str(s, 'maxDate');
        if (!isValidDate(v) || v < L.dateMin || v > L.dateMax) fail('أدخل تاريخًا صحيحًا.');
        else if (min && v < min) fail(`يجب ألا يكون التاريخ قبل ${min}.`);
        else if (max && v > max) fail(`يجب ألا يكون التاريخ بعد ${max}.`);
        else out.push({ questionId: q.id, dateValue: new Date(`${v}T00:00:00.000Z`) });
        break;
      }
      case 'SINGLE_CHOICE':
      case 'DROPDOWN': {
        if (typeof raw !== 'string') {
          fail('اختر خيارًا واحدًا فقط.');
          break;
        }
        const optionId = raw.trim().toLowerCase();
        if (!q.options.some((o) => o.id === optionId))
          fail('الخيار المحدد غير موجود في هذا السؤال.');
        else out.push({ questionId: q.id, optionIds: [optionId] });
        break;
      }
      case 'FILE_UPLOAD': {
        if (!Array.isArray(raw)) {
          fail('نوع الإجابة غير صحيح.');
          break;
        }
        const ids = raw.map((v) => v.trim().toLowerCase());
        const maxFiles = num(s, 'maxFiles') ?? 1;
        if (ids.some((id) => !UUID.test(id))) fail('معرّف الملف غير صالح.');
        else if (new Set(ids).size !== ids.length) fail('تكرر الملف نفسه.');
        else if (ids.length > maxFiles) fail(`الحد الأقصى ${maxFiles} ملفات.`);
        else out.push({ questionId: q.id, fileIds: ids });
        break;
      }
      case 'MULTIPLE_CHOICE': {
        if (!Array.isArray(raw)) {
          fail('نوع الإجابة غير صحيح.');
          break;
        }
        const ids = raw.map((v) => v.trim().toLowerCase());
        const valid = new Set(q.options.map((o) => o.id));
        const min = num(s, 'minSelections');
        const max = num(s, 'maxSelections');
        if (new Set(ids).size !== ids.length) fail('تكرر الخيار نفسه.');
        else if (ids.some((id) => !valid.has(id)))
          fail('أحد الخيارات المحددة غير موجود في هذا السؤال.');
        else if (min !== undefined && ids.length < min) fail(`اختر ${min} على الأقل.`);
        else if (max !== undefined && ids.length > max) fail(`اختر ${max} كحد أقصى.`);
        else out.push({ questionId: q.id, optionIds: ids });
        break;
      }
      default:
        fail('نوع السؤال غير مدعوم.');
    }
  }

  if (errors.length) throw Errors.validation(errors);
  return out;
}

/**
 * بصمة محتوى الطلب للكشف عن إعادة استخدام مفتاح الإرسال بمحتوى مختلف.
 * مطبّعة: الإجابات مرتبة بمعرّف السؤال، النصوص بعد إزالة المسافات المحيطة، الخيارات مرتبة،
 * والإجابات الفارغة محذوفة؛ فإعادة إرسال الطلب نفسه تعطي البصمة نفسها.
 */
export function requestHash(input: Pick<SubmitResponseInput, 'versionId' | 'answers'>): string {
  const answers = input.answers
    .map((a) => {
      const value = Array.isArray(a.value)
        ? [...a.value.map((v) => v.trim().toLowerCase())].sort()
        : a.value.trim();
      return [a.questionId, value] as const;
    })
    .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== ''))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify({ versionId: input.versionId, answers }), 'utf8')
    .digest('hex');
}
