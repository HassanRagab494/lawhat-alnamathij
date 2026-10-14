import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

/**
 * عميل HTTP مستقل لـ Flowmax: مهلة لكل طلب، رمز تكامل في الترويسة فقط، وأخطاء مختصرة لا تحمل
 * الرمز ولا محتوى الطلب أو الرد (قد يحتوي بيانات المالك). لا يُسجَّل أي جسم طلب.
 */

export type FlowmaxFailure = 'timeout' | 'network' | 'http' | 'invalid_response';

export class FlowmaxError extends Error {
  constructor(
    readonly failure: FlowmaxFailure,
    readonly status?: number,
    /** أسماء حقول التحقق المرفوضة فقط (دون القيم أو الرسائل). */
    readonly fields: string[] = [],
    /** رمز الخطأ من Flowmax (مثل validation_error أو integration_key_conflict). */
    readonly code?: string,
  ) {
    super(`flowmax ${failure}${status ? ` ${status}` : ''}`);
  }

  /** قد يكون الطلب نُفذ في Flowmax دون أن تصل النتيجة (مهلة/انقطاع/خطأ خادم). */
  get uncertain(): boolean {
    return (
      this.failure === 'timeout' ||
      this.failure === 'network' ||
      this.failure === 'invalid_response' ||
      (this.failure === 'http' && (this.status ?? 0) >= 500)
    );
  }

  /** وصف عربي مختصر آمن للحفظ والعرض. */
  describe(): string {
    if (this.failure === 'timeout') return 'انتهت مهلة الاتصال بـ Flowmax.';
    if (this.failure === 'network') return 'تعذر الاتصال بـ Flowmax.';
    if (this.failure === 'invalid_response') return 'رد غير متوقع من Flowmax.';
    const s = this.status ?? 0;
    if (s === 401 || s === 403) return `رفض Flowmax صلاحية حساب التكامل (${s}).`;
    if (s === 404) return 'المسار أو السجل غير موجود في Flowmax (404).';
    if (s === 409) return 'رفض Flowmax مفتاح التكامل لأنه استُخدم ببيانات مختلفة (409).';
    if (s === 422) {
      if (this.code && /publish/i.test(this.code) && this.fields.length) {
        return `متطلبات النشر في Flowmax غير مكتملة: ${this.fields.slice(0, 8).join('، ')}.`;
      }
      return this.fields.length
        ? `رفض Flowmax الحقول: ${this.fields.slice(0, 8).join('، ')}.`
        : 'رفض Flowmax البيانات (422).';
    }
    if (s === 429) return 'تجاوز حد الطلبات في Flowmax (429).';
    return `خطأ من Flowmax (${s}).`;
  }
}

export interface FlowmaxClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  mediaTimeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface MediaUpload {
  /** حقول نصية ترافق الملف (مثل media_key وkind). */
  fields: Record<string, string>;
  /** اسم آمن مولّد (لا يُرسل الاسم الأصلي للملف). */
  filename: string;
  mime: string;
  size: number;
  stream: Readable;
}

export class FlowmaxClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: FlowmaxClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.token}`,
      Accept: 'application/json',
      'User-Agent': 'lawhat-alnamathij-integration/1',
      ...extra,
    };
  }

  private async send(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      throw new FlowmaxError(
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
      );
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      // شكل أخطاء Flowmax: { error: { code, message, details } }؛ تُحفظ أسماء الحقول أو المتطلبات فقط
      const error = (json as { error?: { code?: unknown; details?: unknown } } | undefined)?.error;
      const details = error?.details as Record<string, unknown> | undefined;
      const missing = details?.missing;
      const keys =
        missing && typeof missing === 'object'
          ? Object.keys(missing)
          : details && typeof details === 'object'
            ? Object.keys(details)
            : [];
      const code = typeof error?.code === 'string' ? error.code.slice(0, 64) : undefined;
      throw new FlowmaxError('http', res.status, keys, code);
    }
    if (json === undefined) throw new FlowmaxError('invalid_response', res.status);
    return json;
  }

  /** طلب JSON؛ يعيد الحقل data من رد Flowmax. */
  async json<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const json = await this.send(
      path,
      {
        method,
        headers: this.headers({
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
          ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey }),
        }),
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      this.opts.timeoutMs,
    );
    const data = (json as { data?: unknown }).data;
    if (data === undefined) throw new FlowmaxError('invalid_response');
    return data as T;
  }

  /** رفع ملف وسائط multipart بالتدفق (دون تحميله كاملًا في الذاكرة). */
  async upload<T>(path: string, media: MediaUpload): Promise<T> {
    const boundary = `----lawha${randomBytes(12).toString('hex')}`;
    const text = Object.entries(media.fields)
      .map(
        ([name, value]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      )
      .join('');
    const head = Buffer.from(
      `${text}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${media.filename}"\r\n` +
        `Content-Type: ${media.mime}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const source = media.stream;
    async function* parts() {
      yield head;
      for await (const chunk of source) yield chunk as Buffer;
      yield tail;
    }
    try {
      const json = await this.send(
        path,
        {
          method: 'POST',
          headers: this.headers({
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(head.length + media.size + tail.length),
          }),
          body: Readable.from(parts()) as unknown as RequestInit['body'],
          duplex: 'half',
        } as RequestInit,
        this.opts.mediaTimeoutMs,
      );
      const data = (json as { data?: unknown }).data;
      if (data === undefined) throw new FlowmaxError('invalid_response');
      return data as T;
    } finally {
      source.destroy();
    }
  }
}
