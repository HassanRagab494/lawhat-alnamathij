import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Prisma, type FileKind, type FlowmaxSync, type ResponseStatus } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../auth/auth-context';
import type { RequestMeta } from '../../auth/decorators';
import { AppError, Errors, type FieldError } from '../../common/errors';
import { APP_ENV, type AppEnv } from '../../config/env';
import { MIME_BY_KIND } from '../../files/file-kind';
import type { FileStorage } from '../../files/storage';
import { FILE_STORAGE } from '../../files/uploads.service';
import { runFormTransaction } from '../../forms/form-transaction';
import { PrismaService } from '../../prisma/prisma.service';
import { FlowmaxClient, FlowmaxError } from './client';
import { FLOWMAX_FIELDS } from './fields';
import {
  buildFlowmaxRequest,
  mappingConfigSchema,
  type AnswerInput,
  type MappingConfig,
  type MediaPlan,
  type ShareInfo,
} from './mapping';

export const FLOWMAX_CLIENT = Symbol('FLOWMAX_CLIENT');

/** مدة حجز الإرسال؛ بعدها يُعتبر الإرسال منقطعًا (انهيار العملية) ويمكن إعادة المحاولة. */
const LEASE_MS = 30 * 60 * 1000;
/** حدود Flowmax لوسائط العقار (property-listing-fields.md وإعداد الفيديو الافتراضي). */
const FLOWMAX_IMAGE_MAX = 10 * 1024 * 1024;
const FLOWMAX_VIDEO_MAX = 100 * 1024 * 1024;
const EXT: Partial<Record<FileKind, string>> = {
  JPG: 'jpg',
  PNG: 'png',
  WEBP: 'webp',
  MP4: 'mp4',
  MOV: 'mov',
  WEBM: 'webm',
};

interface MediaState extends MediaPlan {
  sent: string[];
  skipped: string[];
}

export interface FlowmaxSyncView {
  status: FlowmaxSync['status'];
  operation: FlowmaxSync['operation'];
  flowmaxId: string | null;
  flowmaxRef: string | null;
  url: string | null;
  sentAt: string | null;
  approvedAt: string;
  lastError: string | null;
  attempts: number;
  published: boolean;
  mediaSent: number;
  mediaSkipped: number;
  /** بيانات المشاركة الآمنة (بلا بيانات المالك)؛ بعد نجاح الإرسال فقط. */
  share: ShareInfo | null;
}

export interface FlowmaxStateView {
  integrationEnabled: boolean;
  mappingEnabled: boolean;
  sync: FlowmaxSyncView | null;
}

export interface MappingView {
  integrationEnabled: boolean;
  enabled: boolean;
  config: MappingConfig;
  fields: typeof FLOWMAX_FIELDS;
  questions: { id: string; title: string; type: string; options: string[] }[];
  updatedAt: string | null;
}

const idempotencyKeyFor = (responseId: string) => `lawha-${responseId}`;

/**
 * تكامل Flowmax: لا يُرسل أي رد قبل اعتماد صريح من مستخدم يملك مراجعة الردود. الاعتماد يحفظ لقطة
 * الطلب وحالة pending ثم يُرسل في الخلفية؛ مفتاح منع التكرار ثابت لكل رد، ومعرّف العقار يُحفظ فور
 * إنشائه، فلا تُنشئ إعادة المحاولة عقارًا ثانيًا. السجلات لا تحمل الرمز ولا بيانات المالك.
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

  /** إرسال انقطع بانهيار العملية السابقة ⇒ فشل قابل لإعادة المحاولة (مع البحث قبل أي إنشاء). */
  async onModuleInit(): Promise<void> {
    // دون تفعيل الربط لا إرسال؛ الاستعادة تتم عند أول تشغيل بالربط مفعّلًا
    if (!this.integrationEnabled) return;
    const { count } = await this.prisma.flowmaxSync.updateMany({
      where: { status: { in: ['SENDING', 'PENDING'] } },
      data: {
        status: 'FAILED',
        lastError: 'انقطع الإرسال قبل اكتماله؛ أعد المحاولة.',
        leaseUntil: null,
      },
    });
    await this.prisma.flowmaxSync.updateMany({
      where: { status: 'FAILED', flowmaxId: null, attempts: { gt: 0 } },
      data: { createUncertain: true },
    });
    if (count) this.logger.warn(`recovered ${count} interrupted flowmax sync(s)`);
  }

  get integrationEnabled(): boolean {
    return this.env.FLOWMAX_ENABLED && this.client !== null;
  }

  /** ينتظر انتهاء كل الإرسالات الجارية (للاختبارات والإغلاق). */
  async whenIdle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()]);
  }

  // ---------- الربط ----------

  private async latestQuestions(formId: string) {
    const form = await this.prisma.form.findUnique({
      where: { id: formId },
      select: {
        id: true,
        versions: {
          orderBy: { versionNumber: 'desc' },
          take: 1,
          select: {
            questions: {
              orderBy: { position: 'asc' },
              select: {
                logicalId: true,
                title: true,
                type: true,
                options: { orderBy: { position: 'asc' }, select: { label: true } },
              },
            },
          },
        },
      },
    });
    if (!form) throw Errors.notFound('النموذج غير موجود.');
    return (form.versions[0]?.questions ?? []).map((q) => ({
      id: q.logicalId,
      title: q.title,
      type: q.type as string,
      options: q.options.map((o) => o.label),
    }));
  }

  async getMapping(formId: string): Promise<MappingView> {
    const questions = await this.latestQuestions(formId);
    const row = await this.prisma.formFlowmaxMapping.findUnique({ where: { formId } });
    return {
      integrationEnabled: this.integrationEnabled,
      enabled: row?.enabled ?? false,
      config: (row?.config as MappingConfig | undefined) ?? { fields: {} },
      fields: FLOWMAX_FIELDS,
      questions,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  async saveMapping(
    actor: AuthContext,
    formId: string,
    input: { enabled?: unknown; config?: unknown },
    meta: RequestMeta,
  ): Promise<MappingView> {
    const questions = await this.latestQuestions(formId);
    const parsed = mappingConfigSchema.safeParse(input.config ?? { fields: {} });
    const errors: FieldError[] = [];
    if (typeof input.enabled !== 'boolean') {
      errors.push({ field: 'enabled', message: 'القيمة يجب أن تكون true أو false.' });
    }
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({ field: ['config', ...issue.path].join('.'), message: issue.message });
      }
    } else {
      const byId = new Map(questions.map((q) => [q.id, q]));
      for (const [key, source] of Object.entries(parsed.data.fields)) {
        if (!source.questionId) continue;
        const q = byId.get(source.questionId.toLowerCase());
        const def = FLOWMAX_FIELDS.find((f) => f.key === key)!;
        if (!q) {
          errors.push({
            field: `config.fields.${key}`,
            message: 'السؤال غير موجود في آخر إصدار منشور.',
          });
        } else if ((def.type === 'files') !== (q.type === 'FILE_UPLOAD')) {
          errors.push({
            field: `config.fields.${key}`,
            message:
              def.type === 'files' ? 'اختر سؤال رفع ملفات.' : 'لا يُربط هذا الحقل بسؤال ملفات.',
          });
        } else {
          source.questionId = source.questionId.toLowerCase();
        }
      }
    }
    if (errors.length) throw Errors.validation(errors);
    const config = parsed.data!;
    const enabled = input.enabled as boolean;
    await this.prisma.formFlowmaxMapping.upsert({
      where: { formId },
      create: { formId, enabled, config, updatedById: actor.userId },
      update: { enabled, config, updatedById: actor.userId },
    });
    await this.audit.record({
      actorId: actor.userId,
      action: 'form.flowmax_mapping_updated',
      entityType: 'form',
      entityId: formId,
      details: { enabled, fields: Object.keys(config.fields) },
      ipAddress: meta.ipAddress,
    });
    return this.getMapping(formId);
  }

  // ---------- الاعتماد والإرسال ----------

  private async responseAnswers(formId: string, responseId: string) {
    const r = await this.prisma.formResponse.findFirst({
      where: { id: responseId, formId },
      select: {
        id: true,
        referenceCode: true,
        submittedAt: true,
        version: {
          select: {
            questions: { select: { id: true, logicalId: true, title: true, type: true } },
          },
        },
        answers: {
          select: {
            questionId: true,
            textValue: true,
            numberValue: true,
            dateValue: true,
            options: { select: { option: { select: { label: true, position: true } } } },
            files: {
              orderBy: { createdAt: 'asc' },
              select: { id: true, kind: true, sizeBytes: true },
            },
          },
        },
      },
    });
    if (!r) throw Errors.notFound('الرد غير موجود.');
    const byQuestion = new Map(r.answers.map((a) => [a.questionId, a]));
    const answers: AnswerInput[] = r.version.questions.map((q) => {
      const a = byQuestion.get(q.id);
      return {
        logicalId: q.logicalId,
        title: q.title,
        type: q.type,
        text: a?.textValue ?? null,
        number: a?.numberValue != null ? a.numberValue.toFixed() : null,
        date: a?.dateValue ? a.dateValue.toISOString().slice(0, 10) : null,
        choices: a?.options
          .slice()
          .sort((x, y) => x.option.position - y.option.position)
          .map((o) => o.option.label),
        files: a?.files.map((f) => ({ id: f.id, kind: f.kind, size: f.sizeBytes })),
      };
    });
    return { response: r, answers };
  }

  async state(formId: string, responseId: string): Promise<FlowmaxStateView> {
    const response = await this.prisma.formResponse.findFirst({
      where: { id: responseId, formId },
      select: { id: true, flowmaxSync: true, form: { select: { flowmaxMapping: true } } },
    });
    if (!response) throw Errors.notFound('الرد غير موجود.');
    return {
      integrationEnabled: this.integrationEnabled,
      mappingEnabled: response.form.flowmaxMapping?.enabled ?? false,
      sync: response.flowmaxSync ? this.view(response.flowmaxSync) : null,
    };
  }

  /**
   * اعتماد الرد وإرساله: يتحقق من اكتمال البيانات المطلوبة (وإلا 422 برسائل عربية)، ثم يحفظ لقطة
   * الطلب ويغيّر حالة الرد إلى «مقبول» في معاملة واحدة، ثم يبدأ الإرسال. تكرار الاعتماد يعيد الحالة نفسها.
   */
  async approve(
    actor: AuthContext,
    formId: string,
    responseId: string,
    meta: RequestMeta,
  ): Promise<FlowmaxStateView> {
    if (!this.integrationEnabled) {
      throw new AppError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FLOWMAX_DISABLED',
        'ربط Flowmax غير مفعّل على هذا الخادم.',
      );
    }
    const existing = await this.prisma.flowmaxSync.findUnique({ where: { responseId } });
    if (existing) {
      if (existing.formId !== formId) throw Errors.notFound('الرد غير موجود.');
      return this.state(formId, responseId);
    }
    const mapping = await this.prisma.formFlowmaxMapping.findUnique({ where: { formId } });
    if (!mapping?.enabled) {
      throw Errors.conflict(
        'FLOWMAX_MAPPING_MISSING',
        'لم يُفعّل ربط هذا النموذج مع Flowmax بعد. اضبط الربط من إعدادات النموذج.',
      );
    }
    const config = mappingConfigSchema.parse(mapping.config);
    const { response, answers } = await this.responseAnswers(formId, responseId);
    const key = idempotencyKeyFor(responseId);
    const built = buildFlowmaxRequest(config, answers, {
      idempotencyKey: key,
      referenceCode: response.referenceCode,
      submittedAt: response.submittedAt,
    });
    if (built.problems.length || !built.operation || !built.share) {
      throw new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'FLOWMAX_INCOMPLETE',
        'لا يمكن اعتماد الرد: بيانات مطلوبة لإنشاء العقار ناقصة أو غير صالحة.',
        {
          fields: built.problems.map((p) => ({ field: `flowmax.${p.field}`, message: p.message })),
        },
      );
    }
    const media: MediaState = { ...built.media, sent: [], skipped: [] };
    let created: FlowmaxSync | null = null;
    try {
      created = await runFormTransaction(this.prisma, async (tx) => {
        const rows = await tx.$queryRaw<{ status: ResponseStatus }[]>`
          SELECT status FROM form_responses WHERE id = ${responseId} AND form_id = ${formId} FOR UPDATE`;
        const current = rows[0];
        if (!current) throw Errors.notFound('الرد غير موجود.');
        const sync = await tx.flowmaxSync.create({
          data: {
            responseId,
            formId,
            operation: built.operation!,
            idempotencyKey: key,
            payload: built.body as Prisma.InputJsonObject,
            share: built.share as unknown as Prisma.InputJsonObject,
            media: media as unknown as Prisma.InputJsonObject,
            approvedById: actor.userId,
          },
        });
        if (current.status !== 'ACCEPTED') {
          await tx.formResponse.update({ where: { id: responseId }, data: { status: 'ACCEPTED' } });
          await tx.formResponseStatusChange.create({
            data: {
              responseId,
              fromStatus: current.status as ResponseStatus,
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
            details: { formId, operation: built.operation, from: current.status },
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

  /** إعادة المحاولة بعد الفشل فقط؛ تستكمل من حيث توقفت (لا تنشئ عقارًا ثانيًا ولا تعيد الوسائط المرسلة). */
  async retry(
    actor: AuthContext,
    formId: string,
    responseId: string,
    meta: RequestMeta,
  ): Promise<FlowmaxStateView> {
    if (!this.integrationEnabled) {
      throw new AppError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FLOWMAX_DISABLED',
        'ربط Flowmax غير مفعّل على هذا الخادم.',
      );
    }
    const sync = await this.prisma.flowmaxSync.findUnique({ where: { responseId } });
    if (!sync || sync.formId !== formId) {
      throw Errors.conflict('FLOWMAX_NOT_APPROVED', 'هذا الرد لم يُعتمد للإرسال إلى Flowmax.');
    }
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

  async process(id: string): Promise<void> {
    const sync = await this.claim(id);
    if (!sync) return;
    const client = this.client;
    try {
      if (!client) throw new FlowmaxError('network');
      if (sync.operation === 'OFFER') await this.sendOffer(client, sync);
      else await this.sendRequest(client, sync);
    } catch (error) {
      const fx = error instanceof FlowmaxError ? error : null;
      const message = fx ? fx.describe() : 'خطأ داخلي أثناء الإرسال.';
      this.logger.warn(
        `flowmax sync ${id} failed: ${fx ? `${fx.failure} ${fx.status ?? ''}` : (error as Error).name}`,
      );
      await this.save(id, { status: 'FAILED', lastError: message.slice(0, 300), leaseUntil: null });
    }
  }

  private async sendOffer(client: FlowmaxClient, sync: FlowmaxSync): Promise<void> {
    const payload = sync.payload as Record<string, unknown>;
    let flowmaxId = sync.flowmaxId;
    if (!flowmaxId && sync.createUncertain) {
      // محاولة سابقة أُرسلت دون نتيجة: يُبحث عن العقار بمرجع المنصة (platform_code) قبل أي إنشاء
      const found = await this.findOffer(client, payload, sync.idempotencyKey);
      if (found) {
        flowmaxId = String(found.id);
        await this.save(sync.id, {
          flowmaxId,
          flowmaxRef: found.property_code ?? null,
          createUncertain: false,
        });
      }
    }
    if (!flowmaxId) {
      let created: { id: number | string; property_code?: string };
      try {
        created = await client.json('POST', '/api/admin/properties', payload, sync.idempotencyKey);
      } catch (error) {
        if (error instanceof FlowmaxError && error.uncertain) {
          await this.save(sync.id, { createUncertain: true });
        }
        throw error;
      }
      flowmaxId = String(created.id);
      // يُحفظ المعرّف فورًا: أي فشل لاحق (الوسائط) لا يؤدي إلى إنشاء ثانٍ
      await this.save(sync.id, {
        flowmaxId,
        flowmaxRef: created.property_code ?? null,
        createUncertain: false,
      });
    }
    await this.sendMedia(client, sync, flowmaxId);
    let publishedAt = sync.publishedAt;
    if (this.env.FLOWMAX_AUTO_PUBLISH && !publishedAt) {
      await client.json(
        'POST',
        `/api/admin/properties/${encodeURIComponent(flowmaxId)}/publish`,
        {},
      );
      publishedAt = new Date();
      await this.save(sync.id, { publishedAt });
    }
    await this.save(sync.id, {
      status: 'SENT',
      sentAt: new Date(),
      lastError: null,
      leaseUntil: null,
      flowmaxUrl: `${this.siteUrl()}/property/${encodeURIComponent(flowmaxId)}`,
    });
  }

  private async findOffer(
    client: FlowmaxClient,
    payload: Record<string, unknown>,
    key: string,
  ): Promise<{ id: number | string; property_code?: string } | null> {
    const q = new URLSearchParams({
      search: String(payload.title_ar ?? ''),
      city: String(payload.city ?? ''),
      per_page: '100',
    });
    const list = await client.json<
      { id: number | string; property_code?: string; platform_code?: string }[]
    >('GET', `/api/admin/properties?${q.toString()}`);
    return (Array.isArray(list) ? list : []).find((p) => p.platform_code === key) ?? null;
  }

  private async sendMedia(client: FlowmaxClient, sync: FlowmaxSync, flowmaxId: string) {
    const media = sync.media as unknown as MediaState;
    const done = new Set([...media.sent, ...media.skipped]);
    const queue = [
      ...media.images.map((id) => ({ id, field: 'image' as const, max: FLOWMAX_IMAGE_MAX })),
      ...media.videos.map((id) => ({ id, field: 'video' as const, max: FLOWMAX_VIDEO_MAX })),
    ].filter((m) => !done.has(m.id));
    let n = media.sent.length;
    for (const item of queue) {
      const file = await this.prisma.uploadedFile.findFirst({
        where: { id: item.id, responseId: sync.responseId },
        select: { id: true, storageKey: true, kind: true, sizeBytes: true },
      });
      if (!file || file.sizeBytes > item.max || !EXT[file.kind]) {
        media.skipped.push(item.id);
        await this.save(sync.id, { media: media as unknown as Prisma.InputJsonObject });
        continue;
      }
      n++;
      await client.upload(
        `/api/admin/properties/${encodeURIComponent(flowmaxId)}/${item.field === 'image' ? 'images' : 'videos'}`,
        {
          field: item.field,
          filename: `media-${n}.${EXT[file.kind]}`,
          mime: MIME_BY_KIND[file.kind],
          size: file.sizeBytes,
          stream: this.storage.openRead(file.storageKey),
        },
      );
      media.sent.push(item.id);
      await this.save(sync.id, { media: media as unknown as Prisma.InputJsonObject });
    }
  }

  private async sendRequest(client: FlowmaxClient, sync: FlowmaxSync): Promise<void> {
    // Flowmax يدعم idempotency_key للطلبات: إعادة الإرسال تعيد الطلب الأصلي دون إنشاء ثانٍ
    const created = await client.json<{ id: number | string; reference?: string }>(
      'POST',
      '/api/admin/property-demands',
      sync.payload,
      sync.idempotencyKey,
    );
    const ref = created.reference ?? null;
    await this.save(sync.id, {
      status: 'SENT',
      flowmaxId: String(created.id),
      flowmaxRef: ref,
      sentAt: new Date(),
      lastError: null,
      leaseUntil: null,
      createUncertain: false,
      flowmaxUrl: ref ? `${this.siteUrl()}/properties/demands/${encodeURIComponent(ref)}` : null,
    });
  }

  private siteUrl(): string {
    return (this.env.FLOWMAX_PUBLIC_SITE_URL ?? '').replace(/\/+$/, '');
  }

  private view(sync: FlowmaxSync): FlowmaxSyncView {
    const media = sync.media as unknown as MediaState;
    return {
      status: sync.status,
      operation: sync.operation,
      flowmaxId: sync.flowmaxId,
      flowmaxRef: sync.flowmaxRef,
      url: sync.status === 'SENT' ? sync.flowmaxUrl : null,
      sentAt: sync.sentAt?.toISOString() ?? null,
      approvedAt: sync.approvedAt.toISOString(),
      lastError: sync.status === 'FAILED' ? sync.lastError : null,
      attempts: sync.attempts,
      published: Boolean(sync.publishedAt),
      mediaSent: media.sent?.length ?? 0,
      mediaSkipped: media.skipped?.length ?? 0,
      share: sync.status === 'SENT' ? (sync.share as unknown as ShareInfo) : null,
    };
  }
}
