import { ApiError, toApiError } from './api';
import type { QuestionType } from './question-limits';
import type { PageMeta } from './types';

/** أنواع مطابقة لـ /api/forms/:id/responses (انظر docs/api.md). */
export type ResponseStatus = 'NEW' | 'IN_REVIEW' | 'ACCEPTED' | 'REJECTED';

export const RESPONSE_STATUSES: ResponseStatus[] = ['NEW', 'IN_REVIEW', 'ACCEPTED', 'REJECTED'];

export const RESPONSE_STATUS_LABELS: Record<ResponseStatus, string> = {
  NEW: 'جديد',
  IN_REVIEW: 'قيد المراجعة',
  ACCEPTED: 'مقبول',
  REJECTED: 'مرفوض',
};

export const RESPONSE_STATUS_TONES: Record<
  ResponseStatus,
  'velvet' | 'warning' | 'success' | 'muted'
> = {
  NEW: 'velvet',
  IN_REVIEW: 'warning',
  ACCEPTED: 'success',
  REJECTED: 'muted',
};

export interface ResponseListItem {
  id: string;
  referenceCode: string;
  submittedAt: string;
  status: ResponseStatus;
  versionNumber: number;
}

export interface ResponseList {
  items: ResponseListItem[];
  meta: PageMeta;
}

export type AnswerKind = 'empty' | 'text' | 'number' | 'date' | 'choice' | 'files';

export interface AnswerFile {
  id: string;
  name: string;
  size: number;
  kind: string;
}

export interface AnswerView {
  questionId: string;
  position: number;
  type: QuestionType;
  title: string;
  description: string | null;
  required: boolean;
  kind: AnswerKind;
  value?: string;
  options?: { label: string; selected: boolean }[];
  files?: AnswerFile[];
}

export interface StatusChange {
  fromStatus: ResponseStatus;
  toStatus: ResponseStatus;
  changedBy: string | null;
  changedAt: string;
}

export interface ResponseDetail {
  id: string;
  referenceCode: string;
  submittedAt: string;
  status: ResponseStatus;
  formId: string;
  formTitle: string;
  version: {
    versionNumber: number;
    title: string;
    description: string | null;
    publishedAt: string;
  };
  answers: AnswerView[];
  statusHistory: StatusChange[];
}

export interface ResponseFilters {
  search: string;
  status: ResponseStatus | '';
  from: string;
  to: string;
  version: string;
  sort: 'newest' | 'oldest';
  page: number;
}

export const EMPTY_FILTERS: ResponseFilters = {
  search: '',
  status: '',
  from: '',
  to: '',
  version: '',
  sort: 'newest',
  page: 1,
};

export const PAGE_SIZE = 20;

/** يقرأ الفلاتر من رابط الصفحة، ويتجاهل القيم غير الصالحة بدل إرسالها للخادم. */
export function filtersFromParams(params: URLSearchParams): ResponseFilters {
  const status = params.get('status') ?? '';
  const page = Number(params.get('page') ?? '1');
  const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const version = params.get('version') ?? '';
  return {
    search: (params.get('search') ?? '').slice(0, 20),
    status: (RESPONSE_STATUSES as string[]).includes(status) ? (status as ResponseStatus) : '',
    from: date(params.get('from')),
    to: date(params.get('to')),
    version: /^[1-9]\d{0,5}$/.test(version) ? version : '',
    sort: params.get('sort') === 'oldest' ? 'oldest' : 'newest',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

/** معاملات الاستعلام (للرابط وللـ API). القيم الافتراضية لا تُكتب. */
export function filtersToQuery(f: ResponseFilters, opts: { paging?: boolean } = {}): string {
  const q = new URLSearchParams();
  const search = f.search.trim();
  if (search) q.set('search', search);
  if (f.status) q.set('status', f.status);
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  if (f.version) q.set('version', f.version);
  if (f.sort !== 'newest') q.set('sort', f.sort);
  if (opts.paging !== false) {
    if (f.page > 1) q.set('page', String(f.page));
  }
  return q.toString();
}

export function hasActiveFilters(f: ResponseFilters): boolean {
  return Boolean(f.search.trim() || f.status || f.from || f.to || f.version);
}

/** يتحقق محليًا قبل الطلب (الخادم يتحقق دائمًا). */
export function filterErrors(f: ResponseFilters): Partial<Record<keyof ResponseFilters, string>> {
  const errors: Partial<Record<keyof ResponseFilters, string>> = {};
  if (f.search && !/^[0-9A-Za-z\- ]*$/.test(f.search)) {
    errors.search = 'ابحث بالرقم المرجعي: حروف لاتينية وأرقام فقط.';
  }
  if (f.from && f.to && f.from > f.to) {
    errors.to = 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية أو مساويًا له.';
  }
  return errors;
}

/**
 * ينزّل CSV عبر fetch (لا رابط مباشر) حتى تظهر أخطاء الخادم برسالة عربية بدل تنزيل ملف خطأ.
 * الجلسة في Cookie؛ طلب GET لا يحتاج CSRF.
 */
export async function downloadResponsesCsv(
  formId: string,
  filters: ResponseFilters,
): Promise<number> {
  const query = filtersToQuery(filters, { paging: false });
  let res: Response;
  try {
    res = await fetch(`/api/forms/${formId}/responses/export${query ? `?${query}` : ''}`, {
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
  if (!res.ok) throw toApiError(res.status, await res.json().catch(() => null));
  const blob = await res.blob();
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'responses.csv';
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
  return Number(res.headers.get('x-export-rows') ?? '0');
}

/** عدد الردود بصيغة عربية صحيحة: رد واحد، ردّان، 3–10 ردود، 11 فأكثر ردًا. */
export function responsesCount(n: number, format: (v: number) => string = String): string {
  if (n === 0) return 'لا توجد ردود';
  if (n === 1) return 'رد واحد';
  if (n === 2) return 'ردّان';
  const mod = n % 100;
  return `${format(n)} ${mod >= 3 && mod <= 10 ? 'ردود' : 'ردًا'}`;
}
