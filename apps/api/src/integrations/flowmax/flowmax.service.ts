import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Prisma, type FlowmaxSync, type ResponseStatus } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../auth/auth-context';
import type { RequestMeta } from '../../auth/decorators';
import { AppError, Errors } from '../../common/errors';
import { APP_ENV, type AppEnv } from '../../config/env';
import { MIME_BY_KIND } from '../../files/file-kind';
import type { FileStorage } from '../../files/storage';
import { FILE_STORAGE } from '../../files/uploads.service';
import { runFormTransaction } from '../../forms/form-transaction';
import { versionConditions, visibleQuestionIds } from '../../forms/questions/visibility';
import { isTemplateForm } from '../../forms/templates/real-estate';
import { PrismaService } from '../../prisma/prisma.service';
import { FlowmaxClient, FlowmaxError } from './client';
import { type AnswerInput, type Problem, type ShareInfo } from './mapping';
import { buildAutoRequest } from './auto-property';
import { incompatibleMedia, type IncompatibleMedia, type MediaItem } from './media';
import { buildTemplateRequest } from './template-property';

export const FLOWMAX_CLIENT = Symbol('FLOWMAX_CLIENT');

/** مدة حجز الإرسال؛ بعدها يُعتبر الإرسال منقطعًا (انهيار العملية) ويمكن إعادة المحاولة. */
const LEASE_MS = 30 * 60 * 1000;
const EXT: Record<string, string> = {
  JPG: 'jpg',
  PNG: 'png',
  WEBP: 'webp',
  MP4: 'mp4',
  MOV: 'mov',
  WEBM: 'webm',
};
const API = '/api/admin/integrations/forms';

/** ما يعيده Flowmax لسجل العرض أو الطلب (بلا بيانات تواصل). */
interface FlowmaxRecord {
  id: number | string;
  reference?: string | null;
  status?: string | null;
  is_public?: boolean;
  detail_url?: string | null;
}

export interface FlowmaxMediaView {
  fileId: string;
  role: MediaItem['role'];
  status: MediaItem['status'];
  error: string | null;
  excludedReason: string | null;
}

export interface FlowmaxSyncView {
  status: FlowmaxSync['status'];
  operation: FlowmaxSync['operation'];
  flowmaxId: string | null;
  flowmaxRef: string | null;
  /** رابط التفاصيل كما أعاده Flowmax (للإدارة)؛ لا يعني أنه منشور. */
  detailUrl: string | null;
  remoteStatus: string | null;
  isPublic: boolean;
  publishState: FlowmaxSync['publishState'];
  publishError: string | null;
  sentAt: string | null;
  approvedAt: string;
  lastError: string | null;
  attempts: number;
  media: FlowmaxMediaView[];
  /** بيانات المشاركة: فقط بعد تأكيد Flowmax أن السجل منشور وظاهر. */
  share: ShareInfo | null;
}

export interface FlowmaxPrecheck {
  problems: Problem[];
  incompatibleMedia: IncompatibleMedia[];
  /** ملاحظات لا تمنع الاعتماد. */
  notices: string[];
}

export interface FlowmaxStateView {
  integrationEnabled: boolean;
  mappingEnabled: boolean;
  sync: FlowmaxSyncView | null;
  /** قبل الاعتماد: الحقول الناقصة والمرفقات غير المتوافقة مع Flowmax. */
  precheck: FlowmaxPrecheck | null;
  /** الرد مرفوض: لا يُرسل ولا يُعرض رابطه أو مشاركته. */
  rejected: boolean;
  /** رقم مراجعة تعديلات الرد؛ يُرسل مع الاعتماد ليُعتمد ما راجعه المستخدم نفسه. */
  editRevision: number;
}

const REJECTED_MESSAGE = 'هذا الرد مرفوض، فلا يُرسل إلى Flowmax. غيّر حالته أولًا إن أردت اعتماده.';

/** مفتاح المصدر الثابت للرد؛ Flowmax يفرض تفرده مع هوية حساب التكامل. */
export const sourceKeyFor = (responseId: string) => `lawha:response:${responseId}`;
export const mediaKeyFor = (sourceKey: string, fileId: string) => `${sourceKey}:file:${fileId}`;

const json = <T>(value: T) => value as unknown as Prisma.InputJsonValue;
const describe = (error: unknown) =>
  error instanceof FlowmaxError ? error.describe() : 'خطأ داخلي أثناء الاتصال بـ Flowmax.';

/**
 * تكامل Flowmax بثلاث مراحل منفصلة:
 * 1. الاعتماد (مراجعة الردود): لقطة الطلب وحالة «مقبول»، بعد التحقق من الحقول والمرفقات.
 * 2. الإرسال (في الخلفية): إنشاء السجل في Flowmax ثم كل مرفق بمفتاح مستقل؛ Flowmax يعيد السجل نفسه
 *    لأي إعادة أو طلب متزامن، فلا تكرار.
 * 3. النشر (للعروض): بقواعد النشر في Flowmax. المشاركة العامة فقط بعد تأكيد أنه منشور وظاهر.
 * السجلات لا تحمل الرمز ولا بيانات المالك.
 */
@Injectable()
export class FlowmaxService implements OnModuleInit {
  private readonly logger = new Logger('Flowmax');
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(FLOWMAX_CLIENT) private readonly client: FlowmaxClient | null,
  ) {}

  /** ما انقطع بانهيار العملية السابقة يتحول إلى فشل قابل لإعادة المحاولة (Flowmax يعيد السجل نفسه). */
  async onModuleInit(): Promise<void> {
    if (!this.integrationEnabled) return;
    const sending = await this.prisma.flowmaxSync.updateMany({
      where: { status: { in: ['SENDING', 'PENDING'] } },
      data: {
        status: 'FAILED',
        lastError: 'انقطع الإرسال قبل اكتماله؛ أعد المحاولة.',
        leaseUntil: null,
      },
    });
    const publishing = await this.prisma.flowmaxSync.updateMany({
      where: { publishState: 'REQUESTED' },
      data: { publishState: 'FAILED', publishError: 'انقطع طلب النشر قبل اكتماله؛ أعد المحاولة.' },
    });
    if (sending.count || publishing.count) {
      this.logger.warn(`recovered ${sending.count + publishing.count} interrupted flowmax sync(s)`);
    }
  }

  get integrationEnabled(): boolean {
    return this.env.FLOWMAX_ENABLED && this.client !== null;
  }

  /** ينتظر انتهاء كل الإرسالات الجارية (للاختبارات والإغلاق). */
  async whenIdle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()]);
  }

  private assertEnabled(): void {
    if (!this.integrationEnabled) {
      throw new AppError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FLOWMAX_DISABLED',
        'تكامل Flowmax غير مفعّل على هذا الخادم.',
      );
    }
  }

  // ---------- الربط ----------

  // ---------- الحالة والتحقق المسبق ----------

  private async responseAnswers(formId: string, responseId: string) {
    const r = await this.prisma.formResponse.findFirst({
      where: { id: responseId, formId, deletedAt: null, form: { deletedAt: null } },
      select: {
        id: true,
        referenceCode: true,
        submittedAt: true,
        editRevision: true,
        version: {
          select: {
            questions: {
              orderBy: { position: 'asc' },
              select: {
                id: true,
                logicalId: true,
                title: true,
                type: true,
                semanticKey: true,
                showIf: true,
                options: { select: { id: true, logicalId: true } },
              },
            },
          },
        },
        answers: {
          select: {
            questionId: true,
            textValue: true,
            numberValue: true,
            dateValue: true,
            options: {
              select: {
                optionId: true,
                option: { select: { label: true, position: true, semanticKey: true } },
              },
            },
            // المرفقات التي أزالها تعديل إداري تبقى محفوظة ولا تُرسل
            files: {
              where: { removedAt: null },
              orderBy: { createdAt: 'asc' },
              select: { id: true, originalName: true, kind: true, sizeBytes: true },
            },
          },
        },
      },
    });
    if (!r) throw Errors.notFound('الرد غير موجود.');
    const byQuestion = new Map(r.answers.map((a) => [a.questionId, a]));
    // أسئلة الفرع غير النشط لا تُرسل حتى لو وُجدت لها بيانات (الخادم يرفضها عند الإرسال أصلًا)
    const conditions = versionConditions(r.version.questions);
    const visible = visibleQuestionIds(
      r.version.questions.map((q) => ({ id: q.id, showIf: conditions.get(q.id) ?? null })),
      new Map(r.answers.map((a) => [a.questionId, a.options.map((o) => o.optionId)])),
    );
    const answers: AnswerInput[] = r.version.questions.map((q) => {
      const a = byQuestion.get(q.id);
      const picked = a?.options.slice().sort((x, y) => x.option.position - y.option.position);
      return {
        semanticKey: q.semanticKey,
        hidden: !visible.has(q.id),
        choiceKeys: picked?.flatMap((o) => (o.option.semanticKey ? [o.option.semanticKey] : [])),
        logicalId: q.logicalId,
        title: q.title,
        type: q.type,
        text: a?.textValue ?? null,
        number: a?.numberValue != null ? a.numberValue.toFixed() : null,
        date: a?.dateValue ? a.dateValue.toISOString().slice(0, 10) : null,
        choices: picked?.map((o) => o.option.label),
        files: a?.files.map((f) => ({
          id: f.id,
          name: f.originalName,
          kind: f.kind,
          size: f.sizeBytes,
        })),
      };
    });
    return { response: r, answers };
  }

  private async build(formId: string, responseId: string) {
    if (!this.integrationEnabled) return null;
    const { response, answers } = await this.responseAnswers(formId, responseId);
    const ctx = {
      referenceCode: response.referenceCode,
      submittedAt: response.submittedAt,
      approvedAt: new Date(),
      developerId: this.env.FLOWMAX_DEVELOPER_ID,
    };
    // نماذج القالب: ربط بالهويات الدلالية. غيرها: تعرّف تلقائي من عناوين الأسئلة الظاهرة (توافق).
    const built = isTemplateForm(answers.map((a) => a.semanticKey))
      ? buildTemplateRequest(answers, ctx)
      : buildAutoRequest(
          answers.filter((a) => !a.hidden),
          ctx,
        );
    return {
      built,
      incompatible: incompatibleMedia(built.media),
      editRevision: response.editRevision,
    };
  }

  async state(formId: string, responseId: string): Promise<FlowmaxStateView> {
    const response = await this.prisma.formResponse.findFirst({
      where: { id: responseId, formId, deletedAt: null, form: { deletedAt: null } },
      select: { id: true, status: true, editRevision: true, flowmaxSync: true },
    });
    if (!response) throw Errors.notFound('الرد غير موجود.');
    const mappingEnabled = this.integrationEnabled;
    const rejected = response.status === 'REJECTED';
    let precheck: FlowmaxPrecheck | null = null;
    if (!response.flowmaxSync && !rejected && this.integrationEnabled && mappingEnabled) {
      const result = await this.build(formId, responseId);
      if (result) {
        precheck = {
          problems: result.built.problems,
          incompatibleMedia: result.incompatible,
          notices: result.built.notices ?? [],
        };
      }
    }
    const sync = response.flowmaxSync ? this.view(response.flowmaxSync) : null;
    return {
      integrationEnabled: this.integrationEnabled,
      mappingEnabled,
      // الرد المرفوض: لا رابط ولا مشاركة حتى لو أُرسل قبل رفضه
      sync: sync && rejected ? { ...sync, detailUrl: null, share: null } : sync,
      precheck,
      rejected,
      editRevision: response.editRevision,
    };
  }

  // ---------- الاعتماد ----------

  /**
   * اعتماد الرد: يتحقق من الحقول المطلوبة (422 FLOWMAX_INCOMPLETE) ومن المرفقات غير المتوافقة مع Flowmax
   * (422 FLOWMAX_MEDIA_INCOMPATIBLE ما لم يستبعدها الأدمن صراحة)، ثم يحفظ اللقطة ويغيّر الحالة إلى «مقبول»
   * في معاملة واحدة ويبدأ الإرسال. تكرار الاعتماد أو اعتمادان متزامنان ينتجان سجلًا واحدًا.
   */
  async approve(
    actor: AuthContext,
    formId: string,
    responseId: string,
    options: { excludeFileIds?: unknown; editRevision?: unknown },
    meta: RequestMeta,
  ): Promise<FlowmaxStateView> {
    this.assertEnabled();
    const existing = await this.prisma.flowmaxSync.findUnique({ where: { responseId } });
    if (existing) {
      if (existing.formId !== formId) throw Errors.notFound('الرد غير موجود.');
      return this.state(formId, responseId);
    }
    const exclude = options.excludeFileIds ?? [];
    if (!Array.isArray(exclude) || !exclude.every((v) => typeof v === 'string')) {
      throw Errors.validation([{ field: 'excludeFileIds', message: 'قائمة الملفات غير صالحة.' }]);
    }
    const result = await this.build(formId, responseId);
    if (!result) {
      throw new AppError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FLOWMAX_DISABLED',
        'تكامل Flowmax غير مفعّل على هذا الخادم.',
      );
    }
    const { built, incompatible, editRevision } = result;
    const changed = () =>
      Errors.conflict(
        'RESPONSE_CHANGED',
        'عُدّلت بيانات هذا الرد بعد أن فتحته، فلم يُعتمد. راجع البيانات المحدّثة ثم أعد الاعتماد.',
      );
    if (options.editRevision !== undefined && options.editRevision !== editRevision)
      throw changed();
    if (built.problems.length || !built.operation || !built.share) {
      throw new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'FLOWMAX_INCOMPLETE',
        'لا يمكن اعتماد الرد: بيانات مطلوبة لإنشاء السجل ناقصة أو غير صالحة.',
        {
          fields: built.problems.map((p) => ({ field: `flowmax.${p.field}`, message: p.message })),
        },
      );
    }
    const excluded = new Set(exclude as string[]);
    const known = new Set(built.media.map((m) => m.fileId));
    if ([...excluded].some((id) => !known.has(id))) {
      throw Errors.validation([
        { field: 'excludeFileIds', message: 'أحد الملفات المستبعدة لا يخص هذا الرد.' },
      ]);
    }
    const blocking = incompatible.filter((m) => !excluded.has(m.fileId));
    if (blocking.length) {
      throw new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'FLOWMAX_MEDIA_INCOMPATIBLE',
        'لا يمكن اعتماد الرد: مرفقات لا يقبلها Flowmax. عالجها أو استبعدها صراحة قبل الاعتماد.',
        {
          fields: blocking.map((m) => ({
            field: `flowmax.media.${m.fileId}`,
            message: `«${m.name}»: ${m.reason}`,
          })),
        },
      );
    }
    const reasons = new Map(incompatible.map((m) => [m.fileId, m.reason]));
    const media: MediaItem[] = built.media.map((m) =>
      excluded.has(m.fileId)
        ? {
            fileId: m.fileId,
            role: m.role,
            status: 'EXCLUDED',
            excludedReason: reasons.get(m.fileId) ?? 'استبعده المراجع.',
            excludedById: actor.userId,
          }
        : { fileId: m.fileId, role: m.role, status: 'PENDING' },
    );
    let created: FlowmaxSync | null = null;
    try {
      created = await runFormTransaction(this.prisma, async (tx) => {
        const rows = await tx.$queryRaw<{ status: ResponseStatus; edit_revision: number }[]>`
          SELECT status, edit_revision FROM form_responses WHERE id = ${responseId} AND form_id = ${formId} FOR UPDATE`;
        const current = rows[0];
        if (!current) throw Errors.notFound('الرد غير موجود.');
        if (current.status === 'REJECTED')
          throw Errors.conflict('RESPONSE_REJECTED', REJECTED_MESSAGE);
        // تعديل حُفظ بين بناء الطلب وهذه المعاملة: لا يُرسل غير ما رآه المراجع
        if (Number(current.edit_revision) !== editRevision) throw changed();
        const sync = await tx.flowmaxSync.create({
          data: {
            responseId,
            formId,
            operation: built.operation!,
            sourceKey: sourceKeyFor(responseId),
            payload: json(built.body),
            share: json(built.share),
            media: json(media),
            approvedById: actor.userId,
          },
        });
        if (current.status !== 'ACCEPTED') {
          await tx.formResponse.update({ where: { id: responseId }, data: { status: 'ACCEPTED' } });
          await tx.formResponseStatusChange.create({
            data: {
              responseId,
              fromStatus: current.status,
              toStatus: 'ACCEPTED',
              changedById: actor.userId,
            },
          });
        }
        await this.audit.record(
          {
            actorId: actor.userId,
            action: 'response.flowmax_approved',
            entityType: 'response',
            entityId: responseId,
            details: {
              formId,
              operation: built.operation,
              from: current.status,
              excludedFileIds: [...excluded],
            },
            ipAddress: meta.ipAddress,
          },
          tx,
        );
        return sync;
      });
    } catch (error) {
      // اعتماد متزامن للرد نفسه: القيد الفريد على response_id يمنع سجلًا ثانيًا
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
    }
    if (created) this.kick(created.id);
    return this.state(formId, responseId);
  }

  /** إعادة المحاولة بعد الفشل فقط؛ تستكمل من حيث توقفت دون تكرار في Flowmax. */
  async retry(
    actor: AuthContext,
    formId: string,
    responseId: string,
    meta: RequestMeta,
  ): Promise<FlowmaxStateView> {
    this.assertEnabled();
    const sync = await this.syncOf(formId, responseId);
    await this.assertNotRejected(responseId);
    const { count } = await this.prisma.flowmaxSync.updateMany({
      where: { id: sync.id, status: 'FAILED' },
      data: { status: 'PENDING' },
    });
    if (count) {
      await this.audit.record({
        actorId: actor.userId,
        action: 'response.flowmax_retried',
        entityType: 'response',
        entityId: responseId,
        details: { formId, attempts: sync.attempts },
        ipAddress: meta.ipAddress,
      });
      this.kick(sync.id);
    }
    return this.state(formId, responseId);
  }

  private async assertNotRejected(responseId: string): Promise<void> {
    const r = await this.prisma.formResponse.findUnique({
      where: { id: responseId },
      select: { status: true },
    });
    if (r?.status === 'REJECTED') throw Errors.conflict('RESPONSE_REJECTED', REJECTED_MESSAGE);
  }

  private async syncOf(formId: string, responseId: string): Promise<FlowmaxSync> {
    const sync = await this.prisma.flowmaxSync.findUnique({ where: { responseId } });
    if (!sync || sync.formId !== formId) {
      throw Errors.conflict('FLOWMAX_NOT_APPROVED', 'هذا الرد لم يُعتمد للإرسال إلى Flowmax.');
    }
    return sync;
  }

  // ---------- النشر وتحديث الحالة ----------

  /**
   * نشر العرض في Flowmax بقواعد النشر فيه. منفصل عن الإرسال: لا يُطلب إلا بعد اكتمال نقل البيانات
   * والمرفقات. الفشل يحفظ السبب ويُبقي المعرّف، ويمكن إعادة المحاولة.
   */
  async publish(
    actor: AuthContext,
    formId: string,
    responseId: string,
    meta: RequestMeta,
  ): Promise<FlowmaxStateView> {
    this.assertEnabled();
    const sync = await this.syncOf(formId, responseId);
    await this.assertNotRejected(responseId);
    if (sync.status !== 'SENT') {
      throw Errors.conflict(
        'FLOWMAX_NOT_SENT',
        'لا يمكن النشر قبل اكتمال إرسال البيانات وكل المرفقات.',
      );
    }
    if (!(await this.publishRecord(sync))) return this.state(formId, responseId);
    await this.audit.record({
      actorId: actor.userId,
      action: 'response.flowmax_published',
      entityType: 'response',
      entityId: responseId,
      details: { formId },
      ipAddress: meta.ipAddress,
    });
    return this.state(formId, responseId);
  }

  /**
   * ينشر العرض بقواعد النشر في Flowmax (حجز بشرط الحالة فلا يتكرر الطلب). يعيد false إن كان منشورًا
   * أو قيد النشر. الفشل يُبقي المعرّف ويحفظ السبب للعرض وإعادة المحاولة.
   */
  private async publishRecord(sync: FlowmaxSync): Promise<boolean> {
    const { count } = await this.prisma.flowmaxSync.updateMany({
      where: { id: sync.id, publishState: { in: ['NONE', 'FAILED'] } },
      data: { publishState: 'REQUESTED', publishError: null },
    });
    if (!count) return false;
    try {
      const record = await this.client!.json<FlowmaxRecord>(
        'POST',
        `${API}/${sync.operation === 'OFFER' ? 'offers' : 'demands'}/${encodeURIComponent(sync.sourceKey)}/publish`,
        {},
      );
      await this.save(sync.id, {
        ...this.recordFields(record),
        publishState: 'PUBLISHED',
        publishedAt: new Date(),
        publishError: record.is_public ? null : 'نُشر في Flowmax لكنه غير ظاهر في الكتالوج العام.',
      });
    } catch (error) {
      this.logFailure(sync.id, 'publish', error);
      await this.save(sync.id, {
        publishState: 'FAILED',
        publishError: describe(error).slice(0, 300),
      });
    }
    return true;
  }

  /** يقرأ حالة السجل من Flowmax (مثلًا بعد نشر الطلب من مراجعة Flowmax). */
  async refresh(formId: string, responseId: string): Promise<FlowmaxStateView> {
    this.assertEnabled();
    const sync = await this.syncOf(formId, responseId);
    if (!sync.flowmaxId) return this.state(formId, responseId);
    try {
      const record = await this.client!.json<FlowmaxRecord>(
        'GET',
        `${API}/records/${encodeURIComponent(sync.sourceKey)}`,
      );
      await this.save(sync.id, {
        ...this.recordFields(record),
        ...(record.is_public && sync.publishState !== 'PUBLISHED'
          ? { publishState: 'PUBLISHED', publishedAt: new Date(), publishError: null }
          : {}),
      });
    } catch (error) {
      this.logFailure(sync.id, 'refresh', error);
      throw new AppError(
        HttpStatus.BAD_GATEWAY,
        'FLOWMAX_UNAVAILABLE',
        `تعذر تحديث الحالة من Flowmax. ${describe(error)}`,
      );
    }
    return this.state(formId, responseId);
  }

  // ---------- الإرسال ----------

  private kick(id: string): void {
    if (this.inflight.has(id)) return;
    const run = this.process(id)
      .catch((error: unknown) => {
        this.logger.error(`flowmax sync ${id} crashed: ${(error as Error).name}`);
      })
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, run);
  }

  /** حجز الإرسال بشرط الحالة (لا يعمل إرسالان على السجل نفسه). */
  private async claim(id: string): Promise<FlowmaxSync | null> {
    const now = new Date();
    const { count } = await this.prisma.flowmaxSync.updateMany({
      where: {
        id,
        OR: [{ status: 'PENDING' }, { status: 'SENDING', leaseUntil: { lt: now } }],
      },
      data: {
        status: 'SENDING',
        attempts: { increment: 1 },
        leaseUntil: new Date(now.getTime() + LEASE_MS),
      },
    });
    return count ? this.prisma.flowmaxSync.findUnique({ where: { id } }) : null;
  }

  private save(id: string, data: Prisma.FlowmaxSyncUpdateInput) {
    return this.prisma.flowmaxSync.update({ where: { id }, data });
  }

  private recordFields(record: FlowmaxRecord): Prisma.FlowmaxSyncUpdateInput {
    return {
      flowmaxId: String(record.id),
      flowmaxRef: record.reference ? String(record.reference).slice(0, 100) : null,
      detailUrl: record.detail_url ? String(record.detail_url).slice(0, 500) : null,
      remoteStatus: record.status ? String(record.status).slice(0, 32) : null,
      isPublic: record.is_public === true,
    };
  }

  private logFailure(id: string, step: string, error: unknown): void {
    const fx = error instanceof FlowmaxError ? error : null;
    this.logger.warn(
      `flowmax sync ${id} ${step} failed: ${fx ? `${fx.failure} ${fx.status ?? ''} ${fx.code ?? ''}` : (error as Error).name}`,
    );
  }

  async process(id: string): Promise<void> {
    const sync = await this.claim(id);
    if (!sync) return;
    try {
      if (!this.client) throw new FlowmaxError('network');
      if (!sync.flowmaxId) {
        // محاولة سابقة ربما أنشأت السجل ثم انقطع الاتصال: يُبحث بالمفتاح الفريد قبل أي إنشاء.
        // (Flowmax يعيد السجل نفسه لو أُعيد الإنشاء بالمفتاح نفسه؛ البحث يوضح ذلك صراحة ويقلل الطلبات)
        let record = sync.attempts > 1 ? await this.lookup(this.client, sync.sourceKey) : null;
        record ??= await this.client.json<FlowmaxRecord>(
          'POST',
          `${API}/${sync.operation === 'OFFER' ? 'offers' : 'demands'}`,
          { source_key: sync.sourceKey, ...(sync.payload as Record<string, unknown>) },
        );
        await this.save(sync.id, this.recordFields(record));
      }
      const failed = sync.operation === 'OFFER' ? await this.sendMedia(this.client, sync) : [];
      if (failed.length) {
        await this.save(sync.id, {
          status: 'FAILED',
          leaseUntil: null,
          lastError: `لم يكتمل نقل ${failed.length} من المرفقات؛ أعد المحاولة.`,
        });
        return;
      }
      await this.save(sync.id, {
        status: 'SENT',
        sentAt: new Date(),
        lastError: null,
        leaseUntil: null,
      });
      // اعتماد المراجع هنا يتبعه نشر العرض أو الطلب بعد اكتمال الإرسال.
      await this.publishRecord(sync);
    } catch (error) {
      this.logFailure(id, 'send', error);
      await this.save(id, {
        status: 'FAILED',
        lastError: describe(error).slice(0, 300),
        leaseUntil: null,
      });
    }
  }

  /** السجل المرتبط بالمفتاح في Flowmax، أو null إن لم يُنشأ (404). */
  private async lookup(client: FlowmaxClient, sourceKey: string): Promise<FlowmaxRecord | null> {
    try {
      return await client.json<FlowmaxRecord>(
        'GET',
        `${API}/records/${encodeURIComponent(sourceKey)}`,
      );
    } catch (error) {
      if (error instanceof FlowmaxError && error.status === 404) return null;
      throw error;
    }
  }

  /** ينقل كل مرفق غير مرسل بمفتاحه الخاص، ويحفظ نتيجة كل مرفق. يعيد المرفقات التي فشلت. */
  private async sendMedia(client: FlowmaxClient, sync: FlowmaxSync): Promise<MediaItem[]> {
    const media = (sync.media as unknown as MediaItem[]).map((m) => ({ ...m }));
    let n = 0;
    for (const item of media) {
      n++;
      if (item.status === 'SENT' || item.status === 'EXCLUDED') continue;
      const file = await this.prisma.uploadedFile.findFirst({
        where: { id: item.fileId, responseId: sync.responseId },
        select: { id: true, storageKey: true, kind: true, sizeBytes: true },
      });
      try {
        if (!file || !(await this.storage.exists(file.storageKey))) {
          throw new Error('missing');
        }
        const result = await client.upload<{ id: number | string }>(
          `${API}/offers/${encodeURIComponent(sync.sourceKey)}/media`,
          {
            fields: { media_key: mediaKeyFor(sync.sourceKey, item.fileId), kind: item.role },
            filename: `media-${n}.${EXT[file.kind] ?? 'bin'}`,
            mime: MIME_BY_KIND[file.kind],
            size: file.sizeBytes,
            stream: this.storage.openRead(file.storageKey),
          },
        );
        item.status = 'SENT';
        item.externalId = String(result.id);
        item.error = null;
      } catch (error) {
        this.logFailure(sync.id, `media ${item.fileId}`, error);
        item.status = 'FAILED';
        item.error =
          error instanceof FlowmaxError
            ? error.describe().slice(0, 200)
            : 'الملف غير متاح في التخزين.';
      }
      await this.save(sync.id, { media: json(media) });
    }
    return media.filter((m) => m.status === 'FAILED');
  }

  private view(sync: FlowmaxSync): FlowmaxSyncView {
    const media = (sync.media as unknown as MediaItem[]) ?? [];
    const shareable = sync.status === 'SENT' && sync.isPublic && Boolean(sync.detailUrl);
    return {
      status: sync.status,
      operation: sync.operation,
      flowmaxId: sync.flowmaxId,
      flowmaxRef: sync.flowmaxRef,
      detailUrl: sync.detailUrl,
      remoteStatus: sync.remoteStatus,
      isPublic: sync.isPublic,
      publishState: sync.publishState,
      publishError: sync.publishError,
      sentAt: sync.sentAt?.toISOString() ?? null,
      approvedAt: sync.approvedAt.toISOString(),
      lastError: sync.status === 'FAILED' ? sync.lastError : null,
      attempts: sync.attempts,
      media: media.map((m) => ({
        fileId: m.fileId,
        role: m.role,
        status: m.status,
        error: m.error ?? null,
        excludedReason: m.excludedReason ?? null,
      })),
      share: shareable ? (sync.share as unknown as ShareInfo) : null,
    };
  }
}
