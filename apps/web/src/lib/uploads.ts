import { ApiError, CSRF_COOKIE, readCookie, toApiError } from './api';
import {
  FILE_TYPE_LABELS,
  QUESTION_LIMITS,
  VIDEO_TYPE_KEYS,
  type FileTypeKey,
} from './question-limits';

/** حالة ملف في الصفحة العامة: لا يُعد جاهزًا للإرسال إلا بعد قبول الخادم. */
export type UploadStatus = 'uploading' | 'checking' | 'ready' | 'error';

export interface UploadItem {
  localId: string;
  name: string;
  size: number;
  status: UploadStatus;
  /** 0–100 أثناء الإرسال. */
  progress: number;
  /** معرّف الملف لدى الخادم بعد القبول. */
  fileId?: string;
  error?: string;
}

export const EXTENSIONS: Record<FileTypeKey, string[]> = {
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

const VIDEO_EXTENSIONS = VIDEO_TYPE_KEYS.flatMap((t) => EXTENSIONS[t]);

export function acceptAttribute(types: FileTypeKey[] | undefined): string {
  return (types ?? []).flatMap((t) => EXTENSIONS[t].map((e) => `.${e}`)).join(',');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} كيلوبايت`;
  return `${(bytes / 1024 / 1024).toFixed(1)} ميغابايت`;
}

/** فحص مبدئي في المتصفح (الخادم يتحقق دائمًا من المحتوى الفعلي والحجم). */
export function precheckFile(
  file: { name: string; size: number },
  settings: { allowedTypes?: FileTypeKey[]; maxFileSizeMb?: number },
): string | null {
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  const allowed = (settings.allowedTypes ?? []).flatMap((t) => EXTENSIONS[t]);
  if (!allowed.includes(ext)) {
    const labels = (settings.allowedTypes ?? []).map((t) => FILE_TYPE_LABELS[t]).join('، ');
    return `نوع الملف غير مسموح. الأنواع المسموحة: ${labels}.`;
  }
  if (file.size === 0) return 'الملف فارغ.';
  const max = (settings.maxFileSizeMb ?? 1) * 1024 * 1024;
  if (file.size > max) return `حجم الملف يتجاوز الحد المسموح (${settings.maxFileSizeMb} ميغابايت).`;
  // الحد الأكبر للفيديو فقط؛ الصور والمستندات تبقى ضمن الحد العام (كما في الخادم)
  if (!VIDEO_EXTENSIONS.includes(ext) && file.size > QUESTION_LIMITS.fileMaxSizeMb * 1024 * 1024) {
    return `حجم الملف يتجاوز الحد المسموح لغير الفيديو (${QUESTION_LIMITS.fileMaxSizeMb} ميغابايت).`;
  }
  return null;
}

export async function createFillSession(publicId: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`/api/public/forms/${encodeURIComponent(publicId)}/upload-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.',
    );
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw toApiError(res.status, data);
  return (data as { token: string }).token;
}

/**
 * يرفع الملف بالتدفق عبر XHR لعرض التقدم. onUploaded يُستدعى عند اكتمال الإرسال
 * (يبدأ الخادم التحقق قبل أن يرد).
 */
export function uploadFile(
  publicId: string,
  token: string,
  questionId: string,
  file: File,
  onProgress: (percent: number) => void,
  onUploaded: () => void,
): { promise: Promise<{ id: string; name: string; size: number }>; abort: () => void } {
  return sendFile(
    `/api/public/forms/${encodeURIComponent(publicId)}/files?questionId=${encodeURIComponent(questionId)}`,
    { 'x-fill-session': token },
    file,
    onProgress,
    onUploaded,
  );
}

/** رفع مرفق لتعديل رد قائم (لوحة الإدارة): جلسة المستخدم ورمز CSRF بدل جلسة التعبئة. */
export function uploadResponseFile(
  formId: string,
  responseId: string,
  questionId: string,
  file: File,
  onProgress: (percent: number) => void,
  onUploaded: () => void,
): { promise: Promise<{ id: string; name: string; size: number }>; abort: () => void } {
  const csrf = typeof document === 'undefined' ? null : readCookie(CSRF_COOKIE, document.cookie);
  return sendFile(
    `/api/forms/${encodeURIComponent(formId)}/responses/${encodeURIComponent(responseId)}/files?questionId=${encodeURIComponent(questionId)}`,
    csrf ? { 'x-csrf-token': csrf } : {},
    file,
    onProgress,
    onUploaded,
  );
}

function sendFile(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (percent: number) => void,
  onUploaded: () => void,
): { promise: Promise<{ id: string; name: string; size: number }>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ id: string; name: string; size: number }>((resolve, reject) => {
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.upload.onload = () => onUploaded();
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300)
        resolve(body as { id: string; name: string; size: number });
      else reject(toApiError(xhr.status, body));
    };
    xhr.onerror = () =>
      reject(new ApiError(0, 'NETWORK_ERROR', 'انقطع الاتصال أثناء رفع الملف. أعد المحاولة.'));
    xhr.onabort = () => reject(new ApiError(0, 'ABORTED', 'أُلغي رفع الملف.'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

export async function deleteUploadedFile(
  publicId: string,
  token: string,
  fileId: string,
): Promise<void> {
  try {
    await fetch(
      `/api/public/forms/${encodeURIComponent(publicId)}/files/${encodeURIComponent(fileId)}`,
      {
        method: 'DELETE',
        headers: { 'x-fill-session': token },
        credentials: 'same-origin',
      },
    );
  } catch {
    // الملف غير المرسل يُنظف تلقائيًا عند انتهاء الجلسة
  }
}
