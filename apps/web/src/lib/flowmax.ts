/** أنواع تكامل Flowmax في الواجهة ونص المشاركة (مطابقة لـ apps/api/src/integrations/flowmax). */

export type FlowmaxSyncStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';
export type FlowmaxOperation = 'OFFER' | 'REQUEST';

/** بيانات المشاركة الآمنة: لا تحتوي اسم المالك ولا جواله ولا أي ملاحظات داخلية. */
export interface FlowmaxShare {
  title: string;
  /** وصف العقار كما أُرسل إلى Flowmax (يظهر فوق الرابط). */
  description?: string | null;
  operation: FlowmaxOperation;
  purpose: string | null;
  category: string | null;
  city: string | null;
  district: string | null;
  priceSar: string | null;
  /** حقول عامة إضافية (اختيارية في السجلات القديمة). */
  areaSqm?: number | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  kitchens?: number | null;
}

export type FlowmaxPublishState = 'NONE' | 'REQUESTED' | 'PUBLISHED' | 'FAILED';
export type FlowmaxMediaStatus = 'PENDING' | 'SENT' | 'FAILED' | 'EXCLUDED';

export interface FlowmaxMedia {
  fileId: string;
  role: 'image' | 'video';
  status: FlowmaxMediaStatus;
  error: string | null;
  excludedReason: string | null;
}

export interface FlowmaxSync {
  status: FlowmaxSyncStatus;
  operation: FlowmaxOperation;
  flowmaxId: string | null;
  flowmaxRef: string | null;
  /** رابط التفاصيل كما أعاده Flowmax؛ لا يعني أنه منشور. */
  detailUrl: string | null;
  remoteStatus: string | null;
  isPublic: boolean;
  publishState: FlowmaxPublishState;
  publishError: string | null;
  sentAt: string | null;
  approvedAt: string;
  lastError: string | null;
  attempts: number;
  media: FlowmaxMedia[];
  /** بعد تأكيد Flowmax أن السجل منشور وظاهر فقط. */
  share: FlowmaxShare | null;
}

export interface IncompatibleMedia {
  fileId: string;
  name: string;
  reason: string;
}

export interface FlowmaxState {
  integrationEnabled: boolean;
  mappingEnabled: boolean;
  sync: FlowmaxSync | null;
  precheck: {
    problems: { field: string; message: string }[];
    incompatibleMedia: IncompatibleMedia[];
    /** ملاحظات لا تمنع الاعتماد. */
    notices?: string[];
  } | null;
  /** الرد مرفوض: لا يُرسل ولا يُعرض رابطه أو مشاركته. */
  rejected?: boolean;
  /** رقم مراجعة تعديلات الرد؛ يُرسل مع الاعتماد. */
  editRevision?: number;
}

/** أقصى طول للوصف في نص المشاركة (الوصف الكامل في صفحة Flowmax). */
export const SHARE_DESCRIPTION_MAX = 300;

export function shortDescription(text: string | null | undefined): string | null {
  const t = text?.trim();
  if (!t) return null;
  return t.length > SHARE_DESCRIPTION_MAX
    ? `${t.slice(0, SHARE_DESCRIPTION_MAX - 1).trimEnd()}…`
    : t;
}

export const MEDIA_STATUS_LABELS: Record<FlowmaxMediaStatus, string> = {
  PENDING: 'بانتظار النقل',
  SENT: 'نُقل',
  FAILED: 'فشل النقل',
  EXCLUDED: 'مستبعد',
};

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
 * نص المشاركة: العنوان، نوع العرض/الطلب، المدينة والحي، السعر، المواصفات، ثم وصف العقار فوق الرابط.
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
    specsText(share),
    shortDescription(share.description),
    url,
  ]
    .filter(Boolean)
    .join('\n');
}

/** المساحة والغرف والحمامات والمطابخ في سطر واحد، مثل «المساحة: 145.5 م² · الغرف: 3 · الحمامات: 2». */
export function specsText(share: FlowmaxShare): string {
  return [
    share.areaSqm != null && `المساحة: ${share.areaSqm} م²`,
    share.bedrooms != null && `الغرف: ${share.bedrooms}`,
    share.bathrooms != null && `الحمامات: ${share.bathrooms}`,
    share.kitchens != null && `المطابخ: ${share.kitchens}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** رابط مشاركة واتساب: النص كله مرمّز بـ encodeURIComponent (لا بيانات خاصة فيه). */
export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
