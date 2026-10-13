import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { APP_ENV, AppEnv } from './config/env';
import { DashboardModule } from './dashboard/dashboard.controller';
import { FormsModule } from './forms/forms.module';
import { PublicModule } from './public/public.module';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';

/** أسماء محددات المعدل؛ كل مسار يتخطى ما لا يخصه عبر @SkipThrottle. */
export const THROTTLE = {
  login: 'login',
  submitIp: 'submitIp',
  submitForm: 'submitForm',
} as const;

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuditModule,
    // ThrottlerGuard مطبق على مسارَي الدخول وإرسال الرد فقط، وليس عامًا.
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
      ],
    }),
    AuthModule,
    UsersModule,
    FormsModule,
    PublicModule,
    DashboardModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
