import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type FileKind } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AppError, Errors, type FieldError } from '../common/errors';
import { APP_ENV, type AppEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { QUESTION_LIMITS } from '../forms/questions/limits';
import { FileRejected, VIDEO_KINDS, inspectFile } from './file-kind';
import { extensionOf, sanitizeFileName } from './filename';
import { ScanUnavailable, type MalwareScanner } from './scanner';
import { TooLarge, type FileStorage, type TempFile } from './storage';

export const FILE_STORAGE = Symbol('FILE_STORAGE');
export const MALWARE_SCANNER = Symbol('MALWARE_SCANNER');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{16,32}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MB = 1024 * 1024;
const NOT_FOUND = 'النموذج غير موجود أو لم يُنشر بعد.';

const EXT_BY_KEY: Record<string, string[]> = {
  pdf: ['pdf'],
  jpg: ['jpg', 'jpeg'],
  png: ['png'],
  webp: ['webp'],
  docx: ['docx'],
  xlsx: ['xlsx'],
  txt: ['txt'],
  mp4: ['mp4'],
  mov: ['mov'],
  webm: ['webm'],
};

export interface FileSettings {
  allowedTypes: string[];
  maxFileSizeMb: number;
  maxFiles: number;
}

export interface UploadedFileDto {
  id: string;
  name: string;
  size: number;
  kind: FileKind;
}

export const hashFillToken = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex');

const err = (status: HttpStatus, code: string, message: string) =>
  new AppError(status, code, message);

export function fileSettings(settings: unknown): FileSettings {
  const s = (settings ?? {}) as Partial<FileSettings>;
  return {
    allowedTypes: Array.isArray(s.allowedTypes) ? s.allowedTypes : [],
    maxFileSizeMb: typeof s.maxFileSizeMb === 'number' ? s.maxFileSizeMb : 1,
    maxFiles: typeof s.maxFiles === 'number' ? s.maxFiles : 1,
  };
}

/** ملفات إجابة سؤال واحد كما وصلت في طلب الإرسال. */
export interface FileAnswerInput {
  questionId: string;
  fileIds: string[];
}

/**
 * رفع الملفات للتعبئة العامة. لا يُقبل ملف قبل التحقق من الحجم والنوع الفعلي ونجاح فحص البرمجيات الخبيثة.
 * لا يُسجَّل محتوى الملفات ولا أسماؤها في السجلات.
 */
@Injectable()
export class UploadsService {
  private readonly logger = new Logger('Uploads');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  /**
   * الرفع مفعّل عند ضبط فاحص (UPLOAD_SCAN_MODE=required مع CLAMAV_HOST)، أو عند اختيار
   * UPLOAD_SCAN_MODE=disabled صراحة: يُقبل الملف بعد التحقق من النوع والحجم دون فحص برمجيات خبيثة.
   */
  get enabled(): boolean {
    return this.env.UPLOAD_SCAN_MODE === 'disabled' || Boolean(this.env.CLAMAV_HOST);
  }

  /** هل تُفحص الملفات ضد البرمجيات الخبيثة؟ false في وضع disabled. */
  get malwareScanning(): boolean {
    return this.env.UPLOAD_SCAN_MODE === 'required';
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw err(
        HttpStatus.SERVICE_UNAVAILABLE,
        'UPLOADS_UNAVAILABLE',
        'رفع الملفات غير متاح حاليًا على هذا الخادم.',
      );
    }
  }

  /** النموذج المفتوح وأحدث إصدار منشور؛ وإلا 404 أو 409 كالإرسال. */
  private async openForm(publicId: string) {
    if (!PUBLIC_ID_RE.test(publicId)) throw Errors.notFound(NOT_FOUND);
    const form = await this.prisma.form.findUnique({
      where: { publicId },
      select: {
        id: true,
        archivedAt: true,
        acceptingResponses: true,
        versions: { orderBy: { versionNumber: 'desc' }, take: 1, select: { id: true } },
      },
    });
    const latest = form?.versions[0];
    if (!form || !latest) throw Errors.notFound(NOT_FOUND);
    if (form.archivedAt || !form.acceptingResponses) {
      throw Errors.conflict('RESPONSES_CLOSED', 'استقبال الردود على هذا النموذج مغلق حاليًا.');
    }
    return { formId: form.id, versionId: latest.id };
  }

  /** جلسة تعبئة مجهولة للإصدار الحالي؛ الرمز يُعاد مرة واحدة ويُخزَّن تجزئته فقط. */
  async createSession(publicId: string): Promise<{ token: string; expiresAt: string }> {
    this.assertEnabled();
    const { formId, versionId } = await this.openForm(publicId);
    const hasFiles = await this.prisma.formVersionQuestion.count({
      where: { versionId, type: 'FILE_UPLOAD' },
    });
    if (!hasFiles) {
      throw Errors.validation([{ field: 'publicId', message: 'لا يحتوي هذا النموذج سؤال ملفات.' }]);
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.env.UPLOAD_SESSION_TTL_MINUTES * 60_000);
    await this.prisma.fillSession.create({
      data: { tokenHash: hashFillToken(token), formId, versionId, expiresAt },
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  /** الجلسة الصالحة لهذا النموذج وإصداره الحالي. */
  private async session(publicId: string, token: string | undefined) {
    const { formId, versionId } = await this.openForm(publicId);
    const s =
      token && TOKEN_RE.test(token)
        ? await this.prisma.fillSession.findUnique({ where: { tokenHash: hashFillToken(token) } })
        : null;
    if (!s || s.formId !== formId || s.expiresAt <= new Date()) {
      throw err(
        HttpStatus.UNAUTHORIZED,
        'FILL_SESSION_INVALID',
        'انتهت جلسة رفع الملفات. حدّث الصفحة ثم أعد رفع الملفات.',
      );
    }
    if (s.versionId !== versionId) {
      throw Errors.conflict(
        'VERSION_OUTDATED',
        'نُشر تحديث لهذا النموذج بعد أن فتحته. حدّث النموذج ثم أعد رفع الملفات.',
      );
    }
    return s;
  }

  private tooLarge(s: FileSettings) {
    return err(
      HttpStatus.PAYLOAD_TOO_LARGE,
      'FILE_TOO_LARGE',
      `حجم الملف يتجاوز الحد المسموح (${s.maxFileSizeMb} ميغابايت).`,
    );
  }

  private sessionFull() {
    return err(
      HttpStatus.PAYLOAD_TOO_LARGE,
      'SESSION_UPLOAD_LIMIT',
      `تجاوزت ملفات هذه التعبئة الحد الإجمالي (${this.env.UPLOAD_SESSION_MAX_MB} ميغابايت).`,
    );
  }

  /** عدد ملفات السؤال غير المرسلة في الجلسة، والسعة الإجمالية للتخزين. */
  private async assertCapacity(
    db: Prisma.TransactionClient | PrismaService,
    sessionId: string,
    questionId: string,
    settings: FileSettings,
    incomingBytes: number,
  ): Promise<void> {
    const count = await db.uploadedFile.count({
      where: { fillSessionId: sessionId, questionId, responseId: null },
    });
    if (count >= settings.maxFiles) {
      throw Errors.conflict(
        'FILE_COUNT_LIMIT',
        `بلغت الحد الأقصى لعدد الملفات في هذا السؤال (${settings.maxFiles}). احذف ملفًا قبل رفع آخر.`,
      );
    }
    const total = await db.uploadedFile.aggregate({ _sum: { sizeBytes: true } });
    if ((total._sum.sizeBytes ?? 0) + incomingBytes > this.env.UPLOAD_STORAGE_MAX_GB * 1024 * MB) {
      throw err(
        HttpStatus.INSUFFICIENT_STORAGE,
        'STORAGE_FULL',
        'مساحة تخزين الملفات ممتلئة حاليًا؛ لا يمكن قبول ملفات جديدة.',
      );
    }
  }

  /**
   * رفع ملف بالتدفق: كتابة مؤقتة بحد الحجم ⇒ تحديد النوع من المحتوى ⇒ فحص البرمجيات الخبيثة
   * ⇒ تثبيت بمفتاح عشوائي ⇒ تسجيله مرتبطًا بالجلسة والسؤال (بقفل الجلسة وإعادة فحص الحدود).
   * أي فشل يحذف الجزء المؤقت أو الملف المثبت؛ لا يبقى ملف غير مسجل.
   */
  async upload(
    publicId: string,
    token: string | undefined,
    questionId: string | undefined,
    rawName: string | undefined,
    contentLength: number | undefined,
    body: Readable,
  ): Promise<UploadedFileDto> {
    this.assertEnabled();
    const session = await this.session(publicId, token);
    return this.storeFile(session, questionId, rawName, contentLength, body);
  }

  /**
   * رفع ملف إداري لتعديل رد قائم قبل اعتماده: جلسة داخلية مرتبطة بالرد (بلا رمز عام) لإصدار الرد نفسه.
   * الملف لا يُربط بالرد إلا عند حفظ التعديل؛ إن لم يُحفظ يحذفه التنظيف الحالي بعد انتهاء صلاحيته.
   */
  async uploadForResponse(
    formId: string,
    responseId: string,
    questionId: string | undefined,
    rawName: string | undefined,
    contentLength: number | undefined,
    body: Readable,
  ): Promise<UploadedFileDto> {
    this.assertEnabled();
    const response = await this.prisma.formResponse.findFirst({
      where: { id: responseId, formId },
      select: { versionId: true, flowmaxSync: { select: { id: true } } },
    });
    if (!response) throw Errors.notFound('الرد غير موجود.');
    if (response.flowmaxSync) {
      throw Errors.conflict('RESPONSE_LOCKED', 'أُرسل هذا الرد إلى Flowmax، فلا يمكن تعديله.');
    }
    const now = new Date();
    const session =
      (await this.prisma.fillSession.findFirst({
        where: {
          responseId,
          versionId: response.versionId,
          expiresAt: { gt: new Date(now.getTime() + 5 * 60_000) },
        },
        orderBy: { createdAt: 'desc' },
      })) ??
      (await this.prisma.fillSession.create({
        data: {
          // رمز عشوائي لا يُعاد لأحد: الجلسة لا تُستخدم من المسارات العامة
          tokenHash: hashFillToken(randomBytes(32).toString('base64url')),
          formId,
          versionId: response.versionId,
          responseId,
          expiresAt: new Date(now.getTime() + this.env.UPLOAD_SESSION_TTL_MINUTES * 60_000),
        },
      }));
    return this.storeFile(session, questionId, rawName, contentLength, body);
  }

  private async storeFile(
    session: {
      id: string;
      formId: string;
      versionId: string;
      uploadedBytes: number;
      expiresAt: Date;
    },
    questionId: string | undefined,
    rawName: string | undefined,
    contentLength: number | undefined,
    body: Readable,
  ): Promise<UploadedFileDto> {
    if (!questionId || !UUID_RE.test(questionId)) {
      throw Errors.validation([{ field: 'questionId', message: 'السؤال غير صالح.' }]);
    }
    const question = await this.prisma.formVersionQuestion.findFirst({
      where: { id: questionId.toLowerCase(), versionId: session.versionId, type: 'FILE_UPLOAD' },
      select: { id: true, settings: true },
    });
    if (!question) {
      throw Errors.validation([{ field: 'questionId', message: 'هذا السؤال لا يقبل ملفات.' }]);
    }
    const settings = fileSettings(question.settings);
    const name = sanitizeFileName(rawName);
    const allowedExt = settings.allowedTypes.flatMap((k) => EXT_BY_KEY[k] ?? []);
    if (!allowedExt.includes(extensionOf(name))) {
      throw err(HttpStatus.BAD_REQUEST, 'FILE_REJECTED', 'نوع الملف غير مسموح في هذا السؤال.');
    }
    const maxBytes = settings.maxFileSizeMb * MB;
    const sessionRemaining = this.env.UPLOAD_SESSION_MAX_MB * MB - session.uploadedBytes;
    if (contentLength !== undefined && contentLength > maxBytes) throw this.tooLarge(settings);
    if (contentLength !== undefined && contentLength > sessionRemaining) throw this.sessionFull();
    await this.assertCapacity(this.prisma, session.id, question.id, settings, contentLength ?? 0);

    let temp: TempFile | null = null;
    let key: string | null = null;
    try {
      try {
        temp = await this.storage.writeTemp(body, Math.min(maxBytes, sessionRemaining));
      } catch (error) {
        if (error instanceof TooLarge) {
          throw maxBytes <= sessionRemaining ? this.tooLarge(settings) : this.sessionFull();
        }
        throw err(
          HttpStatus.BAD_REQUEST,
          'UPLOAD_INTERRUPTED',
          'انقطع رفع الملف قبل اكتماله. أعد المحاولة.',
        );
      }
      let kind: FileKind;
      try {
        kind = await inspectFile(temp.path, temp.size, name, settings.allowedTypes);
      } catch (error) {
        throw err(
          HttpStatus.BAD_REQUEST,
          'FILE_REJECTED',
          error instanceof FileRejected ? error.message : 'تعذر التحقق من الملف؛ لم يُقبل.',
        );
      }
      // الحد الأكبر للفيديو فقط؛ الصور والمستندات تبقى ضمن الحد العام حتى لو سمح السؤال بالفيديو
      if (!VIDEO_KINDS.has(kind) && temp.size > QUESTION_LIMITS.fileMaxSizeMb * MB) {
        throw err(
          HttpStatus.PAYLOAD_TOO_LARGE,
          'FILE_TOO_LARGE',
          `حجم الملف يتجاوز الحد المسموح لغير الفيديو (${QUESTION_LIMITS.fileMaxSizeMb} ميغابايت).`,
        );
      }
      let scan;
      try {
        scan = await this.scanner.scanFile(temp.path);
      } catch (error) {
        if (!(error instanceof ScanUnavailable)) throw error;
        this.logger.warn(`scanner unavailable: ${error.message}`);
        throw err(
          HttpStatus.SERVICE_UNAVAILABLE,
          'SCAN_UNAVAILABLE',
          'تعذر فحص الملف الآن، فلم يُقبل. أعد المحاولة بعد قليل.',
        );
      }
      if (!scan.clean) {
        this.logger.warn(`file rejected by scanner: ${scan.signature}`);
        throw err(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'FILE_INFECTED',
          'رُفض الملف لأن الفحص اكتشف محتوى ضارًا.',
        );
      }
      const { size, sha256 } = temp;
      key = await this.storage.commit(temp);
      temp = null;
      const storageKey = key;
      const created = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM fill_sessions WHERE id = ${session.id} FOR UPDATE`;
        const fresh = await tx.fillSession.findUniqueOrThrow({ where: { id: session.id } });
        if (fresh.uploadedBytes + size > this.env.UPLOAD_SESSION_MAX_MB * MB) {
          throw this.sessionFull();
        }
        await this.assertCapacity(tx, session.id, question.id, settings, size);
        await tx.fillSession.update({
          where: { id: session.id },
          data: { uploadedBytes: { increment: size }, uploadCount: { increment: 1 } },
        });
        return tx.uploadedFile.create({
          data: {
            fillSessionId: session.id,
            formId: session.formId,
            versionId: session.versionId,
            questionId: question.id,
            storageKey,
            originalName: name,
            sizeBytes: size,
            kind,
            sha256,
            scanEngine: scan.engine,
            scannedAt: new Date(),
            expiresAt: session.expiresAt,
          },
          select: { id: true, originalName: true, sizeBytes: true, kind: true },
        });
      });
      return {
        id: created.id,
        name: created.originalName,
        size: created.sizeBytes,
        kind: created.kind,
      };
    } catch (error) {
      if (key) await this.storage.remove(key).catch(() => undefined);
      throw error;
    } finally {
      if (temp) await this.storage.removeTemp(temp).catch(() => undefined);
    }
  }

  /** إزالة ملف لم يُرسل بعد، من الجلسة نفسها فقط. */
  async removeFile(publicId: string, token: string | undefined, fileId: string): Promise<void> {
    this.assertEnabled();
    const session = await this.session(publicId, token);
    const notFound = Errors.notFound('الملف غير موجود.');
    if (!UUID_RE.test(fileId)) throw notFound;
    const file = await this.prisma.uploadedFile.findFirst({
      where: { id: fileId.toLowerCase(), fillSessionId: session.id, responseId: null },
      select: { id: true, storageKey: true, sizeBytes: true },
    });
    if (!file) throw notFound;
    const deleted = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.uploadedFile.deleteMany({
        where: { id: file.id, responseId: null },
      });
      if (count) {
        await tx.fillSession.update({
          where: { id: session.id },
          data: { uploadedBytes: { decrement: file.sizeBytes } },
        });
      }
      return count;
    });
    if (!deleted) throw notFound;
    await this.storage.remove(file.storageKey).catch(() => undefined);
  }

  /**
   * داخل معاملة الإرسال: يقفل الملفات المذكورة ويتحقق أن كلًا منها من الجلسة نفسها والنموذج والإصدار
   * والسؤال، ولم يُربط برد، ولم تنتهِ صلاحيته. القفل يمنع التنظيف من حذفها أثناء الربط.
   */
  async lockForSubmit(
    tx: Prisma.TransactionClient,
    token: string | undefined,
    formId: string,
    versionId: string,
    answers: FileAnswerInput[],
  ): Promise<void> {
    const ids = answers.flatMap((a) => a.fileIds);
    if (!ids.length) return;
    this.assertEnabled();
    const invalid = (questionId: string): FieldError => ({
      field: `answers.${questionId}`,
      message: 'أحد الملفات غير صالح أو انتهت صلاحيته؛ أزله وأعد رفعه.',
    });
    const session =
      token && TOKEN_RE.test(token)
        ? await tx.fillSession.findUnique({ where: { tokenHash: hashFillToken(token) } })
        : null;
    // جلسات تعديل الإدارة (responseId) لا تصلح للإرسال العام
    if (
      !session ||
      session.responseId ||
      session.formId !== formId ||
      session.versionId !== versionId
    ) {
      throw Errors.validation(
        answers.filter((a) => a.fileIds.length).map((a) => invalid(a.questionId)),
      );
    }
    const rows = await tx.$queryRaw<
      {
        id: string;
        fill_session_id: string | null;
        form_id: string;
        version_id: string;
        question_id: string;
        response_id: string | null;
        expires_at: Date;
      }[]
    >`SELECT id, fill_session_id, form_id, version_id, question_id, response_id, expires_at
      FROM uploaded_files WHERE id IN (${Prisma.join(ids)}) FOR UPDATE`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const now = new Date();
    const errors: FieldError[] = [];
    for (const a of answers) {
      const ok = a.fileIds.every((id) => {
        const r = byId.get(id);
        return (
          r &&
          r.fill_session_id === session.id &&
          r.form_id === formId &&
          r.version_id === versionId &&
          r.question_id === a.questionId &&
          r.response_id === null &&
          r.expires_at > now
        );
      });
      if (!ok) errors.push(invalid(a.questionId));
    }
    if (errors.length) throw Errors.validation(errors);
  }

  /** يربط الملفات المقفلة بالرد وإجاباتها داخل معاملة الإرسال نفسها. */
  async attach(
    tx: Prisma.TransactionClient,
    responseId: string,
    answers: FileAnswerInput[],
  ): Promise<void> {
    const withFiles = answers.filter((a) => a.fileIds.length);
    if (!withFiles.length) return;
    const answerRows = await tx.formAnswer.findMany({
      where: { responseId, questionId: { in: withFiles.map((a) => a.questionId) } },
      select: { id: true, questionId: true },
    });
    const now = new Date();
    for (const a of withFiles) {
      const answer = answerRows.find((r) => r.questionId === a.questionId)!;
      const { count } = await tx.uploadedFile.updateMany({
        where: { id: { in: a.fileIds }, responseId: null },
        data: { responseId, answerId: answer.id, attachedAt: now },
      });
      if (count !== a.fileIds.length) {
        throw Errors.validation([
          { field: `answers.${a.questionId}`, message: 'تعذر ربط أحد الملفات؛ أعد رفعه.' },
        ]);
      }
    }
  }

  /**
   * التنظيف: ملفات هذا النظام غير المرتبطة برد والمنتهية فقط، ثم الجلسات المنتهية، ثم الأجزاء المؤقتة
   * المقطوعة. الحذف من القاعدة بشرط response_id IS NULL أولًا (ينتظر قفل أي إرسال جارٍ)، ثم من التخزين.
   */
  async cleanup(now = new Date()): Promise<{ files: number; sessions: number; partials: number }> {
    let files = 0;
    for (;;) {
      const batch = await this.prisma.uploadedFile.findMany({
        where: { responseId: null, expiresAt: { lt: now } },
        select: { id: true, storageKey: true },
        take: 100,
      });
      if (!batch.length) break;
      for (const f of batch) {
        const { count } = await this.prisma.uploadedFile.deleteMany({
          where: { id: f.id, responseId: null, expiresAt: { lt: now } },
        });
        if (count) {
          await this.storage.remove(f.storageKey).catch(() => undefined);
          files++;
        }
      }
      if (batch.length < 100) break;
    }
    const { count: sessions } = await this.prisma.fillSession.deleteMany({
      where: { expiresAt: { lt: now }, files: { none: { responseId: null } } },
    });
    const partials = await this.storage.removeStaleTemp(60 * 60 * 1000);
    return { files, sessions, partials };
  }
}
