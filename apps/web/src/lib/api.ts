import type { ApiErrorBody, FieldError } from './types';

export const CSRF_COOKIE = 'lp_csrf';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: FieldError[] = [],
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** أخطاء الحقول كخريطة field -> message لعرضها بجانب كل حقل. */
  fieldMap(): Record<string, string> {
    return Object.fromEntries(this.fields.map((f) => [f.field, f.message]));
  }
}

export function toApiError(status: number, body: unknown): ApiError {
  if (body && typeof body === 'object' && 'code' in body && 'message' in body) {
    const b = body as ApiErrorBody;
    return new ApiError(status, b.code, b.message, b.fields ?? [], b.details ?? {});
  }
  if (status >= 500 || status === 0) {
    return new ApiError(
      status,
      'SERVICE_UNAVAILABLE',
      'الخدمة غير متاحة حاليًا. حاول مرة أخرى بعد قليل.',
    );
  }
  return new ApiError(status, 'HTTP_ERROR', 'تعذر إكمال الطلب.');
}

export function readCookie(name: string, cookieString: string): string | null {
  for (const part of cookieString.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

let unauthenticatedHandler: (() => void) | null = null;

/** يُستدعى عند انتهاء الجلسة (401) في أي طلب، لإعادة التوجيه إلى صفحة الدخول. */
export function onUnauthenticated(handler: (() => void) | null): void {
  unauthenticatedHandler = handler;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * يرسل الطلب إلى /api على نفس الأصل (Next.js يمرره إلى NestJS).
 * Cookie الجلسة HttpOnly ويرسلها المتصفح تلقائيًا؛ رمز CSRF يُقرأ من Cookie lp_csrf
 * ويُرسل في الترويسة للطلبات المعدِّلة. لا يُخزَّن أي رمز في localStorage.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie(CSRF_COOKIE, document.cookie);
    if (csrf) headers['x-csrf-token'] = csrf;
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.',
    );
  }

  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = toApiError(res.status, data);
    if (res.status === 401 && path !== '/auth/login' && unauthenticatedHandler) {
      unauthenticatedHandler();
    }
    throw error;
  }
  return data as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'حدث خطأ غير متوقع. حاول مرة أخرى.';
}
