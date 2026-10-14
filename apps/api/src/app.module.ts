import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.module';
import { THROTTLE } from './common/throttle';
import { ConfigModule } from './config/config.module';
import { APP_ENV, AppEnv } from './config/env';
import { DashboardModule } from './dashboard/dashboard.controller';
import { FormsModule } from './forms/forms.module';
import { PublicModule } from './public/public.module';
import { ResponsesModule } from './responses/responses.module';
import { FilesModule } from './files/files.module';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';

export { THROTTLE } from './common/throttle';

/** مسارات الإدارة تُحسب لكل مستخدم (الحارس العام يضبط req.auth قبل حارس المعدل). */
const perUser = (req: Record<string, unknown>) => {
  const r = req as unknown as Request;
  return r.auth ? `user:${r.auth.userId}` : `ip:${r.ip ?? ''}`;
};

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuditModule,
    // ThrottlerGuard مطبق على الدخول وإرسال الرد ومسارات إدارة الردود فقط، وليس عامًا.
    // التتبع الافتراضي بـ req.ip الذي تحسبه Express وفق TRUST_PROXY، فلا يُصدَّق X-Forwarded-For من العميل مباشرة.
    ThrottlerModule.forRootAsync({
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => [
        { name: THROTTLE.login, ttl: 60_000, limit: env.LOGIN_RATE_LIMIT_PER_MINUTE },
        {
          name: THROTTLE.submitIp,
          ttl: 60_000,
          limit: env.PUBLIC_SUBMIT_PER_IP_PER_MINUTE,
        },
        {
          name: THROTTLE.submitForm,
          ttl: 60_000,
          limit: env.PUBLIC_SUBMIT_PER_FORM_PER_MINUTE,
          getTracker: (req: Record<string, unknown>) =>
            `form:${String((req as unknown as Request).params?.publicId ?? '')}`,
        },
        { name: THROTTLE.uploadIp, ttl: 60_000, limit: env.PUBLIC_UPLOAD_PER_IP_PER_MINUTE },
        {
          name: THROTTLE.uploadForm,
          ttl: 60_000,
          limit: env.PUBLIC_UPLOAD_PER_FORM_PER_MINUTE,
          getTracker: (req: Record<string, unknown>) =>
            `upload-form:${String((req as unknown as Request).params?.publicId ?? '')}`,
        },
        {
          name: THROTTLE.responses,
          ttl: 60_000,
          limit: env.RESPONSES_RATE_LIMIT_PER_MINUTE,
          getTracker: perUser,
        },
        {
          name: THROTTLE.responsesExport,
          ttl: 60_000,
          limit: env.RESPONSES_EXPORT_PER_MINUTE,
          getTracker: perUser,
        },
      ],
    }),
    AuthModule,
    UsersModule,
    FormsModule,
    PublicModule,
    ResponsesModule,
    FilesModule,
    DashboardModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
