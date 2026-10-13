import { z } from 'zod';

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
});

export type AppEnv = z.infer<typeof envSchema>;

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
  const env = result.data;
  if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
    throw new EnvValidationError(
      'إعدادات البيئة غير صالحة:\n  - COOKIE_SECURE: يجب أن تكون true في الإنتاج',
    );
  }
  return env;
}

export const APP_ENV = Symbol('APP_ENV');
