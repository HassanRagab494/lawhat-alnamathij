import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * يتصل Prisma عند أول استعلام، لذلك يمكن تشغيل الـ API حتى لو كانت القاعدة متوقفة،
 * ويعكس /api/health حالتها الفعلية بدل أن يفشل الإقلاع.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ log: ['warn', 'error'] });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
