import type { AnswerValue, RenderQuestion } from './answer-validation';
import type { QuestionType } from './question-limits';
import type { FieldError } from './types';

/** استجابة GET /api/public/forms/:publicId (انظر docs/api.md). */
export interface PublicOption {
  id: string;
  key: string;
  label: string;
}

export interface PublicQuestion {
  id: string;
  key: string;
  type: QuestionType;
  title: string;
  description: string | null;
  required: boolean;
  settings: RenderQuestion['settings'];
  options: PublicOption[];
}

export interface PublicForm {
  publicId: string;
  title: string;
  description: string | null;
  acceptingResponses: boolean;
  versionId: string | null;
  questions: PublicQuestion[];
}

export interface SubmitResult {
  referenceCode: string;
  submittedAt: string;
}

export interface SubmitPayload {
  versionId: string;
  idempotencyKey: string;
  /** رمز جلسة التعبئة عند إرفاق ملفات. */
  fillSession?: string;
  answers: { questionId: string; value: string | string[] }[];
}

/** الإجابات في الصفحة مفهرسة بالمفتاح المنطقي للسؤال والخيار، فتبقى صالحة عبر الإصدارات. */
export type PublicAnswers = Record<string, AnswerValue>;

export function toRenderQuestions(form: PublicForm): RenderQuestion[] {
  return form.questions.map((q) => ({
    key: q.key,
    type: q.type,
    title: q.title,
    description: q.description,
    required: q.required,
    settings: q.settings ?? {},
    options: q.options.map((o) => ({ key: o.key, label: o.label })),
  }));
}

function isEmpty(v: AnswerValue): boolean {
  return v === undefined || (Array.isArray(v) ? v.length === 0 : v.trim() === '');
}

/**
 * يحوّل الإجابات إلى جسم الطلب بمعرّفات الإصدار الحالي. الفارغ لا يُرسل.
 * سؤال الملفات: معرّفات الملفات التي قبلها الخادم فقط (لا محتوى ملفات).
 */
export function buildPayload(
  form: PublicForm,
  answers: PublicAnswers,
  idempotencyKey: string,
): SubmitPayload {
  const out: SubmitPayload['answers'] = [];
  for (const q of form.questions) {
    const value = answers[q.key];
    if (isEmpty(value)) continue;
    if (q.type === 'FILE_UPLOAD') {
      if (Array.isArray(value) && value.length) out.push({ questionId: q.id, value: [...value] });
      continue;
    }
    const optionId = (key: string) => q.options.find((o) => o.key === key)?.id;
    if (q.type === 'MULTIPLE_CHOICE') {
      const ids = (Array.isArray(value) ? value : [])
        .map(optionId)
        .filter((id): id is string => Boolean(id));
      if (ids.length) out.push({ questionId: q.id, value: ids });
    } else if (q.type === 'SINGLE_CHOICE' || q.type === 'DROPDOWN') {
      const id = typeof value === 'string' ? optionId(value) : undefined;
      if (id) out.push({ questionId: q.id, value: id });
    } else if (typeof value === 'string') {
      out.push({ questionId: q.id, value: value.trim() });
    }
  }
  return { versionId: form.versionId ?? '', idempotencyKey, answers: out };
}

/**
 * يوزع أخطاء الخادم على الأسئلة (answers.<questionId> → مفتاح السؤال).
 * ما لا يخص سؤالًا معروفًا يُعاد كرسائل عامة.
 */
export function mapServerErrors(
  form: PublicForm,
  fields: FieldError[],
): { byQuestion: Record<string, string>; general: string[] } {
  const keyById = new Map(form.questions.map((q) => [q.id, q.key]));
  const byQuestion: Record<string, string> = {};
  const general: string[] = [];
  for (const f of fields) {
    const match = /^answers\.([0-9a-f-]{36})$/i.exec(f.field);
    const key = match ? keyById.get(match[1]!.toLowerCase()) : undefined;
    if (key) byQuestion[key] ??= f.message;
    else if (!general.includes(f.message)) general.push(f.message);
  }
  return { byQuestion, general };
}

/**
 * ينقل الإجابات إلى إصدار أحدث: تبقى إجابات الأسئلة الموجودة فيه بمفتاحها المنطقي،
 * وتُحذف الخيارات التي لم تعد موجودة، وتُسقط القيم التي لا تناسب نوع السؤال الجديد.
 * الملفات مرتبطة بالإصدار القديم فلا تُنقل؛ يُطلب رفعها من جديد.
 */
export function carryOverAnswers(form: PublicForm, answers: PublicAnswers): PublicAnswers {
  const out: PublicAnswers = {};
  for (const q of form.questions) {
    const value = answers[q.key];
    if (value === undefined || q.type === 'FILE_UPLOAD') continue;
    const keys = new Set(q.options.map((o) => o.key));
    if (q.type === 'MULTIPLE_CHOICE') {
      const kept = (Array.isArray(value) ? value : [value]).filter((k) => keys.has(k));
      if (kept.length) out[q.key] = kept;
    } else if (q.type === 'SINGLE_CHOICE' || q.type === 'DROPDOWN') {
      const single = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
      if (single && keys.has(single)) out[q.key] = single;
    } else if (typeof value === 'string') {
      out[q.key] = value;
    }
  }
  return out;
}

export function hasAnyAnswer(answers: PublicAnswers): boolean {
  return Object.values(answers).some((v) => !isEmpty(v));
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
