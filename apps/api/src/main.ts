import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp, mountOpenApi } from './bootstrap';
import { EnvValidationError, loadEnv } from './config/env';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureApp(app, env);
  const docs = mountOpenApi(app, env);
  await app.listen(env.API_PORT);
  Logger.log(
    `API تعمل على المنفذ ${env.API_PORT} — التوثيق: ${docs ? '/api/docs' : 'معطّل (API_DOCS_ENABLED)'}`,
    'Bootstrap',
  );
}

main().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
