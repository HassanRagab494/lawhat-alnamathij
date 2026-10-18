import { z } from 'zod';
import { Errors, type FieldError } from '../../common/errors';
import { FORM_DESCRIPTION_MAX, FORM_TITLE_MAX } from '../dto';
import {
  CHOICE_TYPES,
  FILE_TYPE_KEYS,
  QUESTION_LIMITS as L,
  VIDEO_TYPE_KEYS,
  type QuestionTypeKey,
} from './limits';

/**
 * المخطط الصارم لحفظ المسودة الكاملة (PUT /forms/:id/draft).
 * الخادم هو المرجع النهائي: يرفض الحقول غير المعروفة، والإعدادات التي لا تخص نوع السؤال،
 * والقيم خارج الحدود المركزية، ويعيد أخطاء عربية بمسار الحقل (مثل questions.2.settings.maxLength).
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const id = z
  .string()
  .regex(UUID_PATTERN, 'معرّف غير صالح.')
  .transform((v) => v.toLowerCase());

const int = (min: number, max: number) =>
  z
    .number()
    .finite('يجب أن يكون رقمًا محددًا.')
    .int('يجب أن يكون عددًا صحيحًا.')
    .min(min, `يجب ألا يقل عن ${min}.`)
    .max(max, `يجب ألا يزيد عن ${max}.`);

const boundedNumber = z
  .number()
  .finite('يجب أن يكون رقمًا محددًا.')
  .min(-L.numberAbsMax, 'القيمة خارج الحدود المسموحة.')
  .max(L.numberAbsMax, 'القيمة خارج الحدود المسموحة.');

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const dateString = z
  .string()
  .refine(isValidDate, 'التاريخ غير صالح.')
  .refine(
    (v) => v >= L.dateMin && v <= L.dateMax,
    `التاريخ يجب أن يكون بين ${L.dateMin} و${L.dateMax}.`,
  );

const optionalNullableText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} يجب ألا يزيد عن ${max} حرف.`)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

function minNotAboveMax<T extends Record<string, unknown>>(
  minKey: keyof T & string,
  maxKey: keyof T & string,
  message: string,
) {
  return (value: T, ctx: z.RefinementCtx) => {
    const min = value[minKey];
    const max = value[maxKey];
    if (
      min !== undefined &&
      max !== undefined &&
      (min as number | string) > (max as number | string)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [minKey], message });
    }
  };
}

const textSettings = (limit: number) =>
  z
    .object({
      minLength: int(0, limit).optional(),
      maxLength: int(1, limit).optional(),
    })
    .strict()
    .superRefine(minNotAboveMax('minLength', 'maxLength', 'الحد الأدنى للطول يتجاوز الحد الأقصى.'));

const noSettings = z.object({}).strict();

const multipleChoiceSettings = z
  .object({
    minSelections: int(1, L.maxOptions).optional(),
    maxSelections: int(1, L.maxOptions).optional(),
  })
  .strict()
  .superRefine(
    minNotAboveMax('minSelections', 'maxSelections', 'الحد الأدنى للاختيارات يتجاوز الحد الأقصى.'),
  );

const numberSettings = z
  .object({
    min: boundedNumber.optional(),
    max: boundedNumber.optional(),
    allowDecimals: z.boolean({
      required_error: 'حدد السماح بالكسور أو الأعداد الصحيحة فقط.',
      invalid_type_error: 'القيمة غير صحيحة.',
    }),
  })
  .strict()
  .superRefine((value, ctx) => {
    minNotAboveMax('min', 'max', 'الحد الأدنى يتجاوز الحد الأقصى.')(value, ctx);
    if (!value.allowDecimals) {
      for (const key of ['min', 'max'] as const) {
        const v = value[key];
        if (v !== undefined && !Number.isInteger(v)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'يجب أن يكون عددًا صحيحًا لأن الكسور غير مسموحة.',
          });
        }
      }
    }
  });

const dateSettings = z
  .object({ minDate: dateString.optional(), maxDate: dateString.optional() })
  .strict()
  .superRefine(minNotAboveMax('minDate', 'maxDate', 'التاريخ الأدنى بعد التاريخ الأقصى.'));

const fileSettings = z
  .object({
    allowedTypes: z
      .array(z.enum(FILE_TYPE_KEYS), {
        required_error: 'اختر نوع ملف واحدًا على الأقل.',
      })
      .min(1, 'اختر نوع ملف واحدًا على الأقل.')
      .refine((list) => new Set(list).size === list.length, 'لا تكرر نوع الملف نفسه.'),
    maxFileSizeMb: int(1, L.videoMaxSizeMb),
    maxFiles: int(1, L.fileMaxCount),
  })
  .strict()
  .superRefine((value, ctx) => {
    // حتى videoMaxSizeMb فقط إن كان السؤال يقبل الفيديو؛ وإلا الحد العام للصور والمستندات
    const video = value.allowedTypes.some((t) => VIDEO_TYPE_KEYS.includes(t));
    if (!video && value.maxFileSizeMb > L.fileMaxSizeMb) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxFileSizeMb'],
        message: `يجب ألا يزيد عن ${L.fileMaxSizeMb} (حتى ${L.videoMaxSizeMb} عند السماح بالفيديو).`,
      });
    }
  });

/** هوية دلالية ثابتة (مثل offer.price أو apartment)؛ يضعها القالب ولا تتغير بتغيير الصياغة. */
export const SEMANTIC_KEY_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;
const semanticKey = z
  .string()
  .regex(SEMANTIC_KEY_PATTERN, 'الهوية الدلالية غير صالحة.')
  .nullable()
  .optional()
  .transform((v) => v ?? null);

/**
 * شرط الظهور بالمواقع في القائمة المرسلة نفسها (لأن الأسئلة والخيارات الجديدة بلا معرّفات بعد).
 * الخادم يحوّله إلى معرّفات ثابتة عند الحفظ.
 */
const showIf = z
  .object({
    questionIndex: int(0, L.maxQuestions - 1),
    optionIndexes: z
      .array(int(0, L.maxOptions - 1))
      .min(1, 'اختر خيارًا واحدًا على الأقل يُظهر هذا السؤال.')
      .max(L.maxOptions, `الحد الأقصى ${L.maxOptions} خيارًا.`),
  })
  .strict()
  .nullable()
  .optional()
  .transform((v) => v ?? null);

const option = z
  .object({
    id: id.optional(),
    semanticKey,
    label: z
      .string()
      .trim()
      .min(1, 'نص الخيار مطلوب.')
      .max(L.optionLabelMax, `نص الخيار يجب ألا يزيد عن ${L.optionLabelMax} حرف.`),
  })
  .strict();

const choiceOptions = z
  .array(option, { required_error: 'أضف خيارين على الأقل.' })
  .min(L.minOptions, `أضف ${L.minOptions} خيارات على الأقل.`)
  .max(L.maxOptions, `الحد الأقصى ${L.maxOptions} خيارًا.`);

const noOptions = z.array(z.unknown()).max(0, 'هذا النوع لا يقبل خيارات.').optional().default([]);

const base = {
  id: id.optional(),
  title: z
    .string({ required_error: 'عنوان السؤال مطلوب.' })
    .trim()
    .min(1, 'عنوان السؤال مطلوب.')
    .max(L.questionTitleMax, `عنوان السؤال يجب ألا يزيد عن ${L.questionTitleMax} حرف.`),
  description: optionalNullableText(L.questionDescriptionMax, 'الوصف المساعد'),
  required: z.boolean({ required_error: 'حدد إن كان السؤال إجباريًا.' }),
  showIf,
  semanticKey,
};

const question = z.discriminatedUnion(
  'type',
  [
    z
      .object({
        ...base,
        type: z.literal('SHORT_TEXT'),
        settings: textSettings(L.shortTextMaxLength),
        options: noOptions,
      })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal('PARAGRAPH'),
        settings: textSettings(L.paragraphMaxLength),
        options: noOptions,
      })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal('SINGLE_CHOICE'),
        settings: noSettings,
        options: choiceOptions,
      })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal('MULTIPLE_CHOICE'),
        settings: multipleChoiceSettings,
        options: choiceOptions,
      })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal('DROPDOWN'),
        settings: noSettings,
        options: choiceOptions,
      })
      .strict(),
    z
      .object({ ...base, type: z.literal('NUMBER'), settings: numberSettings, options: noOptions })
      .strict(),
    z
      .object({ ...base, type: z.literal('DATE'), settings: dateSettings, options: noOptions })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal('FILE_UPLOAD'),
        settings: fileSettings,
        options: noOptions,
      })
      .strict(),
  ],
  { errorMap: () => ({ message: 'نوع السؤال غير معروف.' }) },
);

export const saveDraftSchema = z
  .object({
    revision: int(1, Number.MAX_SAFE_INTEGER),
    title: z
      .string({ required_error: 'عنوان النموذج مطلوب.' })
      .trim()
      .min(1, 'عنوان النموذج مطلوب.')
      .max(FORM_TITLE_MAX, `عنوان النموذج يجب ألا يزيد عن ${FORM_TITLE_MAX} حرف.`),
    description: optionalNullableText(FORM_DESCRIPTION_MAX, 'الوصف'),
    questions: z
      .array(question, { required_error: 'قائمة الأسئلة مطلوبة.' })
      .max(L.maxQuestions, `الحد الأقصى ${L.maxQuestions} سؤالًا.`),
  })
  .strict()
  .superRefine((draft, ctx) => {
    const questionIds = new Set<string>();
    const optionIds = new Set<string>();
    const semanticKeys = new Set<string>();
    draft.questions.forEach((q, qi) => {
      if (q.semanticKey) {
        if (semanticKeys.has(q.semanticKey)) {
          ctx.addIssue({
            code: 'custom',
            path: ['questions', qi, 'semanticKey'],
            message: 'الهوية الدلالية مكررة في النموذج.',
          });
        }
        semanticKeys.add(q.semanticKey);
      }
      checkShowIf(draft.questions, qi, ctx);
      if (q.id) {
        if (questionIds.has(q.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['questions', qi, 'id'],
            message: 'معرّف السؤال مكرر.',
          });
        }
        questionIds.add(q.id);
      }
      const labels = new Set<string>();
      const optionKeys = new Set<string>();
      q.options.forEach((o, oi) => {
        const opt = o as OptionInput;
        if (opt.semanticKey) {
          if (optionKeys.has(opt.semanticKey)) {
            ctx.addIssue({
              code: 'custom',
              path: ['questions', qi, 'options', oi, 'semanticKey'],
              message: 'الهوية الدلالية للخيار مكررة.',
            });
          }
          optionKeys.add(opt.semanticKey);
        }
        if (opt.id) {
          if (optionIds.has(opt.id)) {
            ctx.addIssue({
              code: 'custom',
              path: ['questions', qi, 'options', oi, 'id'],
              message: 'معرّف الخيار مكرر.',
            });
          }
          optionIds.add(opt.id);
        }
        const normalized = opt.label.toLocaleLowerCase('ar');
        if (labels.has(normalized)) {
          ctx.addIssue({
            code: 'custom',
            path: ['questions', qi, 'options', oi, 'label'],
            message: 'هذا الخيار مكرر.',
          });
        }
        labels.add(normalized);
      });
      if (q.type === 'MULTIPLE_CHOICE') {
        for (const key of ['minSelections', 'maxSelections'] as const) {
          const v = q.settings[key];
          if (v !== undefined && v > q.options.length) {
            ctx.addIssue({
              code: 'custom',
              path: ['questions', qi, 'settings', key],
              message: 'يتجاوز عدد الخيارات المتاحة.',
            });
          }
        }
      }
    });
  });

export type SaveDraftInput = z.output<typeof saveDraftSchema>;
export type QuestionInput = SaveDraftInput['questions'][number];
export type OptionInput = { id?: string; label: string; semanticKey?: string | null };
export type ShowIfInput = NonNullable<QuestionInput['showIf']>;

/**
 * يرفض الشروط غير الصحيحة: الإشارة إلى سؤال لاحق أو إلى السؤال نفسه (تمنع الدورات)،
 * أو إلى سؤال ليس من أنواع الاختيار، أو إلى خيارات غير موجودة أو مكررة.
 */
function checkShowIf(
  questions: { type: string; options: unknown[]; showIf?: ShowIfInput | null }[],
  qi: number,
  ctx: z.RefinementCtx,
): void {
  const cond = questions[qi]!.showIf;
  if (!cond) return;
  const path = ['questions', qi, 'showIf'];
  const issue = (message: string, extra: (string | number)[] = []) =>
    ctx.addIssue({ code: 'custom', path: [...path, ...extra], message });
  if (cond.questionIndex >= qi) {
    issue('الشرط يجب أن يعتمد على سؤال سابق لهذا السؤال.', ['questionIndex']);
    return;
  }
  const target = questions[cond.questionIndex]!;
  if (!CHOICE_TYPES.includes(target.type as QuestionTypeKey)) {
    issue('الشرط يجب أن يعتمد على سؤال اختيار (اختيار واحد أو متعدد أو قائمة).', ['questionIndex']);
    return;
  }
  if (new Set(cond.optionIndexes).size !== cond.optionIndexes.length) {
    issue('تكرر الخيار نفسه في الشرط.', ['optionIndexes']);
  } else if (cond.optionIndexes.some((i) => i >= target.options.length)) {
    issue('أحد خيارات الشرط غير موجود في السؤال المرتبط.', ['optionIndexes']);
  }
}

const errorMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return { message: issue.received === 'undefined' ? 'هذا الحقل مطلوب.' : 'القيمة غير صحيحة.' };
    case z.ZodIssueCode.unrecognized_keys:
      return {
        message:
          issue.path[issue.path.length - 1] === 'settings'
            ? 'إعدادات لا تخص نوع السؤال.'
            : 'حقل غير مسموح به.',
      };
    case z.ZodIssueCode.invalid_enum_value:
      return {
        message: issue.path.includes('allowedTypes') ? 'نوع ملف غير مسموح.' : 'القيمة غير مسموحة.',
      };
    case z.ZodIssueCode.invalid_literal:
      return { message: 'القيمة غير مسموحة.' };
    default:
      return { message: /[؀-ۿ]/.test(ctx.defaultError) ? ctx.defaultError : 'القيمة غير صحيحة.' };
  }
};

function toFieldErrors(error: z.ZodError): FieldError[] {
  const seen = new Set<string>();
  const fields: FieldError[] = [];
  for (const issue of error.issues) {
    let path = issue.path.join('.');
    if (issue.code === z.ZodIssueCode.unrecognized_keys && issue.keys[0]) {
      path = path ? `${path}.${issue.keys[0]}` : issue.keys[0];
    }
    if (seen.has(path)) continue;
    seen.add(path);
    fields.push({ field: path, message: issue.message });
  }
  return fields;
}

/** يتحقق من جسم الطلب ويعيد مسودة مطبّعة، أو يرمي 400 VALIDATION_FAILED بأخطاء حقول عربية. */
export function parseSaveDraft(body: unknown): SaveDraftInput {
  const result = saveDraftSchema.safeParse(body, { errorMap });
  if (!result.success) throw Errors.validation(toFieldErrors(result.error));
  return result.data;
}

export function isChoiceType(type: QuestionTypeKey): boolean {
  return CHOICE_TYPES.includes(type);
}
