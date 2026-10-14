import { isChoiceType, type FileTypeKey, type QuestionType } from './question-limits';

/**
 * نموذج عرض السؤال المشترك بين المعاينة والصفحة العامة لاحقًا.
 * الإعدادات أرقام/قيم نهائية (ليست نصوص المحرر).
 */
export interface RenderQuestion {
  key: string;
  type: QuestionType;
  title: string;
  description: string | null;
  required: boolean;
  settings: {
    minLength?: number;
    maxLength?: number;
    minSelections?: number;
    maxSelections?: number;
    min?: number;
    max?: number;
    allowDecimals?: boolean;
    minDate?: string;
    maxDate?: string;
    allowedTypes?: FileTypeKey[];
    maxFileSizeMb?: number;
    maxFiles?: number;
  };
  options: { key: string; label: string }[];
}

export type AnswerValue = string | string[] | undefined;

function isEmpty(v: AnswerValue): boolean {
  return v === undefined || (Array.isArray(v) ? v.length === 0 : v.trim() === '');
}

/** يتحقق من إجابة واحدة حسب إعدادات السؤال. يعيد رسالة عربية أو null. */
export function validateAnswer(q: RenderQuestion, value: AnswerValue): string | null {
  if (q.type === 'FILE_UPLOAD') {
    // في المعاينة لا يُرفع شيء؛ القيمة في الصفحة العامة هي معرّفات الملفات المقبولة.
    if (value === undefined) return null;
    const files = Array.isArray(value) ? value : [];
    if (!files.length) return q.required ? 'هذا السؤال إجباري؛ أرفق ملفًا واحدًا على الأقل.' : null;
    if (q.settings.maxFiles !== undefined && files.length > q.settings.maxFiles) {
      return `الحد الأقصى ${q.settings.maxFiles} ملفات.`;
    }
    return null;
  }
  if (isEmpty(value)) return q.required ? 'هذا السؤال إجباري.' : null;
  const s = q.settings;

  switch (q.type) {
    case 'SHORT_TEXT':
    case 'PARAGRAPH': {
      const len = (value as string).trim().length;
      if (s.minLength !== undefined && len < s.minLength) {
        return `يجب ألا تقل الإجابة عن ${s.minLength} حرف.`;
      }
      if (s.maxLength !== undefined && len > s.maxLength) {
        return `يجب ألا تزيد الإجابة عن ${s.maxLength} حرف.`;
      }
      return null;
    }
    case 'NUMBER': {
      const raw = (value as string).trim();
      const n = Number(raw);
      if (!/^-?\d+(\.\d+)?$/.test(raw) || !Number.isFinite(n)) return 'أدخل رقمًا صحيحًا.';
      if (!s.allowDecimals && !Number.isInteger(n)) return 'أدخل عددًا صحيحًا دون كسور.';
      if (s.min !== undefined && n < s.min) return `يجب ألا يقل الرقم عن ${s.min}.`;
      if (s.max !== undefined && n > s.max) return `يجب ألا يزيد الرقم عن ${s.max}.`;
      return null;
    }
    case 'DATE': {
      const v = value as string;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'أدخل تاريخًا صحيحًا.';
      if (s.minDate && v < s.minDate) return `يجب ألا يكون التاريخ قبل ${s.minDate}.`;
      if (s.maxDate && v > s.maxDate) return `يجب ألا يكون التاريخ بعد ${s.maxDate}.`;
      return null;
    }
    case 'SINGLE_CHOICE':
    case 'DROPDOWN': {
      return q.options.some((o) => o.key === value) ? null : 'اختر أحد الخيارات.';
    }
    case 'MULTIPLE_CHOICE': {
      const picked = (value as string[]).filter((k) => q.options.some((o) => o.key === k));
      if (s.minSelections !== undefined && picked.length < s.minSelections) {
        return `اختر ${s.minSelections} على الأقل.`;
      }
      if (s.maxSelections !== undefined && picked.length > s.maxSelections) {
        return `اختر ${s.maxSelections} كحد أقصى.`;
      }
      return null;
    }
    default:
      return null;
  }
}

export function validateAnswers(
  questions: RenderQuestion[],
  answers: Record<string, AnswerValue>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const q of questions) {
    const msg = validateAnswer(q, answers[q.key]);
    if (msg) errors[q.key] = msg;
  }
  return errors;
}

export { isChoiceType };
