import { Prisma } from '@prisma/client';
import { Errors } from '../common/errors';
import type { PrismaService } from '../prisma/prisma.service';

/** يُرمى داخل المعاملة عند عدم تطابق revision، ويحوَّل خارجها إلى 409 مع النسخة الحالية. */
export class RevisionConflict extends Error {}

/**
 * معاملة لعمليات النموذج مع إعادة محاولة محدودة عند تعارض الأقفال (deadlock / lock wait).
 * كل عملية تعديل تبدأ بقفل صف forms (SELECT ... FOR UPDATE) قبل أي قراءة، فتتسلسل
 * عمليات الحفظ والأرشفة على النموذج نفسه.
 */
export async function runFormTransaction<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(work, {
        timeout: options.timeoutMs ?? 5000,
        maxWait: 5000,
      });
    } catch (error) {
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2034' ||
          (error.code === 'P2010' && ['1205', '1213'].includes(String(error.meta?.code))));
      if (!retryable) throw error;
      if (attempt >= 2)
        throw Errors.conflict(
          'WRITE_CONFLICT',
          'تعذر الحفظ بسبب عملية متزامنة. احتُفظ بتعديلاتك؛ أعد المحاولة.',
        );
    }
  }
}

/** يقفل صف النموذج حتى نهاية المعاملة. يجب أن يكون أول استعلام في أي تعديل للنموذج أو مسودته. */
export async function lockForm(tx: Prisma.TransactionClient, formId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM forms WHERE id = ${formId} FOR UPDATE`;
}
