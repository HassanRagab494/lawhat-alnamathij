/** أنواع ربط Flowmax في الواجهة ونص المشاركة (مطابقة لـ apps/api/src/integrations/flowmax). */

export type FlowmaxSyncStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';
export type FlowmaxOperation = 'OFFER' | 'REQUEST';

/** بيانات المشاركة الآمنة: لا تحتوي اسم المالك ولا جواله ولا أي ملاحظات داخلية. */
export interface FlowmaxShare {
  title: string;
  operation: FlowmaxOperation;
  purpose: string | null;
  category: string | null;
  city: string | null;
  district: string | null;
  priceSar: string | null;
}

export interface FlowmaxSync {
  status: FlowmaxSyncStatus;
  operation: FlowmaxOperation;
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
  share: FlowmaxShare | null;
}

export interface FlowmaxState {
  integrationEnabled: boolean;
  mappingEnabled: boolean;
  sync: FlowmaxSync | null;
}

export const SYNC_STATUS_LABELS: Record<FlowmaxSyncStatus, string> = {
  PENDING: 'بانتظار الإرسال',
  SENDING: 'جارٍ الإرسال',
  SENT: 'أُرسل',
  FAILED: 'فشل الإرسال',
};

export const SYNC_STATUS_TONES: Record<
  FlowmaxSyncStatus,
  'muted' | 'velvet' | 'success' | 'warning'
> = {
  PENDING: 'muted',
  SENDING: 'velvet',
  SENT: 'success',
  FAILED: 'warning',
};

export const OPERATION_LABELS: Record<FlowmaxOperation, string> = { OFFER: 'عرض', REQUEST: 'طلب' };

/** السعر بالريال بفواصل عربية، مثل «850,000 ريال». */
export function formatPriceSar(value: string): string {
  const [int, frac] = value.split('.');
  const grouped = (int ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}${frac && Number(frac) ? `.${frac}` : ''} ريال`;
}

/**
 * نص المشاركة: العنوان، نوع العرض/الطلب، المدينة والحي، السعر إن وجد، ثم الرابط.
 * يُبنى من بيانات المشاركة الآمنة فقط، فلا يدخله اسم المالك أو جواله.
 */
export function shareText(share: FlowmaxShare, url: string): string {
  const kind = [OPERATION_LABELS[share.operation], share.purpose, share.category]
    .filter(Boolean)
    .join(' — ');
  const place = [share.city, share.district].filter(Boolean).join(' — ');
  return [
    share.title,
    kind,
    place && `الموقع: ${place}`,
    share.priceSar &&
      `${share.operation === 'REQUEST' ? 'الميزانية' : 'السعر'}: ${formatPriceSar(share.priceSar)}`,
    url,
  ]
    .filter(Boolean)
    .join('\n');
}

/** رابط مشاركة واتساب: النص كله مرمّز بـ encodeURIComponent (لا بيانات خاصة فيه). */
export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/* ---------- إعداد الربط ---------- */

export interface FlowmaxFieldDef {
  key: string;
  label: string;
  type: 'text' | 'integer' | 'decimal' | 'money' | 'enum' | 'date' | 'phone' | 'files' | 'consent';
  operations: FlowmaxOperation[];
  requiredFor: FlowmaxOperation[];
  private?: boolean;
  values?: Record<string, string>;
  hint?: string;
}

export interface FieldSource {
  questionId?: string;
  constant?: string;
  values?: Record<string, string>;
}

export interface MappingView {
  integrationEnabled: boolean;
  enabled: boolean;
  config: { fields: Record<string, FieldSource> };
  fields: FlowmaxFieldDef[];
  questions: { id: string; title: string; type: string; options: string[] }[];
  updatedAt: string | null;
}

/** «قيمة الإجابة = قيمة Flowmax» سطرًا لكل تحويل ⇔ كائن. */
export function parseValueTable(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const from = line.slice(0, i).trim();
    const to = line.slice(i + 1).trim();
    if (from && to) out[from] = to;
  }
  return Object.keys(out).length ? out : undefined;
}

export function formatValueTable(values: Record<string, string> | undefined): string {
  return Object.entries(values ?? {})
    .map(([from, to]) => `${from} = ${to}`)
    .join('\n');
}
