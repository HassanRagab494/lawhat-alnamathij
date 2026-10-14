import { Module } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../../config/env';
import { FlowmaxClient } from './client';
import { FlowmaxController } from './flowmax.controller';
import { FLOWMAX_CLIENT, FlowmaxService } from './flowmax.service';

@Module({
  controllers: [FlowmaxController],
  providers: [
    {
      provide: FLOWMAX_CLIENT,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) =>
        env.FLOWMAX_ENABLED && env.FLOWMAX_API_BASE_URL && env.FLOWMAX_SERVICE_TOKEN
          ? new FlowmaxClient({
              baseUrl: env.FLOWMAX_API_BASE_URL,
              token: env.FLOWMAX_SERVICE_TOKEN,
              timeoutMs: env.FLOWMAX_TIMEOUT_MS,
              mediaTimeoutMs: env.FLOWMAX_MEDIA_TIMEOUT_MS,
            })
          : null,
    },
    FlowmaxService,
  ],
  exports: [FlowmaxService],
})
export class FlowmaxModule {}
