import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { createValidationPipe } from './common/validation';
import type { AppEnv } from './config/env';
import { toExpressTrustProxy } from './config/trust-proxy';
import { CSRF_HEADER, SESSION_COOKIE } from './auth/tokens';
import { DRAFT_REQUEST_MAX_BYTES, RESPONSE_REQUEST_MAX_BYTES } from './forms/questions/limits';

export const API_PREFIX = 'api';
/** حد جسم JSON لكل المسارات عدا حفظ المسودة. */
export const DEFAULT_JSON_LIMIT = '100kb';
/** مسار حفظ المسودة الكاملة، وحده يقبل حتى DRAFT_REQUEST_MAX_BYTES. */
export const DRAFT_BODY_PATH = `/${API_PREFIX}/forms/:id/draft`;
/** مسار إرسال الرد العام، بحد مستقل RESPONSE_REQUEST_MAX_BYTES. */
export const RESPONSE_BODY_PATH = `/${API_PREFIX}/public/forms/:publicId/responses`;

/** إعداد مشترك بين التشغيل الفعلي واختبارات التكامل وتصدير OpenAPI. */
export function configureApp(app: NestExpressApplication, env: AppEnv): void {
  app.setGlobalPrefix(API_PREFIX);
  // لا نثق بـ X-Forwarded-For إلا من Next.js؛ حدود الثقة والقيم المرفوضة في config/trust-proxy.ts.
  app.set('trust proxy', toExpressTrustProxy(env.TRUST_PROXY));
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  // يُسجَّل محلل المسودة أولًا؛ المحلل العام بعده يتخطى الطلب الذي حُلل جسمه.
  // الحساب في forms/questions/limits.ts (DRAFT_REQUEST_MAX_BYTES).
  app.use(DRAFT_BODY_PATH, json({ limit: DRAFT_REQUEST_MAX_BYTES }));
  app.use(RESPONSE_BODY_PATH, json({ limit: RESPONSE_REQUEST_MAX_BYTES }));
  app.useBodyParser('json', { limit: DEFAULT_JSON_LIMIT });
  app.enableCors({ origin: env.WEB_ORIGIN, credentials: true });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
}

export function buildOpenApi(app: INestApplication, env: AppEnv): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle(`${env.APP_NAME} — API`)
    .setDescription(
      [
        'واجهة برمجة المرحلة الأولى. الأخطاء بشكل موحد: { statusCode, code, message, fields?, details? }.',
        `المصادقة بجلسة في Cookie HttpOnly باسم ${SESSION_COOKIE}.`,
        `كل طلب معدِّل (POST/PATCH) يتطلب ترويسة ${CSRF_HEADER} بقيمة Cookie lp_csrf.`,
      ].join('\n\n'),
    )
    .setVersion('0.1.0')
    .addCookieAuth(
      SESSION_COOKIE,
      { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
      'session',
    )
    .addApiKey({ type: 'apiKey', in: 'header', name: CSRF_HEADER }, 'csrf')
    .build();
  return SwaggerModule.createDocument(app, config);
}

/** يركّب /api/docs فقط إن كان API_DOCS_ENABLED مفعّلًا (معطّل افتراضيًا في الإنتاج). */
export function mountOpenApi(app: INestApplication, env: AppEnv): boolean {
  if (!env.API_DOCS_ENABLED) return false;
  SwaggerModule.setup(`${API_PREFIX}/docs`, app, () => buildOpenApi(app, env), {
    jsonDocumentUrl: `${API_PREFIX}/docs.json`,
  });
  return true;
}
