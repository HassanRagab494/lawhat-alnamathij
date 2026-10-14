import { z } from 'zod';
import { trustProxyError } from './trust-proxy';

const booleanFromString = z
  .enum(['true', 'false'], { message: 'يجب أن تكون القيمة true أو false' })
  .transform((value) => value === 'true');

/** قيمة فارغة (من compose بلا قيمة) تعامل كغير مضبوطة. */
const blankAsUnset = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().trim().min(1).default('لوحة النماذج'),
  DATABASE_URL: z
    .string({ required_error: 'مطلوب' })
    .regex(/^mysql:\/\//, 'يجب أن يبدأ بـ mysql://'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.string({ required_error: 'مطلوب' }).url('يجب أن يكون عنوان URL صحيحًا'),
  COOKIE_SECURE: booleanFromString.default('false'),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(12),
  SESSION_IDLE_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(120),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(50).default(5),
  LOGIN_LOCK_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(15),
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(10),
  /** حد إرسال الردود العامة لكل عنوان IP في الدقيقة. */
  PUBLIC_SUBMIT_PER_IP_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(10),
  /** حد إرسال الردود العامة لكل نموذج في الدقيقة (من كل العناوين معًا). */
  PUBLIC_SUBMIT_PER_FORM_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(120),
  /** حد رفع الملفات (وإنشاء جلسات التعبئة) لكل عنوان IP في الدقيقة. */
  PUBLIC_UPLOAD_PER_IP_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(30),
  /** حد رفع الملفات لكل نموذج في الدقيقة (من كل العناوين معًا). */
  PUBLIC_UPLOAD_PER_FORM_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(300),
  /** مجلد التخزين الدائم للملفات (volume خاص بالمشروع في الإنتاج). */
  UPLOAD_DIR: z.string().trim().min(1).default('./.tmp/uploads'),
  /** مضيف clamd؛ غيابه يعطّل رفع الملفات (لا يُقبل ملف دون فحص). */
  CLAMAV_HOST: z.string().trim().min(1).optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(60_000),
  /** فحص الملفات: required (افتراضي) أو disabled بقرار صريح. */
  UPLOAD_SCAN_MODE: z.enum(['required', 'disabled']).default('required'),
  /** عمر جلسة التعبئة والملفات غير المرسلة. */
  UPLOAD_SESSION_TTL_MINUTES: z.coerce
    .number()
    .int()
    .min(10)
    .max(24 * 60)
    .default(240),
  /** الحد الإجمالي للملفات المقبولة في جلسة تعبئة واحدة. */
  UPLOAD_SESSION_MAX_MB: z.coerce.number().int().min(1).max(5000).default(300),
  /** الحد الإجمالي لحجم كل الملفات المخزنة؛ عند بلوغه يُرفض الرفع الجديد. */
  UPLOAD_STORAGE_MAX_GB: z.coerce.number().min(0.01).max(10_000).default(20),
  /** حد طلبات إدارة الردود (القائمة والتفاصيل وتغيير الحالة) لكل مستخدم في الدقيقة. */
  RESPONSES_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(120),
  /** حد تصدير الردود CSV لكل مستخدم في الدقيقة. */
  RESPONSES_EXPORT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(5),
  /**
   * قيمة Express «trust proxy»: من يُوثق بترويسة X-Forwarded-For منه لتحديد IP العميل.
   * محليًا: loopback (Next.js على الجهاز نفسه). في الإنتاج: عنوان Next.js أو شبكته الداخلية فقط،
   * ويجب ضبطه صراحة. القواعد في trust-proxy.ts.
   */
  TRUST_PROXY: z.string().trim().min(1).default('loopback'),
  /** وثائق /api/docs: مفعّلة افتراضيًا في التطوير ومعطّلة افتراضيًا في الإنتاج. */
  API_DOCS_ENABLED: booleanFromString.optional(),
  /** ربط Flowmax: معطّل افتراضيًا. لا يُرسل أي رد قبل اعتماد الأدمن. */
  FLOWMAX_ENABLED: blankAsUnset(booleanFromString.default('false')),
  /** أصل API لـ Flowmax (مثل https://api.example.com)؛ مطلوب عند التفعيل. */
  FLOWMAX_API_BASE_URL: blankAsUnset(z.string().trim().url().optional()),
  /** رمز حساب تكامل مخصص في Flowmax بصلاحيات العقارات والطلبات فقط (سر؛ لا يُسجَّل). */
  FLOWMAX_SERVICE_TOKEN: blankAsUnset(z.string().trim().min(20).optional()),
  /** مهلة طلبات JSON إلى Flowmax. */
  FLOWMAX_TIMEOUT_MS: blankAsUnset(z.coerce.number().int().min(1000).max(120_000).default(15_000)),
  /** مهلة رفع كل ملف وسائط إلى Flowmax. */
  FLOWMAX_MEDIA_TIMEOUT_MS: blankAsUnset(
    z.coerce.number().int().min(5000).max(900_000).default(300_000),
  ),
  /** أصل موقع Flowmax العام لبناء روابط العقار (/property/{id}) والطلب (/properties/demands/{ref}). */
  FLOWMAX_PUBLIC_SITE_URL: blankAsUnset(z.string().trim().url().optional()),
  /** نشر العقار في Flowmax بعد إنشائه ورفع وسائطه (وإلا يبقى مسودة حتى ينشره فريق Flowmax). */
  FLOWMAX_AUTO_PUBLISH: blankAsUnset(booleanFromString.default('false')),
});

export type AppEnv = Omit<z.infer<typeof envSchema>, 'API_DOCS_ENABLED'> & {
  API_DOCS_ENABLED: boolean;
};

export class EnvValidationError extends Error {}

/** يتحقق من متغيرات البيئة ويرفض التشغيل برسالة تذكر المتغيرات الناقصة أو الخاطئة فقط (دون قيمها). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
    );
    throw new EnvValidationError(`إعدادات البيئة غير صالحة:\n${lines.join('\n')}`);
  }
  const production = result.data.NODE_ENV === 'production';
  const env: AppEnv = {
    ...result.data,
    API_DOCS_ENABLED: result.data.API_DOCS_ENABLED ?? !production,
  };
  const problems: string[] = [];
  if (production && !env.COOKIE_SECURE) {
    problems.push('COOKIE_SECURE: يجب أن تكون true في الإنتاج');
  }
  if (production && !source.TRUST_PROXY?.trim()) {
    problems.push('TRUST_PROXY: مطلوب صراحة في الإنتاج (عنوان الواجهة Next.js أو شبكتها الداخلية)');
  } else {
    const trustError = trustProxyError(env.TRUST_PROXY, production);
    if (trustError) problems.push(`TRUST_PROXY: ${trustError}`);
  }
  if (env.FLOWMAX_ENABLED) {
    for (const key of [
      'FLOWMAX_API_BASE_URL',
      'FLOWMAX_SERVICE_TOKEN',
      'FLOWMAX_PUBLIC_SITE_URL',
    ] as const) {
      if (!env[key]) problems.push(`${key}: مطلوب عند FLOWMAX_ENABLED=true`);
    }
    if (
      production &&
      env.FLOWMAX_API_BASE_URL &&
      !env.FLOWMAX_API_BASE_URL.startsWith('https://')
    ) {
      problems.push('FLOWMAX_API_BASE_URL: يجب أن يكون https في الإنتاج');
    }
  }
  if (problems.length) {
    throw new EnvValidationError(
      `إعدادات البيئة غير صالحة:\n${problems.map((line) => `  - ${line}`).join('\n')}`,
    );
  }
  return env;
}

export const APP_ENV = Symbol('APP_ENV');
