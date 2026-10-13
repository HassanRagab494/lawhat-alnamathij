import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { createValidationPipe } from './common/validation';
import type { AppEnv } from './config/env';
import { CSRF_HEADER, SESSION_COOKIE } from './auth/tokens';

export const API_PREFIX = 'api';

/** إعداد مشترك بين التشغيل الفعلي واختبارات التكامل وتصدير OpenAPI. */
export function configureApp(app: NestExpressApplication, env: AppEnv): void {
  app.setGlobalPrefix(API_PREFIX);
  // الواجهة تمرر الطلبات عبر Next.js على نفس الجهاز؛ نثق بترويسة X-Forwarded-For من loopback فقط.
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '100kb' });
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

export function mountOpenApi(app: INestApplication, env: AppEnv): void {
  SwaggerModule.setup(`${API_PREFIX}/docs`, app, () => buildOpenApi(app, env), {
    jsonDocumentUrl: `${API_PREFIX}/docs.json`,
  });
}
