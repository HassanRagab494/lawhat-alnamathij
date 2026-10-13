/**
 * يصدّر وثيقة OpenAPI إلى docs/openapi.json دون الحاجة إلى قاعدة بيانات.
 *   npm run openapi:export
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppModule } from '../app.module';
import { buildOpenApi, configureApp } from '../bootstrap';
import { loadEnv } from '../config/env';

async function main(): Promise<void> {
  // قيم بديلة غير سرية تكفي لبناء الوثيقة فقط؛ لا يُنشأ أي اتصال بالقاعدة.
  process.env.DATABASE_URL ??= 'mysql://openapi:openapi@localhost:3306/openapi';
  process.env.WEB_ORIGIN ??= 'http://localhost:3000';
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: ['error'],
  });
  configureApp(app, env);
  await app.init();
  const document = buildOpenApi(app, env);
  const target = resolve(__dirname, '../../../../docs/openapi.json');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await app.close();
  console.log(`تم تصدير OpenAPI إلى ${target}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
