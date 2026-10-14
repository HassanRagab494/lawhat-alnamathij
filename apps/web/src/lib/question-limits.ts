/**
 * نسخة الواجهة من الحدود المركزية لمحرر النموذج.
 * المصدر: apps/api/src/forms/questions/limits.ts — اختبار question-limits.test.ts يفشل إن اختلفتا.
 */
export const QUESTION_LIMITS = {
  maxQuestions: 100,
  maxOptions: 50,
  minOptions: 2,
  questionTitleMax: 300,
  questionDescriptionMax: 1000,
  optionLabelMax: 200,
  shortTextMaxLength: 500,
  paragraphMaxLength: 10000,
  numberAbsMax: 1_000_000_000_000,
  dateMin: '1900-01-01',
  dateMax: '2100-12-31',
  fileMaxSizeMb: 25,
  videoMaxSizeMb: 100,
  fileMaxCount: 10,
} as const;

export const FORM_TITLE_MAX = 200;
export const FORM_DESCRIPTION_MAX = 2000;

export const FILE_TYPE_KEYS = [
  'pdf',
  'jpg',
  'png',
  'webp',
  'docx',
  'xlsx',
  'txt',
  'mp4',
  'mov',
  'webm',
] as const;
/** أنواع الفيديو بين مفاتيح الأنواع. */
export const VIDEO_TYPE_KEYS: readonly FileTypeKey[] = ['mp4', 'mov', 'webm'];
export type FileTypeKey = (typeof FILE_TYPE_KEYS)[number];

export const FILE_TYPE_LABELS: Record<FileTypeKey, string> = {
  pdf: 'PDF',
  jpg: 'صورة JPG',
  png: 'صورة PNG',
  webp: 'صورة WEBP',
  docx: 'مستند Word',
  xlsx: 'جدول Excel',
  txt: 'ملف نصي',
  mp4: 'فيديو MP4',
  mov: 'فيديو MOV',
  webm: 'فيديو WebM',
};

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
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  SHORT_TEXT: 'إجابة قصيرة',
  PARAGRAPH: 'فقرة',
  SINGLE_CHOICE: 'اختيار واحد',
  MULTIPLE_CHOICE: 'اختيار متعدد',
  DROPDOWN: 'قائمة منسدلة',
  NUMBER: 'رقم',
  DATE: 'تاريخ',
  FILE_UPLOAD: 'رفع ملفات',
};

export const CHOICE_TYPES: readonly QuestionType[] = [
  'SINGLE_CHOICE',
  'MULTIPLE_CHOICE',
  'DROPDOWN',
];

export function isChoiceType(type: QuestionType): boolean {
  return CHOICE_TYPES.includes(type);
}
