import { z } from 'zod';
import { trustProxyError } from './trust-proxy';

const booleanFromString = z
  .enum(['true', 'false'], { message: 'يجب أن تكون القيمة true أو false' })
  .transform((value) => value === 'true');

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
  /**
   * قيمة Express «trust proxy»: من يُوثق بترويسة X-Forwarded-For منه لتحديد IP العميل.
   * محليًا: loopback (Next.js على الجهاز نفسه). في الإنتاج: عنوان Next.js أو شبكته الداخلية فقط،
   * ويجب ضبطه صراحة. القواعد في trust-proxy.ts.
   */
  TRUST_PROXY: z.string().trim().min(1).default('loopback'),
  /** وثائق /api/docs: مفعّلة افتراضيًا في التطوير ومعطّلة افتراضيًا في الإنتاج. */
  API_DOCS_ENABLED: booleanFromString.optional(),
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
  if (problems.length) {
    throw new EnvValidationError(
      `إعدادات البيئة غير صالحة:\n${problems.map((line) => `  - ${line}`).join('\n')}`,
    );
  }
  return env;
}

export const APP_ENV = Symbol('APP_ENV');
