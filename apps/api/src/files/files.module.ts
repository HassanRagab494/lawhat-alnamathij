import {
  Global,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { resolve } from 'node:path';
import { APP_ENV, type AppEnv } from '../config/env';
import { FilesController } from './files.controller';
import { ClamdScanner, DisabledScanner, UnavailableScanner } from './scanner';
import { LocalDiskStorage } from './storage';
import { FILE_STORAGE, MALWARE_SCANNER, UploadsService } from './uploads.service';

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/** تنظيف دوري للملفات المؤقتة المنتهية غير المرتبطة برد. */
@Injectable()
class FilesCleanup implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private readonly logger = new Logger('FilesCleanup');

  constructor(private readonly uploads: UploadsService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.run(), CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async run(): Promise<void> {
    try {
      const r = await this.uploads.cleanup();
      if (r.files || r.sessions || r.partials) {
        this.logger.log(`removed files=${r.files} sessions=${r.sessions} partials=${r.partials}`);
      }
    } catch (error) {
      this.logger.warn(`cleanup failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
}

@Global()
@Module({
  controllers: [FilesController],
  providers: [
    {
      provide: FILE_STORAGE,
      inject: [APP_ENV],
      useFactory: async (env: AppEnv) => {
        const storage = new LocalDiskStorage(resolve(env.UPLOAD_DIR));
        await storage.init();
        return storage;
      },
    },
    {
      provide: MALWARE_SCANNER,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) =>
        env.UPLOAD_SCAN_MODE === 'disabled'
          ? new DisabledScanner()
          : env.CLAMAV_HOST
            ? new ClamdScanner(env.CLAMAV_HOST, env.CLAMAV_PORT, env.CLAMAV_TIMEOUT_MS)
            : new UnavailableScanner(),
    },
    UploadsService,
    FilesCleanup,
  ],
  exports: [UploadsService, FILE_STORAGE],
})
export class FilesModule {}
