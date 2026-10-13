/**
 * الحدود المركزية لمحرر النموذج (المرحلة الثانية).
 *
 * يطبقها الخادم في draft-schema.ts، وتستخدم الواجهة نسخة مطابقة في
 * apps/web/src/lib/question-limits.ts. اختبار apps/web/src/lib/question-limits.test.ts
 * يفشل إن اختلفت النسختان، فعدّل الملفين معًا.
 */
export const QUESTION_LIMITS = {
  /** أقصى عدد أسئلة في المسودة. */
  maxQuestions: 100,
  /** أقصى عدد خيارات لسؤال الاختيار. */
  maxOptions: 50,
  /** أقل عدد خيارات لسؤال الاختيار. */
  minOptions: 2,
  questionTitleMax: 300,
  questionDescriptionMax: 1000,
  optionLabelMax: 200,
  /** أقصى حد يمكن ضبطه لطول الإجابة القصيرة. */
  shortTextMaxLength: 500,
  /** أقصى حد يمكن ضبطه لطول الفقرة. */
  paragraphMaxLength: 10000,
  /** حدود القيمة المطلقة لحدود سؤال الرقم. */
  numberAbsMax: 1_000_000_000_000,
  /** نطاق التواريخ المقبولة في حدود سؤال التاريخ. */
  dateMin: '1900-01-01',
  dateMax: '2100-12-31',
  /** أقصى حجم يمكن ضبطه لكل ملف (ميغابايت). */
  fileMaxSizeMb: 25,
  /** أقصى عدد ملفات يمكن ضبطه للسؤال. */
  fileMaxCount: 10,
} as const;

/**
 * سقف حجم طلب حفظ المسودة (PUT /api/forms/:id/draft) بالبايت. يُطبق على هذا المسار وحده؛
 * بقية المسارات تبقى عند 100KB (bootstrap.ts).
 *
 * الحساب (JSON مضغوط كما ترسله الواجهة، بأقصى الحدود أعلاه: 100 سؤال اختيار متعدد × 50 خيارًا
 * مع المعرّفات والإعدادات، عنوان سؤال 300 ووصف 1000 ونص خيار 200، وعنوان النموذج 200 ووصفه 2000):
 *   - أحرف ASCII (بايت/حرف):            ≈ 1.37 MiB
 *   - أحرف عربية (2 بايت/حرف):          ≈ 2.45 MiB
 *   - أسوأ نص عادي (3 بايت/حرف، BMP):   ≈ 3.53 MiB  (الخيارات وحدها ≈ 3.13 MiB)
 * 4 MiB حد إجمالي مستقل لحجم الطلب، أعلى من الحالات المقاسة أعلاه بهامش ≈ 13%. لا يدّعي تغطية كل نص
 * تسمح به حدود الأحرف: نص مليء بمحارف تحكم تُهرَّب في JSON (مثل \u0001 = 6 بايت) قد يتجاوزه رغم صحة
 * الأطوال، فيُرفض بـ 413 دون حفظ. الحدان (الأحرف والحجم الإجمالي) يُطبقان معًا ومستقلين.
 */
export const DRAFT_REQUEST_MAX_BYTES = 4 * 1024 * 1024;

/** أنواع الملفات المسموح باختيارها فقط (قائمة آمنة؛ لا ملفات تنفيذية أو سكربتات). */
export const FILE_TYPE_KEYS = ['pdf', 'jpg', 'png', 'webp', 'docx', 'xlsx', 'txt'] as const;
export type FileTypeKey = (typeof FILE_TYPE_KEYS)[number];

export const QUESTION_TYPES = [
  'SHORT_TEXT',
  'PARAGRAPH',
  'SINGLE_CHOICE',
  'MULTIPLE_CHOICE',
  'DROPDOWN',
  'NUMBER',
  'DATE',
  'FILE_UPLOAD',
] as const;
export type QuestionTypeKey = (typeof QUESTION_TYPES)[number];

export const CHOICE_TYPES: readonly QuestionTypeKey[] = [
  'SINGLE_CHOICE',
  'MULTIPLE_CHOICE',
  'DROPDOWN',
];
