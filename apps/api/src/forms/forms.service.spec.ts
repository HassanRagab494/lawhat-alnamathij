import { HttpException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import type { PrismaService } from '../prisma/prisma.service';
import { FormsService } from './forms.service';

const actor: AuthContext = {
  sessionId: 's',
  userId: 'u',
  username: 'admin',
  displayName: 'المدير',
  role: UserRole.ADMIN,
  permissions: [],
};
const meta = { ipAddress: null, userAgent: null };

function storedForm(overrides: { revision?: number; archivedAt?: Date | null } = {}) {
  return {
    id: 'f1',
    createdById: 'u',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    archivedAt: overrides.archivedAt ?? null,
    archivedById: null,
    createdBy: { id: 'u', displayName: 'المدير' },
    draft: {
      id: 'd1',
      formId: 'f1',
      title: 'العنوان الحالي',
      description: null,
      revision: overrides.revision ?? 3,
      updatedById: 'u',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

function setup(form: ReturnType<typeof storedForm> | null, updateCount = 1) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    form: {
      findUnique: jest.fn().mockResolvedValue(form),
      findUniqueOrThrow: jest.fn().mockResolvedValue(form),
      update: jest.fn(),
    },
    formDraft: { updateMany: jest.fn().mockResolvedValue({ count: updateCount }) },
  };
  const prisma = {
    form: { findUnique: jest.fn().mockResolvedValue(form) },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  const audit = { record: jest.fn() } as unknown as AuditService;
  return { service: new FormsService(prisma, audit), tx, audit, prisma };
}

async function errorOf(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as HttpException;
    return { status: e.getStatus(), code: (e.getResponse() as { code: string }).code };
  }
  throw new Error('expected rejection');
}

describe('FormsService.update', () => {
  it('retries MySQL deadlocks in fresh transactions and bounds retry exhaustion', async () => {
    const { service, prisma } = setup(storedForm());
    const deadlock = new Prisma.PrismaClientKnownRequestError('deadlock', {
      code: 'P2034',
      clientVersion: '6',
    });
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(deadlock);
    await service.update(actor, 'f1', { title: 'new', revision: 3 }, meta);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    (prisma.$transaction as jest.Mock).mockClear().mockRejectedValue(deadlock);
    await expect(
      service.update(actor, 'f1', { title: 'new', revision: 3 }, meta),
    ).rejects.toMatchObject({ response: { code: 'WRITE_CONFLICT' } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });
  it('reads conflict after the failed transaction, rather than returning its snapshot', async () => {
    const { service, prisma } = setup(storedForm({ revision: 2 }), 0);
    const winner = storedForm({ revision: 3 });
    winner.draft.title = 'winner';
    (prisma.form.findUnique as jest.Mock).mockResolvedValue(winner);
    await expect(
      service.update(actor, 'f1', { title: 'mine', revision: 2 }, meta),
    ).rejects.toMatchObject({
      response: {
        code: 'REVISION_CONFLICT',
        details: { current: { revision: 3, title: 'winner' } },
      },
    });
    expect(prisma.form.findUnique).toHaveBeenCalledTimes(1);
  });
  it('يرفض برقم مراجعة قديم دون أي كتابة (409 REVISION_CONFLICT)', async () => {
    const { service, tx, audit } = setup(storedForm({ revision: 3 }), 0);
    const result = await errorOf(
      service.update(actor, 'f1', { title: 'تعديل', description: null, revision: 2 }, meta),
    );
    expect(result).toEqual({ status: 409, code: 'REVISION_CONFLICT' });
    expect(tx.formDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { formId: 'f1', revision: 2 } }),
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('يرفض أيضًا برقم قديم حتى لو لم تتغير القيم', async () => {
    const { service, tx } = setup(storedForm({ revision: 3 }));
    const result = await errorOf(
      service.update(
        actor,
        'f1',
        { title: 'العنوان الحالي', description: null, revision: 1 },
        meta,
      ),
    );
    expect(result.code).toBe('REVISION_CONFLICT');
    expect(tx.formDraft.updateMany).not.toHaveBeenCalled();
  });

  it('يرفض تعديل نموذج مؤرشف', async () => {
    const { service } = setup(storedForm({ archivedAt: new Date() }));
    const result = await errorOf(
      service.update(actor, 'f1', { title: 'x', description: null, revision: 3 }, meta),
    );
    expect(result).toEqual({ status: 409, code: 'FORM_ARCHIVED' });
  });

  it('404 لنموذج غير موجود', async () => {
    const { service } = setup(null);
    const result = await errorOf(
      service.update(actor, 'f1', { title: 'x', description: null, revision: 1 }, meta),
    );
    expect(result.status).toBe(404);
  });

  it('يطبق التعديل ويزيد رقم المراجعة ويسجل العملية', async () => {
    const { service, tx, audit } = setup(storedForm({ revision: 3 }), 1);
    await service.update(
      actor,
      'f1',
      { title: 'عنوان جديد', description: 'وصف', revision: 3 },
      meta,
    );
    expect(tx.formDraft.updateMany).toHaveBeenCalledWith({
      where: { formId: 'f1', revision: 3 },
      data: {
        title: 'عنوان جديد',
        description: 'وصف',
        revision: { increment: 1 },
        updatedById: 'u',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'form.updated', entityId: 'f1' }),
      tx,
    );
  });
});
