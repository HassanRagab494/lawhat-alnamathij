import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { APP_ENV, AppEnv } from './config/env';
import { DashboardModule } from './dashboard/dashboard.controller';
import { FormsModule } from './forms/forms.module';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuditModule,
    // ThrottlerGuard مطبق على مسار الدخول فقط (لكل عنوان IP)، وليس عامًا.
    ThrottlerModule.forRootAsync({
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => [
        { name: 'login', ttl: 60_000, limit: env.LOGIN_RATE_LIMIT_PER_MINUTE },
      ],
    }),
    AuthModule,
    UsersModule,
    FormsModule,
    DashboardModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
