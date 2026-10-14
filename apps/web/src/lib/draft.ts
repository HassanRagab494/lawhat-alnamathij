import type { FormItem } from './types';
import type { RenderQuestion } from './answer-validation';
import {
  FORM_DESCRIPTION_MAX,
  FORM_TITLE_MAX,
  QUESTION_LIMITS as L,
  VIDEO_TYPE_KEYS,
  isChoiceType,
  type FileTypeKey,
  type QuestionType,
} from './question-limits';

/* ---------- شكل البيانات من الـ API ---------- */

export interface ServerOption {
  id: string;
  label: string;
}

export interface ServerQuestion {
  id: string;
  type: QuestionType;
  title: string;
  description: string | null;
  required: boolean;
  settings: Record<string, unknown>;
  options: ServerOption[];
}

export interface FormDraft extends FormItem {
  questions: ServerQuestion[];
}

/* ---------- حالة المحرر المحلية ---------- */

/** الأرقام تُحفظ نصوصًا في المحرر حتى يمكن ترك الحقل فارغًا أثناء الكتابة. */
export interface EditorSettings {
  minLength: string;
  maxLength: string;
  minSelections: string;
  maxSelections: string;
  min: string;
  max: string;
  allowDecimals: boolean;
  minDate: string;
  maxDate: string;
  allowedTypes: FileTypeKey[];
  maxFileSizeMb: string;
  maxFiles: string;
}

export interface EditorOption {
  /** مفتاح محلي ثابت للعرض فقط؛ لا يُرسل للخادم. */
  key: string;
  /** معرّف الخادم إن كان الخيار محفوظًا. */
  id?: string;
  label: string;
}

export interface EditorQuestion {
  key: string;
  id?: string;
  type: QuestionType;
  title: string;
  description: string;
  required: boolean;
  settings: EditorSettings;
  options: EditorOption[];
}

export interface EditorDraft {
  title: string;
  description: string;
  questions: EditorQuestion[];
}

let keySeq = 0;
/** الحد الأقصى القابل للضبط لحجم الملف: أكبر عند السماح بالفيديو (مطابق للخادم). */
export function maxFileSizeFor(types: readonly FileTypeKey[]): number {
  return types.some((t) => VIDEO_TYPE_KEYS.includes(t)) ? L.videoMaxSizeMb : L.fileMaxSizeMb;
}

export function newKey(): string {
  keySeq += 1;
  return `k${Date.now().toString(36)}${keySeq}`;
}

export function emptySettings(): EditorSettings {
  return {
    minLength: '',
    maxLength: '',
    minSelections: '',
    maxSelections: '',
    min: '',
    max: '',
    allowDecimals: false,
    minDate: '',
    maxDate: '',
    allowedTypes: [],
    maxFileSizeMb: '',
    maxFiles: '',
  };
}

/** الإعدادات الافتراضية عند اختيار نوع (سؤال جديد أو تغيير نوع). */
export function defaultSettings(type: QuestionType): EditorSettings {
  const s = emptySettings();
  if (type === 'FILE_UPLOAD') {
    s.allowedTypes = ['pdf'];
    s.maxFileSizeMb = '5';
    s.maxFiles = '1';
  }
  return s;
}

export function newQuestion(type: QuestionType): EditorQuestion {
  return {
    key: newKey(),
    type,
    title: '',
    description: '',
    required: false,
    settings: defaultSettings(type),
    options: isChoiceType(type)
      ? [
          { key: newKey(), label: 'الخيار 1' },
          { key: newKey(), label: 'الخيار 2' },
        ]
      : [],
  };
}

const str = (v: unknown) => (typeof v === 'number' || typeof v === 'string' ? String(v) : '');

export function fromServer(
  draft: Pick<FormDraft, 'title' | 'description' | 'questions'>,
): EditorDraft {
  return {
    title: draft.title,
    description: draft.description ?? '',
    questions: draft.questions.map((q) => {
      const s = q.settings ?? {};
      return {
        key: newKey(),
        id: q.id,
        type: q.type,
        title: q.title,
        description: q.description ?? '',
        required: q.required,
        settings: {
          ...emptySettings(),
          minLength: str(s.minLength),
          maxLength: str(s.maxLength),
          minSelections: str(s.minSelections),
          maxSelections: str(s.maxSelections),
          min: str(s.min),
          max: str(s.max),
          allowDecimals: s.allowDecimals === true,
          minDate: str(s.minDate),
          maxDate: str(s.maxDate),
          allowedTypes: Array.isArray(s.allowedTypes) ? (s.allowedTypes as FileTypeKey[]) : [],
          maxFileSizeMb: str(s.maxFileSizeMb),
          maxFiles: str(s.maxFiles),
        },
        options: q.options.map((o) => ({ key: newKey(), id: o.id, label: o.label })),
      };
    }),
  };
}

/** الحقول التي تخص كل نوع من الإعدادات. */
export const SETTINGS_BY_TYPE: Record<QuestionType, (keyof EditorSettings)[]> = {
  SHORT_TEXT: ['minLength', 'maxLength'],
  PARAGRAPH: ['minLength', 'maxLength'],
  SINGLE_CHOICE: [],
  DROPDOWN: [],
  MULTIPLE_CHOICE: ['minSelections', 'maxSelections'],
  NUMBER: ['min', 'max', 'allowDecimals'],
  DATE: ['minDate', 'maxDate'],
  FILE_UPLOAD: ['allowedTypes', 'maxFileSizeMb', 'maxFiles'],
};

const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

/** يحوّل إعدادات المحرر إلى إعدادات الخادم حسب النوع فقط. */
export function settingsPayload(type: QuestionType, s: EditorSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value !== undefined && value !== '') out[key] = value;
  };
  switch (type) {
    case 'SHORT_TEXT':
    case 'PARAGRAPH':
      put('minLength', num(s.minLength));
      put('maxLength', num(s.maxLength));
      break;
    case 'MULTIPLE_CHOICE':
      put('minSelections', num(s.minSelections));
      put('maxSelections', num(s.maxSelections));
      break;
    case 'NUMBER':
      out.allowDecimals = s.allowDecimals;
      put('min', num(s.min));
      put('max', num(s.max));
      break;
    case 'DATE':
      put('minDate', s.minDate || undefined);
      put('maxDate', s.maxDate || undefined);
      break;
    case 'FILE_UPLOAD':
      out.allowedTypes = s.allowedTypes;
      put('maxFileSizeMb', num(s.maxFileSizeMb));
      put('maxFiles', num(s.maxFiles));
      break;
    default:
      break;
  }
  return out;
}

export interface SaveDraftPayload {
  revision: number;
  title: string;
  description: string | null;
  questions: {
    id?: string;
    type: QuestionType;
    title: string;
    description: string | null;
    required: boolean;
    settings: Record<string, unknown>;
    options: { id?: string; label: string }[];
  }[];
}

export function toPayload(draft: EditorDraft, revision: number): SaveDraftPayload {
  return {
    revision,
    title: draft.title.trim(),
    description: draft.description.trim() ? draft.description.trim() : null,
    questions: draft.questions.map((q) => ({
      ...(q.id ? { id: q.id } : {}),
      type: q.type,
      title: q.title.trim(),
      description: q.description.trim() ? q.description.trim() : null,
      required: q.required,
      settings: settingsPayload(q.type, q.settings),
      options: isChoiceType(q.type)
        ? q.options.map((o) => ({ ...(o.id ? { id: o.id } : {}), label: o.label.trim() }))
        : [],
    })),
  };
}

/** بصمة المحتوى لمقارنة التغييرات غير المحفوظة (تتجاهل المفاتيح المحلية). */
export function snapshot(draft: EditorDraft): string {
  return JSON.stringify(toPayload(draft, 0));
}

/* ---------- تغيير نوع السؤال ---------- */

function hasValue(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'boolean') return v;
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * يغيّر النوع مع الاحتفاظ بالعنوان والوصف والإلزام، ويمسح الإعدادات غير المتوافقة.
 * losesData = true إن كان التغيير سيفقد خيارات أو إعدادات أدخلها المستخدم (يتطلب تأكيدًا).
 */
export function changeQuestionType(
  q: EditorQuestion,
  type: QuestionType,
): { question: EditorQuestion; losesData: boolean } {
  if (q.type === type) return { question: q, losesData: false };
  const keep = new Set(SETTINGS_BY_TYPE[type]);
  const lostSettings = SETTINGS_BY_TYPE[q.type].some(
    (k) => !keep.has(k) && hasValue(q.settings[k]) && !isDefaultFor(q.type, k, q.settings),
  );
  const keepOptions = isChoiceType(type) && isChoiceType(q.type);
  const lostOptions = !keepOptions && q.options.some((o) => o.label.trim() !== '');

  // تُنقل فقط الإعدادات المشتركة بين النوعين (مثل حدود الطول بين الإجابة القصيرة والفقرة).
  const settings = defaultSettings(type);
  const shared = SETTINGS_BY_TYPE[q.type].filter((k) => keep.has(k));
  for (const k of shared) (settings as unknown as Record<string, unknown>)[k] = q.settings[k];

  return {
    question: {
      ...q,
      type,
      settings,
      options: keepOptions ? q.options : isChoiceType(type) ? newQuestion(type).options : [],
    },
    losesData: lostSettings || lostOptions,
  };
}

function isDefaultFor(type: QuestionType, key: keyof EditorSettings, s: EditorSettings): boolean {
  const d = defaultSettings(type)[key];
  return JSON.stringify(d) === JSON.stringify(s[key]);
}

/* ---------- التحقق المحلي (مطابق لقواعد الخادم) ---------- */

export type DraftErrors = Record<string, string>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function checkInt(
  errors: DraftErrors,
  path: string,
  raw: string,
  min: number,
  max: number,
): number | undefined {
  if (raw.trim() === '') return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v)) errors[path] = 'يجب أن يكون رقمًا.';
  else if (!Number.isInteger(v)) errors[path] = 'يجب أن يكون عددًا صحيحًا.';
  else if (v < min) errors[path] = `يجب ألا يقل عن ${min}.`;
  else if (v > max) errors[path] = `يجب ألا يزيد عن ${max}.`;
  else return v;
  return undefined;
}

/** يعيد أخطاء بمسارات الخادم نفسها (questions.0.title ...) حتى تُعرض بجانب الحقل. */
export function validateDraft(draft: EditorDraft): DraftErrors {
  const e: DraftErrors = {};
  const title = draft.title.trim();
  if (!title) e.title = 'عنوان النموذج مطلوب.';
  else if (title.length > FORM_TITLE_MAX)
    e.title = `عنوان النموذج يجب ألا يزيد عن ${FORM_TITLE_MAX} حرف.`;
  if (draft.description.trim().length > FORM_DESCRIPTION_MAX) {
    e.description = `الوصف يجب ألا يزيد عن ${FORM_DESCRIPTION_MAX} حرف.`;
  }
  if (draft.questions.length > L.maxQuestions)
    e.questions = `الحد الأقصى ${L.maxQuestions} سؤالًا.`;

  draft.questions.forEach((q, i) => {
    const p = `questions.${i}`;
    const t = q.title.trim();
    if (!t) e[`${p}.title`] = 'عنوان السؤال مطلوب.';
    else if (t.length > L.questionTitleMax) {
      e[`${p}.title`] = `عنوان السؤال يجب ألا يزيد عن ${L.questionTitleMax} حرف.`;
    }
    if (q.description.trim().length > L.questionDescriptionMax) {
      e[`${p}.description`] = `الوصف المساعد يجب ألا يزيد عن ${L.questionDescriptionMax} حرف.`;
    }
    const s = q.settings;
    const sp = `${p}.settings`;
    switch (q.type) {
      case 'SHORT_TEXT':
      case 'PARAGRAPH': {
        const limit = q.type === 'SHORT_TEXT' ? L.shortTextMaxLength : L.paragraphMaxLength;
        const min = checkInt(e, `${sp}.minLength`, s.minLength, 0, limit);
        const max = checkInt(e, `${sp}.maxLength`, s.maxLength, 1, limit);
        if (min !== undefined && max !== undefined && min > max) {
          e[`${sp}.minLength`] = 'الحد الأدنى للطول يتجاوز الحد الأقصى.';
        }
        break;
      }
      case 'MULTIPLE_CHOICE': {
        const min = checkInt(e, `${sp}.minSelections`, s.minSelections, 1, L.maxOptions);
        const max = checkInt(e, `${sp}.maxSelections`, s.maxSelections, 1, L.maxOptions);
        if (min !== undefined && max !== undefined && min > max) {
          e[`${sp}.minSelections`] = 'الحد الأدنى للاختيارات يتجاوز الحد الأقصى.';
        }
        for (const [k, v] of [
          ['minSelections', min],
          ['maxSelections', max],
        ] as const) {
          if (v !== undefined && v > q.options.length && !e[`${sp}.${k}`]) {
            e[`${sp}.${k}`] = 'يتجاوز عدد الخيارات المتاحة.';
          }
        }
        break;
      }
      case 'NUMBER': {
        const vals: Record<string, number> = {};
        for (const k of ['min', 'max'] as const) {
          const raw = s[k].trim();
          if (!raw) continue;
          const v = Number(raw);
          if (!Number.isFinite(v)) e[`${sp}.${k}`] = 'يجب أن يكون رقمًا.';
          else if (Math.abs(v) > L.numberAbsMax) e[`${sp}.${k}`] = 'القيمة خارج الحدود المسموحة.';
          else if (!s.allowDecimals && !Number.isInteger(v)) {
            e[`${sp}.${k}`] = 'يجب أن يكون عددًا صحيحًا لأن الكسور غير مسموحة.';
          } else vals[k] = v;
        }
        if (vals.min !== undefined && vals.max !== undefined && vals.min > vals.max) {
          e[`${sp}.min`] = 'الحد الأدنى يتجاوز الحد الأقصى.';
        }
        break;
      }
      case 'DATE': {
        for (const k of ['minDate', 'maxDate'] as const) {
          const v = s[k];
          if (!v) continue;
          if (!validDate(v)) e[`${sp}.${k}`] = 'التاريخ غير صالح.';
          else if (v < L.dateMin || v > L.dateMax) {
            e[`${sp}.${k}`] = `التاريخ يجب أن يكون بين ${L.dateMin} و${L.dateMax}.`;
          }
        }
        if (
          s.minDate &&
          s.maxDate &&
          !e[`${sp}.minDate`] &&
          !e[`${sp}.maxDate`] &&
          s.minDate > s.maxDate
        ) {
          e[`${sp}.minDate`] = 'التاريخ الأدنى بعد التاريخ الأقصى.';
        }
        break;
      }
      case 'FILE_UPLOAD': {
        if (!s.allowedTypes.length) e[`${sp}.allowedTypes`] = 'اختر نوع ملف واحدًا على الأقل.';
        if (!s.maxFileSizeMb.trim()) e[`${sp}.maxFileSizeMb`] = 'هذا الحقل مطلوب.';
        else checkInt(e, `${sp}.maxFileSizeMb`, s.maxFileSizeMb, 1, maxFileSizeFor(s.allowedTypes));
        if (!s.maxFiles.trim()) e[`${sp}.maxFiles`] = 'هذا الحقل مطلوب.';
        else checkInt(e, `${sp}.maxFiles`, s.maxFiles, 1, L.fileMaxCount);
        break;
      }
      default:
        break;
    }
    if (isChoiceType(q.type)) {
      if (q.options.length < L.minOptions)
        e[`${p}.options`] = `أضف ${L.minOptions} خيارات على الأقل.`;
      if (q.options.length > L.maxOptions)
        e[`${p}.options`] = `الحد الأقصى ${L.maxOptions} خيارًا.`;
      const seen = new Set<string>();
      q.options.forEach((o, oi) => {
        const label = o.label.trim();
        const op = `${p}.options.${oi}.label`;
        if (!label) e[op] = 'نص الخيار مطلوب.';
        else if (label.length > L.optionLabelMax)
          e[op] = `نص الخيار يجب ألا يزيد عن ${L.optionLabelMax} حرف.`;
        else {
          const norm = label.toLocaleLowerCase('ar');
          if (seen.has(norm)) e[op] = 'هذا الخيار مكرر.';
          seen.add(norm);
        }
      });
    }
  });
  return e;
}

/** عدد الأسئلة التي فيها أخطاء، لعرض ملخص أعلى المحرر. */
export function questionsWithErrors(errors: DraftErrors): number[] {
  const set = new Set<number>();
  for (const k of Object.keys(errors)) {
    const m = /^questions\.(\d+)\./.exec(k);
    if (m) set.add(Number(m[1]));
  }
  return [...set].sort((a, b) => a - b);
}

/* ---------- التعارض ---------- */

/**
 * «الإبقاء على تعديلاتي» بعد تعارض: يُبقي المحتوى المحلي كما هو، لكن يزيل معرّفات الأسئلة والخيارات
 * التي لم تعد موجودة في نسخة الخادم (حذفها مستخدم آخر) فتُعامل كجديدة، حتى لا يُرفض الحفظ التالي.
 */
export function rebaseOnServer(local: EditorDraft, server: FormDraft): EditorDraft {
  const serverQuestions = new Map(server.questions.map((q) => [q.id, q]));
  return {
    ...local,
    questions: local.questions.map((q) => {
      const sq = q.id ? serverQuestions.get(q.id) : undefined;
      if (!sq)
        return { ...q, id: undefined, options: q.options.map((o) => ({ ...o, id: undefined })) };
      const optionIds = new Set(sq.options.map((o) => o.id));
      return {
        ...q,
        options: q.options.map((o) => (o.id && optionIds.has(o.id) ? o : { ...o, id: undefined })),
      };
    }),
  };
}

export function moveItem<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/* ---------- المعاينة ---------- */

/** يحوّل حالة المحرر (بما فيها غير المحفوظة) إلى نموذج العرض، متجاهلًا القيم غير الصالحة بعد. */
export function toRenderQuestions(draft: EditorDraft): RenderQuestion[] {
  return draft.questions.map((q) => {
    const payload = settingsPayload(q.type, q.settings);
    const settings: RenderQuestion['settings'] = {};
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'number' && !Number.isFinite(v)) continue;
      (settings as Record<string, unknown>)[k] = v;
    }
    return {
      key: q.key,
      type: q.type,
      title: q.title.trim() || 'سؤال بلا عنوان',
      description: q.description.trim() || null,
      required: q.required,
      settings,
      options: isChoiceType(q.type)
        ? q.options
            .filter((o) => o.label.trim() !== '')
            .map((o) => ({ key: o.key, label: o.label.trim() }))
        : [],
    };
  });
}
