import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, ResponseStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import type { RequestMeta } from '../auth/decorators';
import { AppError, Errors } from '../common/errors';
import { pageMeta } from '../common/pagination';
import { runFormTransaction } from '../forms/form-transaction';
import type { QuestionTypeKey } from '../forms/questions/limits';
import { PrismaService } from '../prisma/prisma.service';
import { CsvBuilder, EXPORT_MAX_ROWS, csvRow, riyadhDateTime } from './csv';
import {
  RESPONSE_STATUS_LABELS,
  type AnswerViewDto,
  type ResponseDetailDto,
  type ResponseFilterQueryDto,
  type ResponseListDto,
  type ResponseListQueryDto,
  type UpdateStatusResultDto,
} from './dto';
import { buildResponseWhere, responseOrder } from './filters';

const FORM_NOT_FOUND = 'النموذج غير موجود.';
const RESPONSE_NOT_FOUND = 'الرد غير موجود.';
const EXPORT_BATCH = 250;

const detailInclude = {
  form: { select: { draft: { select: { title: true } } } },
  version: {
    select: {
      versionNumber: true,
      title: true,
      description: true,
      publishedAt: true,
      questions: {
        orderBy: { position: 'asc' },
        include: { options: { orderBy: { position: 'asc' } } },
      },
    },
  },
  answers: { include: { options: { select: { optionId: true } } } },
  statusChanges: {
    orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
    include: { changedBy: { select: { displayName: true } } },
  },
} satisfies Prisma.FormResponseInclude;

type ResponseWithDetail = Prisma.FormResponseGetPayload<{ include: typeof detailInclude }>;
type AnswerRow = ResponseWithDetail['answers'][number];

function decimalText(value: Prisma.Decimal): string {
  return value.toFixed();
}

function dateText(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function toDetailDto(r: ResponseWithDetail): ResponseDetailDto {
  const byQuestion = new Map(r.answers.map((a) => [a.questionId, a]));
  const answers: AnswerViewDto[] = r.version.questions.map((q) => {
    const base = {
      questionId: q.id,
      position: q.position,
      type: q.type as QuestionTypeKey,
      title: q.title,
      description: q.description,
      required: q.required,
    };
    if (q.type === 'FILE_UPLOAD') return { ...base, kind: 'file' };
    const a: AnswerRow | undefined = byQuestion.get(q.id);
    if (!a) return { ...base, kind: 'empty' };
    if (a.textValue != null) return { ...base, kind: 'text', value: a.textValue };
    if (a.numberValue != null)
      return { ...base, kind: 'number', value: decimalText(a.numberValue) };
    if (a.dateValue != null) return { ...base, kind: 'date', value: dateText(a.dateValue) };
    const selected = new Set(a.options.map((o) => o.optionId));
    if (!selected.size) return { ...base, kind: 'empty' };
    return {
      ...base,
      kind: 'choice',
      options: q.options.map((o) => ({ label: o.label, selected: selected.has(o.id) })),
    };
  });
  return {
    id: r.id,
    referenceCode: r.referenceCode,
    submittedAt: r.submittedAt.toISOString(),
    status: r.status,
    formId: r.formId,
    formTitle: r.form.draft?.title ?? r.version.title,
    version: {
      versionNumber: r.version.versionNumber,
      title: r.version.title,
      description: r.version.description,
      publishedAt: r.version.publishedAt.toISOString(),
    },
    answers,
    statusHistory: r.statusChanges.map((c) => ({
      fromStatus: c.fromStatus,
      toStatus: c.toStatus,
      changedBy: c.changedBy?.displayName ?? null,
      changedAt: c.changedAt.toISOString(),
    })),
  };
}

@Injectable()
export class ResponsesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async assertForm(formId: string): Promise<void> {
    const form = await this.prisma.form.findUnique({ where: { id: formId }, select: { id: true } });
    if (!form) throw Errors.notFound(FORM_NOT_FOUND);
  }

  /** رقم الإصدار ⇒ معرّفه داخل النموذج نفسه؛ إصدار غير موجود يعني نتيجة فارغة. */
  private async resolveVersion(
    formId: string,
    version?: number,
  ): Promise<string | null | undefined> {
    if (version === undefined) return undefined;
    const v = await this.prisma.formVersion.findUnique({
      where: { formId_versionNumber: { formId, versionNumber: version } },
      select: { id: true },
    });
    return v?.id ?? null;
  }

  /** قائمة مختصرة بترقيم من قاعدة البيانات؛ لا تتضمن الإجابات. */
  async list(formId: string, query: ResponseListQueryDto): Promise<ResponseListDto> {
    await this.assertForm(formId);
    const versionId = await this.resolveVersion(formId, query.version);
    if (versionId === null) return { items: [], meta: pageMeta(query.page, query.pageSize, 0) };
    const where = buildResponseWhere(formId, query, versionId);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.formResponse.count({ where }),
      this.prisma.formResponse.findMany({
        where,
        orderBy: responseOrder(query.sort),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          referenceCode: true,
          status: true,
          submittedAt: true,
          version: { select: { versionNumber: true } },
        },
      }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        referenceCode: r.referenceCode,
        status: r.status,
        submittedAt: r.submittedAt.toISOString(),
        versionNumber: r.version.versionNumber,
      })),
      meta: pageMeta(query.page, query.pageSize, total),
    };
  }

  /** تفاصيل رد يخص هذا النموذج فقط؛ رد من نموذج آخر يُعامل كغير موجود. */
  async get(formId: string, responseId: string): Promise<ResponseDetailDto> {
    const r = await this.prisma.formResponse.findFirst({
      where: { id: responseId, formId },
      include: detailInclude,
    });
    if (!r) {
      await this.assertForm(formId);
      throw Errors.notFound(RESPONSE_NOT_FOUND);
    }
    return toDetailDto(r);
  }

  /**
   * تغيير الحالة بقفل صف الرد: الحالة نفسها ⇒ لا تغيير ولا سجل (idempotent).
   * لا تُمس الإجابات ولا الإصدار. السجل المستقل يحفظ القديمة والجديدة والمستخدم والوقت (UTC).
   */
  async updateStatus(
    actor: AuthContext,
    formId: string,
    responseId: string,
    status: ResponseStatus,
    meta: RequestMeta,
  ): Promise<UpdateStatusResultDto> {
    const changed = await runFormTransaction(this.prisma, async (tx) => {
      const rows = await tx.$queryRaw<{ form_id: string; status: ResponseStatus }[]>`
        SELECT form_id, status FROM form_responses WHERE id = ${responseId} FOR UPDATE`;
      const current = rows[0];
      if (!current || current.form_id !== formId) return null;
      if (current.status === status) return false;
      await tx.formResponse.update({ where: { id: responseId }, data: { status } });
      await tx.formResponseStatusChange.create({
        data: {
          responseId,
          fromStatus: current.status,
          toStatus: status,
          changedById: actor.userId,
        },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'response.status_changed',
          entityType: 'response',
          entityId: responseId,
          details: { formId, from: current.status, to: status },
          ipAddress: meta.ipAddress,
        },
        tx,
      );
      return true;
    });
    if (changed === null) {
      await this.assertForm(formId);
      throw Errors.notFound(RESPONSE_NOT_FOUND);
    }
    return { changed, response: await this.get(formId, responseId) };
  }

  /**
   * CSV بأعمدة ثابتة: الرقم المرجعي، تاريخ الإرسال (الرياض)، الحالة، الإصدار، ثم سؤال لكل عمود
   * (بالمفتاح المنطقي عبر الإصدارات، بعنوانه في أحدث إصدار يحتويه). يحترم الفلاتر نفسها.
   * يُقرأ على دفعات ويُرفض قبل الإرسال إن تجاوز الحد في عدد الصفوف أو الحجم. أسئلة الملفات لا تُصدَّر.
   */
  async exportCsv(
    actor: AuthContext,
    formId: string,
    query: ResponseFilterQueryDto,
    meta: RequestMeta,
  ): Promise<{ filename: string; content: Buffer; rows: number }> {
    await this.assertForm(formId);
    const versionId = await this.resolveVersion(formId, query.version);
    // لقطة زمنية: الردود التي تصل أثناء التصدير لا تدخل فيه، فلا يتغير العدد بين الفحص والقراءة.
    const startedAt = new Date();
    const where: Prisma.FormResponseWhereInput =
      versionId === null
        ? { id: '' }
        : {
            AND: [
              buildResponseWhere(formId, query, versionId),
              { submittedAt: { lte: startedAt } },
            ],
          };

    const total = await this.prisma.formResponse.count({ where });
    if (total > EXPORT_MAX_ROWS)
      throw tooLarge(`عدد الردود (${total}) يتجاوز حد التصدير ${EXPORT_MAX_ROWS}.`);

    const versionIds = (
      await this.prisma.formResponse.groupBy({
        by: ['versionId'],
        where,
        orderBy: { versionId: 'asc' },
      })
    ).map((g) => g.versionId);
    const versions = await this.prisma.formVersion.findMany({
      where: { id: { in: versionIds }, formId },
      orderBy: { versionNumber: 'desc' },
      select: {
        id: true,
        questions: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            logicalId: true,
            type: true,
            title: true,
            options: { select: { id: true, label: true } },
          },
        },
      },
    });

    const columns: { logicalId: string; title: string }[] = [];
    const seen = new Set<string>();
    const logicalByQuestion = new Map<string, string>();
    const labelByOption = new Map<string, string>();
    for (const v of versions) {
      for (const q of v.questions) {
        if (q.type === 'FILE_UPLOAD') continue;
        logicalByQuestion.set(q.id, q.logicalId);
        q.options.forEach((o) => labelByOption.set(o.id, o.label));
        if (!seen.has(q.logicalId)) {
          seen.add(q.logicalId);
          columns.push({ logicalId: q.logicalId, title: q.title });
        }
      }
    }

    const csv = new CsvBuilder();
    csv.push(
      csvRow([
        'الرقم المرجعي',
        'تاريخ الإرسال (توقيت الرياض)',
        'الحالة',
        'الإصدار',
        ...columns.map((c) => c.title),
      ]),
    );
    const order = responseOrder(query.sort);
    // قراءة على دفعات بمؤشر (cursor) على المعرّف، لا بإزاحة، فلا تتكرر الصفوف ولا تُفقد.
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prisma.formResponse.findMany({
        where,
        orderBy: order,
        take: EXPORT_BATCH,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
        select: {
          id: true,
          referenceCode: true,
          submittedAt: true,
          status: true,
          version: { select: { versionNumber: true } },
          answers: {
            select: {
              questionId: true,
              textValue: true,
              numberValue: true,
              dateValue: true,
              options: { select: { optionId: true } },
            },
          },
        },
      });
      for (const r of batch) {
        const values = new Map<string, string>();
        for (const a of r.answers) {
          const logical = logicalByQuestion.get(a.questionId);
          if (!logical) continue;
          const value =
            a.textValue ??
            (a.numberValue != null ? decimalText(a.numberValue) : null) ??
            (a.dateValue != null ? dateText(a.dateValue) : null) ??
            a.options.map((o) => labelByOption.get(o.optionId) ?? '').join('، ');
          values.set(logical, value);
        }
        const ok = csv.push(
          csvRow([
            r.referenceCode,
            riyadhDateTime(r.submittedAt),
            RESPONSE_STATUS_LABELS[r.status],
            r.version.versionNumber,
            ...columns.map((c) => values.get(c.logicalId) ?? ''),
          ]),
        );
        if (!ok) throw tooLarge('حجم ملف التصدير يتجاوز 10 ميغابايت.');
      }
      if (batch.length < EXPORT_BATCH) break;
      cursor = batch[batch.length - 1]!.id;
    }

    // يُسجَّل التصدير دون أي محتوى: العدد والفلاتر فقط.
    await this.audit.record({
      actorId: actor.userId,
      action: 'responses.exported',
      entityType: 'form',
      entityId: formId,
      details: {
        rows: total,
        filters: {
          status: query.status ?? null,
          from: query.from ?? null,
          to: query.to ?? null,
          version: query.version ?? null,
          search: query.search ? true : false,
          sort: query.sort,
        },
      },
      ipAddress: meta.ipAddress,
    });

    const stamp = riyadhDateTime(new Date()).slice(0, 10).replace(/-/g, '');
    return { filename: `responses-${stamp}.csv`, content: csv.toBuffer(), rows: total };
  }
}

function tooLarge(reason: string): AppError {
  return new AppError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'EXPORT_TOO_LARGE',
    `${reason} ضيّق الفلاتر (التاريخ أو الحالة أو الإصدار) ثم أعد التصدير.`,
  );
}
