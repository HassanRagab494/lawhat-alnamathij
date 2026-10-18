import type { SaveDraftInput } from '../questions/draft-schema';

/**
 * قالب «نموذج عقاري موحّد»: سؤال إجباري يحدد العرض أو الطلب، ثم أسئلة كل مسار بشروط ظهور.
 *
 * الحقول والقيم والقيود مأخوذة من Flowmax نفسه:
 * - العرض: StorePropertyRequest وجدول property_field_definitions ومعالج إضافة العقار
 *   (frontend/src/pages/admin/CreateProperty.jsx). الإيجار اليومي غير متاح هنا لأن نشره يتطلب
 *   إعداد إيجار يومي وتوفرًا وتصريح سياحة لا يُجمع في نموذج عام. «أرض» العامة غير متاحة لأن
 *   استخدام الأرض حقل مخصص لا يقبله مسار الإنشاء؛ المتاح «أرض سكنية» و«أرض تجارية».
 * - الطلب: StoreAdminPropertyDemandRequest ونموذج طلب العقار في موقع Flowmax
 *   (frontend/website/properties/components/PropertyDemandForm.js).
 *
 * كل سؤال وخيار يحمل هوية دلالية ثابتة (semanticKey) يقرأها التكامل بدل عنوان السؤال،
 * فتغيير الصياغة من المحرر لا يكسر الربط.
 */

export const REAL_ESTATE_TEMPLATE = 'real-estate-unified';
export const FORM_TEMPLATES = [REAL_ESTATE_TEMPLATE] as const;
export type FormTemplate = (typeof FORM_TEMPLATES)[number];

/** أنواع عقار العرض: قيم property_category في Flowmax وتسمياتها. */
export const OFFER_CATEGORIES: [string, string][] = [
  ['apartment', 'شقة'],
  ['villa', 'فيلا'],
  ['duplex', 'دوبلكس'],
  ['studio', 'استوديو'],
  ['rest_house', 'استراحة'],
  ['traditional_house', 'بيت شعبي'],
  ['palace', 'قصر'],
  ['residential_land', 'أرض سكنية'],
  ['commercial_land', 'أرض تجارية'],
  ['office', 'مكتب'],
  ['shop', 'محل'],
  ['building', 'عمارة'],
  ['warehouse', 'مستودع'],
  ['hotel', 'فندق'],
  ['chalet', 'شاليه'],
  ['farm', 'مزرعة'],
];

/** أنواع عقار الطلب كما في نموذج طلب العقار في Flowmax. */
export const REQUEST_CATEGORIES: [string, string][] = [
  ['apartment', 'شقة'],
  ['villa', 'فيلا'],
  ['building', 'عمارة'],
  ['room', 'غرفة'],
  ['land', 'أرض'],
  ['office', 'مكتب'],
  ['warehouse', 'مستودع'],
  ['chalet', 'شاليه'],
  ['farm', 'مزرعة'],
  ['traditional_house', 'بيت شعبي'],
  ['palace', 'قصر'],
];

export const OFFER_PURPOSES: [string, string][] = [
  ['sale', 'بيع'],
  ['rent', 'إيجار'],
  ['investment', 'استثمار'],
];

export const REQUEST_PURPOSES: [string, string][] = [
  ['sale', 'شراء'],
  ['rent', 'إيجار'],
  ['investment', 'استثمار'],
];

/** فئات معالج Flowmax التي تظهر لها الغرف ودورات المياه والصالات (السكني والعمارة، دون الأراضي). */
const OFFER_ROOM_CATEGORIES = [
  'apartment',
  'villa',
  'duplex',
  'studio',
  'rest_house',
  'traditional_house',
  'palace',
  'hotel',
  'chalet',
  'farm',
  'building',
];
/** فئات متعددة الوحدات في المعالج. */
const OFFER_UNIT_CATEGORIES = ['building', 'hotel'];

type Choice = [semanticKey: string, label: string];

interface TemplateQuestion {
  key: string;
  type: SaveDraftInput['questions'][number]['type'];
  title: string;
  description?: string;
  required?: boolean;
  settings?: Record<string, unknown>;
  options?: Choice[];
  /** يظهر إن كانت إجابة السؤال ذي الهوية المحددة أحد الخيارات المحددة. */
  showIf?: [questionKey: string, optionKeys: string[]];
}

const text = (max: number) => ({ maxLength: max });
const integer = (min: number, max: number) => ({ allowDecimals: false, min, max });
const decimal = (min: number, max: number) => ({ allowDecimals: true, min, max });

const offer = (keys: string[] = ['offer']): [string, string[]] => ['listing.kind', keys];
const request = (): [string, string[]] => ['listing.kind', ['request']];
const requestNonLand = REQUEST_CATEGORIES.map(([k]) => k).filter((k) => k !== 'land');

const QUESTIONS: TemplateQuestion[] = [
  {
    key: 'listing.kind',
    type: 'SINGLE_CHOICE',
    title: 'وش ترغب تسجّل؟',
    description:
      'اختر «عرض عقار» إذا عندك عقار للبيع أو الإيجار أو الاستثمار، أو «طلب عقار» إذا تدوّر على عقار.',
    required: true,
    options: [
      ['offer', 'عرض عقار'],
      ['request', 'طلب عقار'],
    ],
  },

  // ---------- العرض ----------
  {
    key: 'offer.category',
    type: 'DROPDOWN',
    title: 'نوع العقار',
    required: true,
    options: OFFER_CATEGORIES,
    showIf: offer(),
  },
  {
    key: 'offer.purpose',
    type: 'SINGLE_CHOICE',
    title: 'الغرض من العرض',
    required: true,
    options: OFFER_PURPOSES,
    showIf: offer(),
  },
  {
    key: 'offer.role',
    type: 'SINGLE_CHOICE',
    title: 'صفتك',
    description: 'تُحفظ في الملاحظات الداخلية للإدارة فقط.',
    options: [
      ['owner', 'مالك'],
      ['broker', 'وسيط'],
      ['agent', 'وكيل'],
    ],
    showIf: offer(),
  },
  {
    key: 'offer.title',
    type: 'SHORT_TEXT',
    title: 'عنوان الإعلان',
    description: 'مثال: شقة للبيع في حي النرجس',
    required: true,
    settings: text(500),
    showIf: offer(),
  },
  {
    key: 'offer.description',
    type: 'PARAGRAPH',
    title: 'وصف العقار',
    description: 'أهم المميزات والموقع وحالة العقار.',
    required: true,
    settings: text(10000),
    showIf: offer(),
  },
  {
    key: 'offer.city',
    type: 'SHORT_TEXT',
    title: 'المدينة',
    required: true,
    settings: text(100),
    showIf: offer(),
  },
  {
    key: 'offer.district',
    type: 'SHORT_TEXT',
    title: 'الحي',
    required: true,
    settings: text(100),
    showIf: offer(),
  },
  {
    key: 'offer.address',
    type: 'SHORT_TEXT',
    title: 'العنوان التفصيلي',
    description: 'اسم الشارع أو معلم قريب (اختياري).',
    settings: text(500),
    showIf: offer(),
  },
  {
    key: 'offer.price',
    type: 'NUMBER',
    title: 'السعر المطلوب (ريال)',
    description: 'بالريال السعودي. للإيجار: قيمة الإيجار المطلوبة.',
    required: true,
    settings: integer(1, 10_000_000_000),
    showIf: offer(),
  },
  {
    key: 'offer.area',
    type: 'NUMBER',
    title: 'المساحة (م²)',
    settings: decimal(0, 99_999_999.99),
    showIf: offer(),
  },
  {
    key: 'offer.bedrooms',
    type: 'NUMBER',
    title: 'عدد غرف النوم',
    settings: integer(0, 1000),
    showIf: ['offer.category', OFFER_ROOM_CATEGORIES],
  },
  {
    key: 'offer.bathrooms',
    type: 'NUMBER',
    title: 'عدد دورات المياه',
    settings: integer(0, 1000),
    showIf: ['offer.category', OFFER_ROOM_CATEGORIES],
  },
  {
    key: 'offer.living_rooms',
    type: 'NUMBER',
    title: 'عدد الصالات',
    settings: integer(0, 1000),
    showIf: ['offer.category', OFFER_ROOM_CATEGORIES],
  },
  {
    key: 'offer.units',
    type: 'NUMBER',
    title: 'عدد الوحدات',
    settings: integer(0, 100_000),
    showIf: ['offer.category', OFFER_UNIT_CATEGORIES],
  },
  {
    key: 'offer.images',
    type: 'FILE_UPLOAD',
    title: 'صور العقار',
    description: 'صورة واحدة على الأقل. JPG أو PNG أو WEBP حتى 10 ميغابايت للصورة.',
    required: true,
    settings: { allowedTypes: ['jpg', 'png', 'webp'], maxFileSizeMb: 10, maxFiles: 10 },
    showIf: offer(),
  },
  {
    key: 'offer.videos',
    type: 'FILE_UPLOAD',
    title: 'فيديو العقار',
    description: 'اختياري. MP4 أو MOV أو WebM حتى 100 ميغابايت.',
    settings: { allowedTypes: ['mp4', 'mov', 'webm'], maxFileSizeMb: 100, maxFiles: 5 },
    showIf: offer(),
  },

  // ---------- الطلب ----------
  {
    key: 'request.category',
    type: 'DROPDOWN',
    title: 'نوع العقار المطلوب',
    required: true,
    options: REQUEST_CATEGORIES,
    showIf: request(),
  },
  {
    key: 'request.purpose',
    type: 'SINGLE_CHOICE',
    title: 'غرض الطلب',
    required: true,
    options: REQUEST_PURPOSES,
    showIf: request(),
  },
  {
    key: 'request.land_use',
    type: 'SHORT_TEXT',
    title: 'استخدام الأرض',
    description: 'مثال: سكني، تجاري، زراعي.',
    required: true,
    settings: text(80),
    showIf: ['request.category', ['land']],
  },
  {
    key: 'request.city',
    type: 'SHORT_TEXT',
    title: 'المدينة',
    required: true,
    settings: text(120),
    showIf: request(),
  },
  {
    key: 'request.district',
    type: 'SHORT_TEXT',
    title: 'الحي',
    settings: text(120),
    showIf: request(),
  },
  {
    key: 'request.budget_max',
    type: 'NUMBER',
    title: 'الحد الأعلى للميزانية (ريال)',
    required: true,
    settings: integer(1, 10_000_000_000),
    showIf: request(),
  },
  {
    key: 'request.budget_min',
    type: 'NUMBER',
    title: 'الحد الأدنى للميزانية (ريال)',
    description: 'اختياري، ولا يتجاوز الحد الأعلى.',
    settings: integer(0, 10_000_000_000),
    showIf: request(),
  },
  {
    key: 'request.address',
    type: 'SHORT_TEXT',
    title: 'العنوان التفصيلي',
    description: 'اختياري، ويُحفظ بشكل خاص.',
    settings: text(500),
    showIf: request(),
  },
  {
    key: 'request.sale_priority',
    type: 'SINGLE_CHOICE',
    title: 'أولوية الشراء',
    options: [
      ['normal', 'عادي'],
      ['urgent', 'عاجل'],
    ],
    showIf: ['request.purpose', ['sale']],
  },
  {
    key: 'request.sale_price_hint',
    type: 'SHORT_TEXT',
    title: 'سعر تقريبي',
    description: 'مثال: 1,200,000',
    settings: text(100),
    showIf: ['request.purpose', ['sale']],
  },
  {
    key: 'request.rent_duration',
    type: 'SHORT_TEXT',
    title: 'مدة الإيجار',
    description: 'مثال: 12 شهر',
    settings: text(100),
    showIf: ['request.purpose', ['rent']],
  },
  {
    key: 'request.rent_budget_hint',
    type: 'SHORT_TEXT',
    title: 'نطاق السعر الشهري',
    description: 'مثال: 25,000 - 35,000',
    settings: text(100),
    showIf: ['request.purpose', ['rent']],
  },
  {
    key: 'request.investment_goal',
    type: 'SHORT_TEXT',
    title: 'الهدف الاستثماري',
    description: 'مثال: تأجير أو إعادة بيع',
    settings: text(200),
    showIf: ['request.purpose', ['investment']],
  },
  {
    key: 'request.investment_horizon',
    type: 'SHORT_TEXT',
    title: 'الأفق الزمني',
    description: 'مثال: 6 أشهر',
    settings: text(100),
    showIf: ['request.purpose', ['investment']],
  },
  {
    key: 'request.investment_yield_min',
    type: 'NUMBER',
    title: 'الحد الأدنى للعائد المتوقع (%)',
    settings: decimal(0, 100),
    showIf: ['request.purpose', ['investment']],
  },
  {
    key: 'request.area_min',
    type: 'NUMBER',
    title: 'الحد الأدنى للمساحة (م²)',
    settings: decimal(0, 99_999_999.99),
    showIf: ['request.category', requestNonLand],
  },
  {
    key: 'request.area_max',
    type: 'NUMBER',
    title: 'الحد الأقصى للمساحة (م²)',
    settings: decimal(0, 99_999_999.99),
    showIf: ['request.category', requestNonLand],
  },
  {
    key: 'request.bedrooms_min',
    type: 'NUMBER',
    title: 'غرف النوم (الحد الأدنى)',
    settings: integer(0, 1000),
    showIf: ['request.category', requestNonLand],
  },
  {
    key: 'request.rooms_count',
    type: 'NUMBER',
    title: 'إجمالي الغرف',
    settings: integer(0, 1000),
    showIf: ['request.category', requestNonLand],
  },
  {
    key: 'request.bathrooms_min',
    type: 'NUMBER',
    title: 'دورات المياه (الحد الأدنى)',
    settings: integer(0, 1000),
    showIf: ['request.category', requestNonLand],
  },
  {
    key: 'request.building_age_max',
    type: 'NUMBER',
    title: 'أقصى عمر للعقار (بالسنوات)',
    settings: integer(0, 1000),
    showIf: ['request.category', requestNonLand],
  },
  {
    key: 'request.floor_preference',
    type: 'SINGLE_CHOICE',
    title: 'الطابق المفضل',
    options: [
      ['ground', 'أرضي'],
      ['middle', 'متوسط'],
      ['top', 'أخير'],
      ['any', 'أي طابق'],
    ],
    showIf: ['request.category', requestNonLand],
  },
  {
    key: 'request.furnishing',
    type: 'SINGLE_CHOICE',
    title: 'التأثيث',
    options: [
      ['furnished', 'مفروش'],
      ['unfurnished', 'غير مفروش'],
      ['any', 'لا يهم'],
    ],
    showIf: ['request.category', requestNonLand],
  },
  {
    key: 'request.land_area_min',
    type: 'NUMBER',
    title: 'الحد الأدنى لمساحة الأرض (م²)',
    settings: decimal(0, 99_999_999.99),
    showIf: ['request.category', ['land']],
  },
  {
    key: 'request.land_area_max',
    type: 'NUMBER',
    title: 'الحد الأقصى لمساحة الأرض (م²)',
    settings: decimal(0, 99_999_999.99),
    showIf: ['request.category', ['land']],
  },
  {
    key: 'request.frontage',
    type: 'SHORT_TEXT',
    title: 'الواجهة',
    description: 'مثال: شمالية',
    settings: text(100),
    showIf: ['request.category', ['land']],
  },
  {
    key: 'request.street_width',
    type: 'NUMBER',
    title: 'عرض الشارع (م)',
    settings: decimal(0, 1000),
    showIf: ['request.category', ['land']],
  },
  {
    key: 'request.amenities',
    type: 'SHORT_TEXT',
    title: 'المرافق المطلوبة',
    description: 'افصل بينها بفواصل.',
    settings: text(500),
    showIf: request(),
  },
  {
    key: 'request.finance_required',
    type: 'SINGLE_CHOICE',
    title: 'تحتاج تمويل؟',
    options: [
      ['true', 'نعم'],
      ['false', 'لا'],
    ],
    showIf: request(),
  },
  {
    key: 'request.notes',
    type: 'PARAGRAPH',
    title: 'ملاحظات إضافية',
    settings: text(2000),
    showIf: request(),
  },
  {
    key: 'request.consent',
    type: 'SINGLE_CHOICE',
    title: 'الموافقة على إرسال الطلب',
    description: 'أوافق على إرسال بيانات طلبي إلى Flowmax للبحث عن عقار مناسب والتواصل معي بخصوصه.',
    required: true,
    options: [
      ['yes', 'أوافق'],
      ['no', 'لا أوافق'],
    ],
    showIf: request(),
  },

  // ---------- التواصل (للمسارين) ----------
  {
    key: 'contact.name',
    type: 'SHORT_TEXT',
    title: 'الاسم',
    settings: text(160),
    showIf: offer(['offer', 'request']),
  },
  {
    key: 'contact.phone',
    type: 'SHORT_TEXT',
    title: 'رقم الجوال',
    description: 'مثال: 05xxxxxxxx. لا يظهر في الإعلان أو المشاركة.',
    required: true,
    settings: text(20),
    showIf: offer(['offer', 'request']),
  },
];

/** أسئلة القالب بصيغة حفظ المسودة (الشروط بالمواقع)، جاهزة للتحقق بالمخطط نفسه. */
export function realEstateTemplateQuestions(): SaveDraftInput['questions'] {
  const index = new Map(QUESTIONS.map((q, i) => [q.key, i]));
  return QUESTIONS.map((q) => {
    let showIf: { questionIndex: number; optionIndexes: number[] } | null = null;
    if (q.showIf) {
      const [targetKey, optionKeys] = q.showIf;
      const qi = index.get(targetKey);
      const target = qi === undefined ? undefined : QUESTIONS[qi];
      if (qi === undefined || !target?.options)
        throw new Error(`template: bad target ${targetKey}`);
      showIf = {
        questionIndex: qi,
        optionIndexes: optionKeys.map((k) => {
          const oi = target.options!.findIndex(([key]) => key === k);
          if (oi < 0) throw new Error(`template: bad option ${targetKey}.${k}`);
          return oi;
        }),
      };
    }
    return {
      type: q.type,
      title: q.title,
      description: q.description ?? null,
      required: q.required ?? false,
      settings: q.settings ?? {},
      showIf,
      semanticKey: q.key,
      options: (q.options ?? []).map(([semanticKey, label]) => ({ label, semanticKey })),
    } as SaveDraftInput['questions'][number];
  });
}

/** عنوان كل هوية دلالية في القالب؛ يُستخدم في رسائل النقص إن حُذف السؤال من النموذج. */
export const TEMPLATE_TITLES: Record<string, string> = Object.fromEntries(
  QUESTIONS.map((q) => [q.key, q.title]),
);

/** هل يحتوي النموذج على سؤال القالب الأساسي؟ عندها يُربط بالهويات الدلالية لا بالعناوين. */
export function isTemplateForm(semanticKeys: Iterable<string | null | undefined>): boolean {
  for (const k of semanticKeys) if (k === 'listing.kind') return true;
  return false;
}
