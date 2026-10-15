/**
 * حقول Flowmax التي يمكن ربطها بإجابات النموذج، وفق عقد Flowmax:
 * - العرض ⇒ مسودة عقار: POST /api/admin/properties (backend/docs/api/property-listing-fields.md)
 * - الطلب ⇒ طلب عقار: POST /api/admin/property-demands (backend/docs/property-demand-marketplace-api.md)
 * المبالغ تُدخل في النموذج بالريال وتُرسل إلى Flowmax بالهللة.
 */

export type FieldType =
  'text' | 'integer' | 'decimal' | 'money' | 'enum' | 'date' | 'phone' | 'files' | 'consent';
export type Operation = 'OFFER' | 'REQUEST';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** العمليات التي يُستخدم فيها الحقل. */
  operations: Operation[];
  /** العمليات التي يكون فيها مطلوبًا لإنشاء السجل في Flowmax. */
  requiredFor: Operation[];
  /** بيانات خاصة: تُرسل لحقول Flowmax الإدارية فقط، ولا تدخل نص المشاركة أبدًا. */
  private?: boolean;
  /** القيم المقبولة في Flowmax مع تسمياتها العربية (للحقول من نوع enum). */
  values?: Record<string, string>;
  hint?: string;
}

export const OPERATION_VALUES: Record<string, string> = { offer: 'عرض', request: 'طلب' };

export const PROPERTY_CATEGORIES: Record<string, string> = {
  apartment: 'شقة',
  villa: 'فيلا',
  duplex: 'دوبلكس',
  studio: 'استوديو',
  traditional_house: 'بيت شعبي',
  palace: 'قصر',
  residential_land: 'أرض سكنية',
  commercial_land: 'أرض تجارية',
  office: 'مكتب',
  shop: 'محل',
  building: 'عمارة',
  warehouse: 'مستودع',
  hotel: 'فندق',
  chalet: 'شاليه',
  farm: 'مزرعة',
};

export const LISTING_PURPOSES: Record<string, string> = {
  sale: 'بيع',
  rent: 'إيجار',
  investment: 'استثمار',
  daily_rental: 'إيجار يومي',
};

export const TYPE_LETTERS: Record<string, string> = {
  M: 'M',
  T: 'T',
  H: 'H',
  B: 'B',
  SH: 'SH',
  TH: 'TH',
  J: 'J',
};

const BOTH: Operation[] = ['OFFER', 'REQUEST'];
const OFFER: Operation[] = ['OFFER'];
const REQUEST: Operation[] = ['REQUEST'];

export const FLOWMAX_FIELDS: readonly FieldDef[] = [
  {
    key: 'operation',
    label: 'نوع العملية (عرض أو طلب)',
    type: 'enum',
    operations: BOTH,
    requiredFor: BOTH,
    values: OPERATION_VALUES,
    hint: 'العرض يُنشئ مسودة عقار، والطلب يُنشئ طلب عقار.',
  },
  { key: 'title_ar', label: 'عنوان العقار', type: 'text', operations: BOTH, requiredFor: OFFER },
  { key: 'description_ar', label: 'الوصف', type: 'text', operations: OFFER, requiredFor: OFFER },
  {
    key: 'property_category',
    label: 'نوع العقار',
    type: 'enum',
    operations: BOTH,
    requiredFor: REQUEST,
    values: PROPERTY_CATEGORIES,
  },
  {
    key: 'listing_purpose',
    label: 'الغرض (بيع، إيجار، استثمار، إيجار يومي)',
    type: 'enum',
    operations: BOTH,
    requiredFor: REQUEST,
    values: LISTING_PURPOSES,
  },
  { key: 'city', label: 'المدينة', type: 'text', operations: BOTH, requiredFor: BOTH },
  { key: 'district', label: 'الحي', type: 'text', operations: BOTH, requiredFor: OFFER },
  {
    key: 'price',
    label: 'السعر أو الميزانية (ريال)',
    type: 'money',
    operations: BOTH,
    requiredFor: BOTH,
    hint: 'يُحوَّل إلى هللة. للإيجار اليومي يُرسل سعرًا لليلة.',
  },
  { key: 'area_sqm', label: 'المساحة (م²)', type: 'decimal', operations: BOTH, requiredFor: [] },
  { key: 'bedrooms_count', label: 'عدد الغرف', type: 'integer', operations: BOTH, requiredFor: [] },
  {
    key: 'bathrooms_count',
    label: 'عدد دورات المياه',
    type: 'integer',
    operations: BOTH,
    requiredFor: [],
  },
  {
    key: 'type_letter',
    label: 'رمز تصنيف Flowmax (M، T، H، B، SH، TH، J)',
    type: 'enum',
    operations: OFFER,
    requiredFor: OFFER,
    values: TYPE_LETTERS,
    hint: 'يستخدمه Flowmax لتوليد كود العقار؛ عادة قيمة ثابتة.',
  },
  {
    key: 'mediation_contract_number',
    label: 'رقم عقد الوساطة',
    type: 'text',
    operations: OFFER,
    requiredFor: OFFER,
  },
  {
    key: 'contract_date',
    label: 'تاريخ عقد الوساطة',
    type: 'date',
    operations: OFFER,
    requiredFor: OFFER,
    hint: 'يُرسل يومه وشهره (contract_day وcontract_month).',
  },
  {
    key: 'fal_license_number',
    label: 'رقم رخصة فال',
    type: 'text',
    operations: OFFER,
    requiredFor: OFFER,
  },
  {
    key: 'contact_name',
    label: 'اسم المالك أو مقدم الطلب',
    type: 'text',
    operations: BOTH,
    requiredFor: [],
    private: true,
    hint: 'خاص: لا يظهر في رابط المشاركة.',
  },
  {
    key: 'contact_phone',
    label: 'جوال التواصل',
    type: 'phone',
    operations: BOTH,
    requiredFor: REQUEST,
    private: true,
    hint: 'خاص: يُرسل لحقول Flowmax الإدارية فقط ولا يظهر في رابط المشاركة.',
  },
  { key: 'images', label: 'الصور', type: 'files', operations: OFFER, requiredFor: [] },
  { key: 'videos', label: 'الفيديوهات', type: 'files', operations: OFFER, requiredFor: [] },
  {
    key: 'consent',
    label: 'موافقة مقدم الطلب على المشاركة',
    type: 'consent',
    operations: REQUEST,
    requiredFor: REQUEST,
    private: true,
    hint: 'سؤال يوافق فيه المرسل؛ يُرسل إلى Flowmax دليل الموافقة برقم الرد المرجعي.',
  },
  {
    key: 'consent_version',
    label: 'إصدار نص الموافقة',
    type: 'text',
    operations: REQUEST,
    requiredFor: REQUEST,
    hint: 'عادة قيمة ثابتة مثل 2026-10.',
  },
];

/** حقول قديمة لم تعد تُربط من النموذج (developer_id يأتي من FLOWMAX_DEVELOPER_ID)؛ تُتجاهل إن وُجدت في ربط محفوظ. */
export const RETIRED_FIELDS: ReadonlySet<string> = new Set(['developer_id']);

export const FIELD_BY_KEY: ReadonlyMap<string, FieldDef> = new Map(
  FLOWMAX_FIELDS.map((f) => [f.key, f]),
);

/** مرادفات عربية شائعة لقيم الاختيار (تُطابق بعد التطبيع). جدول التحويل في الربط يسبقها. */
export const SYNONYMS: Record<string, Record<string, string>> = {
  operation: { عرض: 'offer', 'عرض عقار': 'offer', طلب: 'request', 'طلب عقار': 'request' },
  property_category: {
    شقه: 'apartment',
    فيلا: 'villa',
    فله: 'villa',
    دوبلكس: 'duplex',
    استوديو: 'studio',
    ستوديو: 'studio',
    'بيت شعبي': 'traditional_house',
    'منزل شعبي': 'traditional_house',
    قصر: 'palace',
    'ارض سكنيه': 'residential_land',
    'ارض تجاريه': 'commercial_land',
    مكتب: 'office',
    محل: 'shop',
    عماره: 'building',
    مبني: 'building',
    مستودع: 'warehouse',
    فندق: 'hotel',
    شاليه: 'chalet',
    مزرعه: 'farm',
  },
  listing_purpose: {
    بيع: 'sale',
    ايجار: 'rent',
    تاجير: 'rent',
    استثمار: 'investment',
    'ايجار يومي': 'daily_rental',
  },
};

/** تطبيع عربي بسيط للمطابقة: حركات، تطويل، همزات الألف، الياء والتاء المربوطة، المسافات، الحالة. */
export function normalizeArabic(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
