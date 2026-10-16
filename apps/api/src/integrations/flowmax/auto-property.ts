import type { FileKind } from '@prisma/client';
import { LISTING_PURPOSES, PROPERTY_CATEGORIES, normalizeArabic, type Operation } from './fields';
import {
  normalizePhone,
  type AnswerInput,
  type BuildResult,
  type Problem,
  type ShareInfo,
} from './mapping';
import type { MediaCandidate } from './media';

/**
 * التعرّف التلقائي على بيانات العقار من عناوين أسئلة أي نموذج، دون أي إعداد من الأدمن.
 * العنوان يُطبَّع (حركات، همزات، ياء وتاء مربوطة، مسافات وشرطات ورموز) ويُطابق قاموس مرادفات؛
 * يُختار لكل سؤال الحقل الأدق (المطابقة التامة ثم أطول مرادف محتوى في العنوان).
 * القيم الثابتة (المطور الداخلي ورمز التصنيف ومرجع التفويض وتاريخه) من الخادم.
 */

export type AutoField =
  | 'title'
  | 'contact_name'
  | 'contact_role'
  | 'description'
  | 'location'
  | 'city'
  | 'district'
  | 'category'
  | 'operation'
  | 'purpose'
  | 'area'
  | 'price'
  | 'budget'
  | 'bedrooms'
  | 'bathrooms'
  | 'units'
  | 'phone'
  | 'media'
  | 'consent';

/** الاسم العربي لكل حقل كما يظهر في رسائل النقص. */
export const AUTO_FIELD_LABELS: Record<AutoField, string> = {
  title: 'عنوان العقار',
  contact_name: 'الاسم',
  contact_role: 'الصفة',
  description: 'وصف العقار',
  location: 'الموقع',
  city: 'المدينة',
  district: 'الحي',
  category: 'نوع العقار',
  operation: 'نوع العملية',
  purpose: 'الغرض',
  area: 'المساحة',
  price: 'السعر',
  budget: 'الميزانية',
  bedrooms: 'عدد الغرف',
  bathrooms: 'عدد الحمامات',
  units: 'عدد الوحدات',
  phone: 'رقم التواصل',
  media: 'الصور والفيديوهات',
  consent: 'الموافقة على مشاركة الطلب',
};

/** قاموس المرادفات الداخلي (يُطبَّع عند التحميل). */
const DICTIONARY: Record<AutoField, string[]> = {
  title: ['عنوان العقار', 'اسم العقار', 'عنوان الاعلان', 'العنوان', 'عنوان'],
  contact_name: [
    'الاسم',
    'اسمك',
    'الاسم الكامل',
    'الاسم الثلاثي',
    'اسم المالك',
    'اسم صاحب العقار',
    'صاحب العقار',
    'اسم مقدم الطلب',
    'اسم المعلن',
  ],
  contact_role: ['الصفة', 'صفتك', 'صفة مقدم الطلب', 'صفة المعلن', 'العلاقة بالعقار'],
  description: ['وصف العقار', 'الوصف', 'وصف', 'تفاصيل العقار', 'مواصفات العقار', 'المواصفات'],
  location: [
    'المدينة / الحي',
    'المدينة والحي',
    'الحي والمدينة',
    'موقع العقار',
    'الموقع',
    'العنوان التفصيلي',
  ],
  city: ['المدينة', 'مدينة العقار'],
  district: ['الحي', 'حي العقار', 'اسم الحي'],
  category: ['نوع العقار', 'تصنيف العقار', 'فئة العقار', 'نوع الوحدة'],
  operation: ['نوع العملية', 'نوع الطلب', 'العملية', 'نوع الاعلان', 'عرض او طلب'],
  purpose: ['الغرض', 'الغرض من العقار', 'للبيع او للايجار', 'هل العقار للبيع او للايجار'],
  area: ['المساحة', 'مساحة العقار', 'مساحة العقار بالمتر', 'المساحة بالمتر', 'المساحة م2', 'مساحه'],
  price: ['السعر', 'سعر العقار', 'السعر المطلوب', 'سعر البيع', 'قيمة الايجار', 'الايجار السنوي'],
  budget: ['الميزانية', 'الميزانية المتوقعة', 'الحد الاعلى للميزانية', 'الميزانية القصوى'],
  bedrooms: ['الغرف', 'عدد الغرف', 'غرف النوم', 'عدد غرف النوم'],
  bathrooms: ['الحمامات', 'عدد الحمامات', 'دورات المياه', 'عدد دورات المياه', 'دورة مياه'],
  units: ['عدد الوحدات', 'الوحدات', 'عدد الشقق'],
  phone: [
    'رقم التواصل',
    'وسيلة التواصل',
    'رقم الجوال',
    'الجوال',
    'رقم الهاتف',
    'الهاتف',
    'رقم الواتساب',
    'واتساب',
    'التواصل',
  ],
  media: [
    'الصور',
    'صور العقار',
    'الفيديو',
    'الفيديوهات',
    'فيديو العقار',
    'الصور والفيديوهات',
    'المرفقات',
    'الوسائط',
  ],
  consent: ['الموافقة', 'اوافق', 'الموافقة على التواصل', 'الموافقة على مشاركة الطلب', 'اقرار'],
};

const NORMALIZED: [AutoField, string][] = Object.entries(DICTIONARY).flatMap(([field, words]) =>
  words.map((w) => [field as AutoField, normalizeArabic(w)] as [AutoField, string]),
);

const FILE_FIELDS = new Set<AutoField>(['media']);

/** يحدد الحقل الأدق لعنوان سؤال واحد، أو null. */
export function detectField(title: string, isFile: boolean): AutoField | null {
  const n = normalizeArabic(title);
  if (!n) return null;
  let best: { field: AutoField; score: number } | null = null;
  for (const [field, word] of NORMALIZED) {
    if (isFile !== FILE_FIELDS.has(field)) continue;
    const score = n === word ? 1000 + word.length : n.includes(word) ? word.length : 0;
    if (score && (!best || score > best.score)) best = { field, score };
  }
  return best?.field ?? null;
}

/** نتيجة التعرّف: الأسئلة المرتبطة بكل حقل (الأول يُستخدم للقيم، وكل أسئلة الوسائط تُجمع). */
export type Detection = Partial<Record<AutoField, AnswerInput[]>>;

export function detectFields(answers: AnswerInput[]): Detection {
  const out: Detection = {};
  for (const a of answers) {
    let field = detectField(a.title, a.type === 'FILE_UPLOAD');
    // Some forms call both the property category and sale/rent question «نوع العقار».
    // Only exact, unambiguous selected operation labels can disambiguate that title.
    if (
      field === 'category' &&
      a.choices?.length &&
      a.choices.every((value) => {
        const normalized = normalizeArabic(value);
        return Boolean(OPERATION_VALUES[normalized]) && !CATEGORY_VALUES[normalized];
      })
    ) {
      field = 'operation';
    }
    if (field) (out[field] ??= []).push(a);
  }
  return out;
}

// ---------- القيم ----------

const OPERATION_VALUES: Record<string, Operation> = Object.fromEntries(
  [
    ['عرض', 'OFFER'],
    ['عرض عقار', 'OFFER'],
    ['بيع', 'OFFER'],
    ['للبيع', 'OFFER'],
    ['طلب بيع', 'OFFER'],
    ['ايجار', 'OFFER'],
    ['للايجار', 'OFFER'],
    ['تاجير', 'OFFER'],
    ['استثمار', 'OFFER'],
    ['ايجار يومي', 'OFFER'],
    ['طلب', 'REQUEST'],
    ['طلب عقار', 'REQUEST'],
    ['طلب شراء', 'REQUEST'],
    ['شراء', 'REQUEST'],
    ['طلب ايجار', 'REQUEST'],
    ['طلب استئجار', 'REQUEST'],
    ['استئجار', 'REQUEST'],
    ['طلب استثمار', 'REQUEST'],
  ].map(([k, v]) => [normalizeArabic(k!), v as Operation]),
);

const PURPOSE_VALUES: Record<string, string> = Object.fromEntries(
  [
    ['بيع', 'sale'],
    ['للبيع', 'sale'],
    ['طلب بيع', 'sale'],
    ['شراء', 'sale'],
    ['طلب شراء', 'sale'],
    ['ايجار', 'rent'],
    ['للايجار', 'rent'],
    ['تاجير', 'rent'],
    ['طلب ايجار', 'rent'],
    ['استئجار', 'rent'],
    ['طلب استئجار', 'rent'],
    ['استثمار', 'investment'],
    ['طلب استثمار', 'investment'],
    ['ايجار يومي', 'daily_rental'],
  ].map(([k, v]) => [normalizeArabic(k!), v!]),
);

const CATEGORY_VALUES: Record<string, string> = Object.fromEntries([
  ...Object.entries(PROPERTY_CATEGORIES).map(([v, label]) => [normalizeArabic(label), v]),
  ...[
    ['شقة', 'apartment'],
    ['شقه سكنيه', 'apartment'],
    ['فيلا', 'villa'],
    ['فله', 'villa'],
    ['دوبلكس', 'duplex'],
    ['دبلكس', 'duplex'],
    ['استوديو', 'studio'],
    ['ستوديو', 'studio'],
    ['بيت شعبي', 'traditional_house'],
    ['منزل شعبي', 'traditional_house'],
    ['بيت', 'traditional_house'],
    ['قصر', 'palace'],
    ['ارض', 'residential_land'],
    ['ارض سكنية', 'residential_land'],
    ['ارض تجارية', 'commercial_land'],
    ['مكتب', 'office'],
    ['محل', 'shop'],
    ['محل تجاري', 'shop'],
    ['عمارة', 'building'],
    ['عمارة سكنية', 'building'],
    ['مبنى', 'building'],
    ['مستودع', 'warehouse'],
    ['فندق', 'hotel'],
    ['شاليه', 'chalet'],
    ['استراحة', 'chalet'],
    ['مزرعة', 'farm'],
  ].map(([k, v]) => [normalizeArabic(k!), v!]),
]);

const TRUTHY = new Set(
  ['نعم', 'موافق', 'اوافق', 'موافقه', 'نعماوافق', 'yes', 'true', 'agree', '1'].map(normalizeArabic),
);

const toLatin = (raw: string) =>
  raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.');

/** نص الإجابة كما أدخلها المرسل (نص، رقم، تاريخ، أو الخيارات المختارة). */
function textOf(a: AnswerInput | undefined): string | null {
  if (!a) return null;
  if (a.text != null && a.text.trim()) return a.text.trim();
  if (a.number != null) return a.number;
  if (a.date != null) return a.date;
  if (a.choices?.length) return a.choices.join('، ');
  return null;
}

/** أول رقم في الإجابة (يقبل الأرقام العربية وفواصل الآلاف ووحدات مثل «م²» أو «ريال»). */
function numberOf(a: AnswerInput | undefined): number | null {
  const raw = textOf(a);
  if (raw == null) return null;
  const m = /\d[\d,٬]*(?:\.\d+)?/.exec(toLatin(raw).replace(/\s/g, ''));
  if (!m) return null;
  const v = Number(m[0].replace(/[,٬]/g, ''));
  return Number.isFinite(v) ? v : null;
}

function lookup(table: Record<string, string>, raw: string | null): string | null {
  if (!raw) return null;
  for (const part of [raw, ...raw.split(/[،,/|]/)]) {
    const v = table[normalizeArabic(part)];
    if (v) return v;
  }
  return null;
}

/** «الرياض / النرجس» أو «الرياض - حي النرجس» ⇒ [المدينة، الحي]. */
export function splitLocation(raw: string): [string | null, string | null] {
  const parts = raw
    .split(/\s*[/|،,\-–—]\s*|\s+حي\s+/)
    .map((p) => p.replace(/^حي\s+/, '').trim())
    .filter(Boolean);
  return [parts[0] ?? null, parts[1] ?? null];
}

/** رقم جوال من نص حر مثل «واتساب ٠٥٥١٢٣٤٥٦٧». */
export function extractPhone(raw: string | null): string | null {
  if (!raw) return null;
  const direct = normalizePhone(raw);
  if (direct) return direct;
  const m = /\+?\d[\d\s()-]{7,18}\d/.exec(toLatin(raw));
  return m ? normalizePhone(m[0]) : null;
}

const RESIDENTIAL = new Set([
  'apartment',
  'villa',
  'duplex',
  'studio',
  'traditional_house',
  'palace',
  'chalet',
]);

/** الحقول المطلوبة لإنشاء العرض حسب نوع العقار (إضافة إلى الأساسية). */
function requiredForCategory(category: string | null): AutoField[] {
  if (!category) return [];
  if (RESIDENTIAL.has(category)) return ['area', 'bedrooms'];
  if (category === 'building') return ['area', 'units'];
  return ['area'];
}

export interface AutoContext {
  referenceCode: string;
  submittedAt: Date;
  /** يوم الاعتماد: يُستخدم تاريخًا لمرجع التفويض في Flowmax. */
  approvedAt: Date;
  /** المطور الداخلي في Flowmax (FLOWMAX_DEVELOPER_ID). */
  developerId?: number;
}

/**
 * يحوّل رد أي نموذج إلى طلب Flowmax تلقائيًا. لا يتصل بالشبكة. كل حقل مطلوب ناقص يُعاد باسمه العربي.
 */
export function buildAutoRequest(answers: AnswerInput[], ctx: AutoContext): BuildResult {
  const d = detectFields(answers);
  const first = (f: AutoField) => d[f]?.[0];
  const problems: Problem[] = [];
  const missing = (f: AutoField, why = 'الإجابة مطلوبة') =>
    problems.push({ field: f, message: `«${AUTO_FIELD_LABELS[f]}»: ${why}.` });

  // نوع العملية والغرض من إجابة «نوع العملية» (أو «الغرض» إن لم يوجد)
  const opRaw = textOf(first('operation')) ?? textOf(first('purpose'));
  const operation = (lookup(OPERATION_VALUES, opRaw) as Operation | null) ?? null;
  const purpose = lookup(PURPOSE_VALUES, textOf(first('purpose'))) ?? lookup(PURPOSE_VALUES, opRaw);
  if (!operation) {
    missing(
      'operation',
      opRaw
        ? `القيمة «${opRaw}» غير معروفة (عرض، بيع، إيجار، استثمار، طلب شراء، طلب إيجار)`
        : 'الإجابة مطلوبة',
    );
    return { operation: null, body: {}, share: null, media: [], problems };
  }

  const categoryRaw = textOf(first('category'));
  const category = lookup(CATEGORY_VALUES, categoryRaw);
  if (categoryRaw && !category) missing('category', `القيمة «${categoryRaw}» غير معروفة`);

  let city = textOf(first('city'));
  let district = textOf(first('district'));
  const location = textOf(first('location'));
  if (location && (!city || !district)) {
    const [c, dist] = splitLocation(location);
    city ??= c;
    district ??= dist;
  }
  if (city && !district && /[/|،,\-]/.test(city)) [city, district] = splitLocation(city);

  const area = numberOf(first('area'));
  const priceValue = numberOf(first('price'));
  const budgetValue = numberOf(first('budget'));
  const amount = operation === 'OFFER' ? (priceValue ?? budgetValue) : (budgetValue ?? priceValue);
  const bedrooms = numberOf(first('bedrooms'));
  const bathrooms = numberOf(first('bathrooms'));
  const units = numberOf(first('units'));
  const phone = extractPhone(textOf(first('phone')));
  const phoneRaw = textOf(first('phone'));
  if (phoneRaw && !phone) missing('phone', 'رقم الجوال غير صالح');
  const name = textOf(first('contact_name'));
  const role = textOf(first('contact_role'));

  const categoryLabel = category ? PROPERTY_CATEGORIES[category]! : null;
  const purposeLabel = purpose ? LISTING_PURPOSES[purpose]! : null;
  const place = [city, district].filter(Boolean).join(' — ');
  const title =
    textOf(first('title')) ??
    ([
      categoryLabel ?? (operation === 'OFFER' ? 'عقار' : 'طلب عقار'),
      purposeLabel && `لل${purposeLabel}`,
      city && `في ${place}`,
    ]
      .filter(Boolean)
      .join(' ') ||
      null);
  const description =
    textOf(first('description')) ??
    [
      title,
      area != null && `المساحة ${area} م²`,
      bedrooms != null && `${bedrooms} غرف`,
      bathrooms != null && `${bathrooms} حمامات`,
      units != null && `${units} وحدات`,
    ]
      .filter(Boolean)
      .join('، ');

  // الحقول المطلوبة (الأساسية ثم حسب نوع العقار)
  const specs: Partial<Record<AutoField, number | null>> = { area, bedrooms, units };
  const required: [AutoField, unknown][] =
    operation === 'OFFER'
      ? [
          ['category', category],
          ['purpose', purpose],
          ['city', city],
          ['district', district],
          ['price', amount],
          ...requiredForCategory(category).map((f): [AutoField, unknown] => [f, specs[f]]),
        ]
      : [
          ['category', category],
          ['purpose', purpose],
          ['city', city],
          ['budget', amount],
          ['phone', phone],
        ];
  for (const [f, v] of required) {
    if ((v === null || v === undefined || v === '') && !problems.some((p) => p.field === f))
      missing(f);
  }
  if (amount != null && amount <= 0)
    missing(operation === 'OFFER' ? 'price' : 'budget', 'يجب أن يكون مبلغًا موجبًا');
  let consent = false;
  if (operation === 'REQUEST') {
    const c = textOf(first('consent'));
    consent = Boolean(c && c.split('، ').some((p) => TRUTHY.has(normalizeArabic(p))));
    if (!consent) missing('consent', c ? 'لم يوافق المرسل' : 'الإجابة مطلوبة');
  }
  if (operation === 'OFFER' && !ctx.developerId) {
    problems.push({
      field: 'developer_id',
      message: 'المطور الداخلي في Flowmax غير مضبوط على الخادم (FLOWMAX_DEVELOPER_ID).',
    });
  }

  // الوسائط: كل ملفات أسئلة الصور والفيديو، ويُحدد الدور من نوع الملف
  const media: MediaCandidate[] =
    operation === 'OFFER'
      ? (d.media ?? []).flatMap((a) =>
          (a.files ?? []).map((f) => ({
            fileId: f.id,
            name: f.name,
            kind: f.kind,
            size: f.size,
            role: VIDEO_KINDS.has(f.kind) ? ('video' as const) : ('image' as const),
          })),
        )
      : [];

  const halalas = amount != null ? Math.round(amount * 100) : undefined;
  const day = ctx.approvedAt.toLocaleDateString('en-GB', {
    timeZone: 'Asia/Riyadh',
    day: '2-digit',
  });
  const month = ctx.approvedAt.toLocaleDateString('en-GB', {
    timeZone: 'Asia/Riyadh',
    month: '2-digit',
  });
  const notes = [
    name && `الاسم: ${name}`,
    role && `الصفة: ${role}`,
    `رد لوحة النماذج ${ctx.referenceCode}`,
  ]
    .filter(Boolean)
    .join(' — ');

  let body: Record<string, unknown>;
  if (operation === 'OFFER') {
    body = {
      title_ar: title,
      description_ar: description,
      // قيم خادمة ثابتة: رمز التصنيف الافتراضي في Flowmax، والمطور الداخلي، ومرجع التفويض وتاريخه
      type_letter: 'M',
      developer_id: ctx.developerId,
      mediation_contract_number: `LAWHA-${ctx.referenceCode}`,
      contract_day: day,
      contract_month: month,
      property_category: category ?? undefined,
      listing_purpose: purpose ?? undefined,
      city,
      district,
      currency: 'SAR',
      ...(purpose === 'daily_rental'
        ? { original_nightly_price: halalas }
        : { requested_price: halalas }),
      area_sqm: area ?? undefined,
      bedrooms_count: bedrooms ?? undefined,
      bathrooms_count: bathrooms ?? undefined,
      units_count: units ?? undefined,
      contact_phone: phone ?? undefined,
      // اسم المالك وصفته في الملاحظات الإدارية فقط (لا تظهر في واجهات Flowmax العامة)
      listing_notes: notes,
    };
  } else {
    const criteria: Record<string, number> = {};
    if (area != null) criteria.area_sqm = area;
    if (bedrooms != null) criteria.bedrooms_count = bedrooms;
    if (bathrooms != null) criteria.bathrooms_count = bathrooms;
    if (units != null) criteria.units_count = units;
    body = {
      requester_name: name ?? undefined,
      requester_phone: phone,
      property_category: category,
      listing_purpose: purpose,
      city,
      district: district ?? undefined,
      budget_max_halalas: halalas,
      ...(purpose === 'daily_rental' && { budget_basis: 'stay_total' }),
      ...(Object.keys(criteria).length && { criteria }),
      consent_version: 'lawha-forms-1',
      intake_consent_evidence: `موافقة المرسل ضمن رد لوحة النماذج ${ctx.referenceCode} بتاريخ ${ctx.submittedAt.toISOString()}`,
    };
  }
  for (const k of Object.keys(body)) if (body[k] === undefined || body[k] === null) delete body[k];

  const share: ShareInfo = {
    title: title ?? 'عقار',
    operation,
    purpose: purposeLabel,
    category: categoryLabel,
    city,
    district,
    priceSar: amount != null ? String(amount) : null,
    areaSqm: area,
    bedrooms,
    bathrooms,
  };
  return { operation, body, share, media, problems };
}

const VIDEO_KINDS = new Set<FileKind>(['MP4', 'MOV', 'WEBM']);
