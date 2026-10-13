import { HttpException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import type { PrismaService } from '../prisma/prisma.service';
import { DraftService } from './draft.service';

const actor: AuthContext = {
  sessionId: 's',
  userId: 'u',
  username: 'admin',
  displayName: 'المدير',
  role: UserRole.ADMIN,
  permissions: [],
};
const meta = { ipAddress: null, userAgent: null };
const Q1 = '0190d6b4-0000-7000-8000-0000000000a1';
const O1 = '0190d6b4-0000-7000-8000-0000000000b1';
const O2 = '0190d6b4-0000-7000-8000-0000000000b2';
const FOREIGN = '0190d6b4-0000-7000-8000-0000000000ff';

function storedForm(overrides: { revision?: number; archivedAt?: Date | null } = {}) {
  return {
    id: 'f1',
    createdById: 'u',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    archivedAt: overrides.archivedAt ?? null,
    archivedById: null,
    publicId: null,
    acceptingResponses: false,
    versions: [],
    createdBy: { id: 'u', displayName: 'المدير' },
    draft: {
      id: 'd1',
      formId: 'f1',
      title: 'نموذج',
      description: null,
      revision: overrides.revision ?? 4,
      updatedById: 'u',
      createdAt: new Date(),
      updatedAt: new Date(),
      questions: [
        {
          id: Q1,
          draftId: 'd1',
          position: 0,
          type: 'SINGLE_CHOICE',
          title: 'المدينة',
          description: null,
          required: true,
          settings: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          options: [
            { id: O1, questionId: Q1, position: 0, label: 'الرياض' },
            { id: O2, questionId: Q1, position: 1, label: 'جدة' },
          ],
        },
      ],
    },
  };
}

const sameBody = (revision = 4) => ({
  revision,
  title: 'نموذج',
  description: null,
  questions: [
    {
      id: Q1,
      type: 'SINGLE_CHOICE',
      title: 'المدينة',
      required: true,
      settings: {},
      options: [
        { id: O1, label: 'الرياض' },
        { id: O2, label: 'جدة' },
      ],
    },
  ],
});

function setup(form = storedForm()) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    form: {
      findUnique: jest.fn().mockResolvedValue(form),
      findUniqueOrThrow: jest.fn().mockResolvedValue(form),
      update: jest.fn(),
    },
    formDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    formDraftQuestion: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({ id: 'new-q' }),
      update: jest.fn(),
    },
    formDraftQuestionOption: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn(),
      update: jest.fn(),
    },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    form: { findUnique: jest.fn().mockResolvedValue(storedForm({ revision: 9 })) },
  } as unknown as PrismaService;
  const audit = { record: jest.fn() } as unknown as AuditService;
  return { service: new DraftService(prisma, audit), tx, audit };
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as HttpException;
    return { status: e.getStatus(), body: e.getResponse() as Record<string, any> };
  }
  throw new Error('expected rejection');
}

describe('DraftService.saveDraft', () => {
  it('يقفل صف النموذج أولًا ثم يقرأ', async () => {
    const { service, tx } = setup();
    await service.saveDraft(actor, 'f1', sameBody(), meta);
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.form.findUnique.mock.invocationCallOrder[0]!,
    );
  });

  it('حفظ بلا تغيير لا يزيد revision ولا يُسجّل', async () => {
    const { service, tx, audit } = setup();
    const result = await service.saveDraft(actor, 'f1', sameBody(), meta);
    expect(result.revision).toBe(4);
    expect(tx.formDraft.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('revision قديم ⇒ 409 مع المسودة الكاملة الأحدث ودون أي كتابة', async () => {
    const { service, tx } = setup();
    const { status, body } = await errorOf(service.saveDraft(actor, 'f1', sameBody(3), meta));
    expect(status).toBe(409);
    expect(body.code).toBe('REVISION_CONFLICT');
    expect(body.details.current.revision).toBe(9);
    expect(body.details.current.questions[0].options).toHaveLength(2);
    expect(tx.formDraftQuestion.deleteMany).not.toHaveBeenCalled();
  });

  it('النموذج المؤرشف ⇒ 409 FORM_ARCHIVED', async () => {
    const { service } = setup(storedForm({ archivedAt: new Date() }));
    const { body } = await errorOf(service.saveDraft(actor, 'f1', sameBody(), meta));
    expect(body.code).toBe('FORM_ARCHIVED');
  });

  it('يرفض معرّف سؤال من نموذج آخر ومعرّف خيار من سؤال آخر', async () => {
    const { service, tx } = setup();
    const foreignQuestion = sameBody();
    foreignQuestion.questions[0]!.id = FOREIGN;
    const a = await errorOf(service.saveDraft(actor, 'f1', foreignQuestion, meta));
    expect(a.status).toBe(400);
    expect(a.body.fields).toContainEqual({
      field: 'questions.0.id',
      message: 'هذا السؤال لا يخص النموذج الحالي.',
    });

    const movedOption = sameBody();
    movedOption.questions.push({
      type: 'DROPDOWN',
      title: 'سؤال جديد',
      required: false,
      settings: {},
      options: [{ id: O1, label: 'منقول' }, { label: 'آخر' }],
    } as never);
    movedOption.questions[0]!.options = [{ id: O2, label: 'جدة' }, { label: 'مكة' }] as never;
    const b = await errorOf(service.saveDraft(actor, 'f1', movedOption, meta));
    expect(b.body.fields).toContainEqual({
      field: 'questions.1.options.0.id',
      message: 'هذا الخيار لا يخص السؤال الحالي.',
    });
    expect(tx.formDraftQuestion.deleteMany).not.toHaveBeenCalled();
  });

  it('يطبق التغييرات ويزيد revision مرة واحدة ويسجل العملية', async () => {
    const { service, tx, audit } = setup();
    const body = sameBody();
    body.title = 'نموذج معدّل';
    body.questions[0]!.options = [{ id: O2, label: 'جدة' }, { label: 'الدمام' }] as never;
    body.questions.push({
      type: 'PARAGRAPH',
      title: 'ملاحظات',
      required: false,
      settings: {},
    } as never);
    await service.saveDraft(actor, 'f1', body, meta);

    expect(tx.formDraftQuestion.deleteMany).toHaveBeenCalledWith({
      where: { draftId: 'd1', id: { notIn: [Q1] } },
    });
    expect(tx.formDraftQuestionOption.deleteMany).toHaveBeenCalledWith({
      where: { questionId: Q1, id: { notIn: [O2] } },
    });
    expect(tx.formDraftQuestionOption.update).toHaveBeenCalledWith({
      where: { id: O2 },
      data: { position: 0, label: 'جدة' },
    });
    expect(tx.formDraftQuestion.create).toHaveBeenCalledTimes(1);
    expect(tx.formDraft.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.formDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'd1', revision: 4 },
        data: expect.objectContaining({ title: 'نموذج معدّل', revision: { increment: 1 } }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'form.draft_saved', entityId: 'f1' }),
      tx,
    );
  });

  it('يرفض المدخلات غير الصحيحة قبل أي معاملة', async () => {
    const { service, tx } = setup();
    const { status } = await errorOf(
      service.saveDraft(actor, 'f1', { ...sameBody(), questions: [{ type: 'X' }] }, meta),
    );
    expect(status).toBe(400);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
