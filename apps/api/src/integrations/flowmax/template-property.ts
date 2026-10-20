import type { FileKind } from '@prisma/client';
import {
  OFFER_CATEGORIES,
  OFFER_PURPOSES,
  REQUEST_CATEGORIES,
  REQUEST_PURPOSES,
  TEMPLATE_TITLES,
} from '../../forms/templates/real-estate';
import type { AutoContext } from './auto-property';
import type { Operation } from './fields';
import {
  normalizePhone,
  toLatinDigits,
  type AnswerInput,
  type BuildResult,
  type Problem,
  type ShareInfo,
} from './mapping';
import type { MediaCandidate } from './media';

/**
 * ربط «النموذج العقاري الموحّد» بـ Flowmax بالهويات الدلالية (لا بعناوين الأسئلة).
 * العرض ⇒ مسار العروض بقواعد StorePropertyRequest، والطلب ⇒ مسار الطلبات بقواعد
 * StoreAdminPropertyDemandRequest. لا يُكمَل أي حقل ناقص بقيمة افتراضية؛ النقص يُعاد برسالة عربية.
 * القيم الخادمة الوحيدة: المطور الداخلي ومرجع التفويض وتاريخه ورمز التصنيف وإصدار نص الموافقة.
 */

/** رمز التصنيف حسب الغرض، كما يختاره معالج إضافة العقار في Flowmax تلقائيًا. */
const TYPE_LETTER_BY_PURPOSE: Record<string, string> = { sale: 'B', rent: 'J', investment: 'TH' };
const VIDEO_KINDS = new Set<FileKind>(['MP4', 'MOV', 'WEBM']);
/** صيغة contact_phone في StorePropertyRequest. */
const OFFER_PHONE_RE = /^\+?[0-9][0-9\s().-]{6,28}$/;
export const TEMPLATE_CONSENT_VERSION = 'lawha-forms-1';

const label = (pairs: [string, string][], key: string | null) =>
  key ? (pairs.find(([k]) => k === key)?.[1] ?? null) : null;

export function buildTemplateRequest(answers: AnswerInput[], ctx: AutoContext): BuildResult {
  const byKey = new Map<string, AnswerInput>();
  for (const a of answers) if (a.semanticKey && !a.hidden) byKey.set(a.semanticKey, a);

  const problems: Problem[] = [];
  const titleOf = (key: string) => byKey.get(key)?.title ?? TEMPLATE_TITLES[key] ?? key;
  const fail = (key: string, why = 'الإجابة مطلوبة') => {
    if (!problems.some((p) => p.field === key))
      problems.push({ field: key, message: `«${titleOf(key)}»: ${why}.` });
  };
  const text = (key: string) => byKey.get(key)?.text?.trim() || null;
  const choice = (key: string) => byKey.get(key)?.choiceKeys?.[0] ?? null;
  const number = (key: string) => {
    const raw = byKey.get(key)?.number;
    if (raw == null) return null;
    const n = Number(toLatinDigits(raw));
    return Number.isFinite(n) ? n : null;
  };
  const files = (key: string) => byKey.get(key)?.files ?? [];
  /** نص إجباري بحد أقصى من قواعد Flowmax (حتى لو غيّر المحرر حدود السؤال). */
  const requiredText = (key: string, max: number) => {
    const v = text(key);
    if (!v) fail(key);
    else if (v.length > max) fail(key, `يجب ألا يزيد عن ${max} حرف`);
    return v && v.length <= max ? v : null;
  };
  const optionalText = (key: string, max: number) => {
    const v = text(key);
    if (v && v.length > max) {
      fail(key, `يجب ألا يزيد عن ${max} حرف`);
      return null;
    }
    return v;
  };
  const bounded = (key: string, min: number, max: number, integer: boolean) => {
    const v = number(key);
    if (v == null) return null;
    if (integer && !Number.isInteger(v)) fail(key, 'يجب أن يكون عددًا صحيحًا');
    else if (v < min || v > max) fail(key, `يجب أن يكون بين ${min} و${max}`);
    else return v;
    return null;
  };

  const kind = choice('listing.kind');
  if (kind !== 'offer' && kind !== 'request') {
    fail('listing.kind');
    return { operation: null, body: {}, share: null, media: [], problems };
  }
  const operation: Operation = kind === 'offer' ? 'OFFER' : 'REQUEST';
  const name = optionalText('contact.name', 160);
  const phoneRaw = text('contact.phone');
  const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
  if (!phoneRaw) fail('contact.phone');
  else if (!phone) fail('contact.phone', 'رقم الجوال غير صالح (مثال: 05xxxxxxxx)');

  return operation === 'OFFER' ? buildOffer() : buildRequest();

  function buildOffer(): BuildResult {
    const category = choice('offer.category');
    if (!label(OFFER_CATEGORIES, category)) fail('offer.category');
    const purpose = choice('offer.purpose');
    if (!label(OFFER_PURPOSES, purpose)) fail('offer.purpose');
    // عنوان الإعلان: إجابة سؤال offer.title في النماذج القديمة، وإلا يُبنى من إجابات المرسل نفسها
    const answeredTitle = optionalText('offer.title', 500);
    const description = requiredText('offer.description', 10000);
    const city = requiredText('offer.city', 100);
    const district = requiredText('offer.district', 100);
    const address = optionalText('offer.address', 2000);
    const price = number('offer.price');
    if (price == null) fail('offer.price');
    else if (!Number.isInteger(price) || price < 1)
      fail('offer.price', 'يجب أن يكون مبلغًا صحيحًا موجبًا');
    const area = bounded('offer.area', 0, 99_999_999.99, false);
    const bedrooms = bounded('offer.bedrooms', 0, 1000, true);
    const bathrooms = bounded('offer.bathrooms', 0, 1000, true);
    const kitchens = bounded('offer.kitchens', 0, 1000, true);
    const livingRooms = bounded('offer.living_rooms', 0, 1000, true);
    const units = bounded('offer.units', 0, 100_000, true);
    if (phone && !OFFER_PHONE_RE.test(phone)) fail('contact.phone', 'رقم الجوال غير صالح');

    const media: MediaCandidate[] = ['offer.images', 'offer.videos'].flatMap((key) =>
      files(key).map((f) => ({
        fileId: f.id,
        name: f.name,
        kind: f.kind,
        size: f.size,
        role: VIDEO_KINDS.has(f.kind) ? ('video' as const) : ('image' as const),
      })),
    );
    // Flowmax لا ينشر عقارًا بلا صورة (الحد الأدنى الافتراضي للصور 1)
    if (!media.some((m) => m.role === 'image')) fail('offer.images', 'أرفق صورة واحدة على الأقل');
    if (!ctx.developerId) {
      problems.push({
        field: 'developer_id',
        message: 'المطور الداخلي في Flowmax غير مضبوط على الخادم (FLOWMAX_DEVELOPER_ID).',
      });
    }
    if (problems.length) return { operation: 'OFFER', body: {}, share: null, media, problems };

    const categoryLabel = label(OFFER_CATEGORIES, category)!;
    const purposeLabel = label(OFFER_PURPOSES, purpose)!;
    const title =
      answeredTitle ?? `${categoryLabel} لل${purposeLabel} في ${city} — ${district}`.slice(0, 500);
    const riyadh = (part: 'day' | 'month') =>
      ctx.approvedAt.toLocaleDateString('en-GB', { timeZone: 'Asia/Riyadh', [part]: '2-digit' });
    const role = label(
      [
        ['owner', 'مالك'],
        ['broker', 'وسيط'],
        ['agent', 'وكيل'],
      ],
      choice('offer.role'),
    );
    const body: Record<string, unknown> = {
      title_ar: title,
      description_ar: description,
      type_letter: TYPE_LETTER_BY_PURPOSE[purpose!],
      listing_kind: 'offer',
      developer_id: ctx.developerId,
      mediation_contract_number: `LAWHA-${ctx.referenceCode}`,
      contract_day: riyadh('day'),
      contract_month: riyadh('month'),
      property_category: category,
      listing_purpose: purpose,
      city,
      district,
      address_details: address,
      currency: 'SAR',
      requested_price: Math.round(price! * 100),
      area_sqm: area,
      bedrooms_count: bedrooms,
      bathrooms_count: bathrooms,
      kitchens_count: kitchens,
      living_rooms_count: livingRooms,
      units_count: units,
      contact_phone: phone,
      // الاسم والصفة في الملاحظات الإدارية فقط (لا تظهر في واجهات Flowmax العامة)
      listing_notes: [
        name && `الاسم: ${name}`,
        role && `الصفة: ${role}`,
        `رد لوحة النماذج ${ctx.referenceCode}`,
      ]
        .filter(Boolean)
        .join(' — '),
    };
    dropEmpty(body);
    const share: ShareInfo = {
      title,
      // الوصف الذي يُرسل إلى Flowmax (description_ar) نفسه
      description,
      operation: 'OFFER',
      purpose: purposeLabel,
      category: categoryLabel,
      city,
      district,
      priceSar: String(price),
      areaSqm: area,
      bedrooms,
      bathrooms,
      kitchens,
    };
    return { operation: 'OFFER', body, share, media, problems };
  }

  function buildRequest(): BuildResult {
    const category = choice('request.category');
    if (!label(REQUEST_CATEGORIES, category)) fail('request.category');
    const purpose = choice('request.purpose');
    if (!label(REQUEST_PURPOSES, purpose)) fail('request.purpose');
    const landUse = category === 'land' ? requiredText('request.land_use', 80) : null;
    const city = requiredText('request.city', 120);
    const district = optionalText('request.district', 120);
    const address = optionalText('request.address', 2000);
    const budgetMax = number('request.budget_max');
    if (budgetMax == null) fail('request.budget_max');
    else if (!Number.isInteger(budgetMax) || budgetMax < 1)
      fail('request.budget_max', 'يجب أن يكون مبلغًا صحيحًا موجبًا');
    const budgetMin = bounded('request.budget_min', 0, 10_000_000_000, true);
    if (budgetMin != null && budgetMax != null && budgetMin > budgetMax)
      fail('request.budget_min', 'يجب ألا يتجاوز الحد الأعلى للميزانية');
    const consent = choice('request.consent');
    if (!consent) fail('request.consent');
    else if (consent !== 'yes') fail('request.consent', 'لم يوافق المرسل على إرسال الطلب');

    const criteria: Record<string, unknown> = {
      area_sqm_min: bounded('request.area_min', 0, 99_999_999.99, false),
      area_sqm_max: bounded('request.area_max', 0, 99_999_999.99, false),
      land_area_sqm_min: bounded('request.land_area_min', 0, 99_999_999.99, false),
      land_area_sqm_max: bounded('request.land_area_max', 0, 99_999_999.99, false),
      bedrooms_min: bounded('request.bedrooms_min', 0, 1000, true),
      rooms_count: bounded('request.rooms_count', 0, 1000, true),
      bathrooms_min: bounded('request.bathrooms_min', 0, 1000, true),
      building_age_max: bounded('request.building_age_max', 0, 1000, true),
      floor_preference: choice('request.floor_preference'),
      furnishing: choice('request.furnishing'),
      frontage: optionalText('request.frontage', 100),
      street_width_m: bounded('request.street_width', 0, 1000, false),
      finance_required:
        choice('request.finance_required') == null
          ? null
          : choice('request.finance_required') === 'true',
      amenities: text('request.amenities')
        ?.split(/[,،]/)
        .map((s) => s.trim())
        .filter(Boolean),
      sale_priority: choice('request.sale_priority'),
      sale_price_hint: optionalText('request.sale_price_hint', 100),
      rent_duration: optionalText('request.rent_duration', 100),
      rent_budget_hint: optionalText('request.rent_budget_hint', 100),
      investment_goal: optionalText('request.investment_goal', 200),
      investment_horizon: optionalText('request.investment_horizon', 100),
      investment_yield_min: bounded('request.investment_yield_min', 0, 100, false),
      request_notes: optionalText('request.notes', 2000),
    };
    dropEmpty(criteria);
    // المطابخ ليست من معايير طلبات Flowmax؛ تبقى في الرد هنا ولا تُرسل
    const kitchensMin = bounded('request.kitchens_min', 0, 1000, true);
    const notices =
      kitchensMin != null
        ? [
            `«${titleOf('request.kitchens_min')}» (${kitchensMin}) محفوظ في الرد هنا فقط؛ طلبات Flowmax لا تدعمه.`,
          ]
        : [];
    if (problems.length)
      return { operation: 'REQUEST', body: {}, share: null, media: [], problems };

    const body: Record<string, unknown> = {
      requester_name: name,
      requester_phone: phone,
      property_category: category,
      listing_purpose: purpose,
      land_use: landUse,
      city,
      district,
      budget_max_halalas: budgetMax! * 100,
      budget_min_halalas: budgetMin != null ? budgetMin * 100 : null,
      detailed_address: address,
      ...(Object.keys(criteria).length ? { criteria } : {}),
      consent_version: TEMPLATE_CONSENT_VERSION,
      intake_consent_evidence: `موافقة المرسل ضمن رد لوحة النماذج ${ctx.referenceCode} بتاريخ ${ctx.submittedAt.toISOString()}`,
    };
    dropEmpty(body);
    const categoryLabel = label(REQUEST_CATEGORIES, category)!;
    const purposeLabel = label(REQUEST_PURPOSES, purpose)!;
    const share: ShareInfo = {
      // عنوان عرض فقط (لا يُرسل إلى Flowmax)، من إجابات المرسل
      title: `طلب ${categoryLabel} لل${purposeLabel} في ${[city, district].filter(Boolean).join(' — ')}`,
      description: (criteria.request_notes as string | undefined) ?? null,
      operation: 'REQUEST',
      purpose: purposeLabel,
      category: categoryLabel,
      city,
      district,
      priceSar: String(budgetMax),
      areaSqm: (criteria.area_sqm_min as number | undefined) ?? null,
      bedrooms: (criteria.bedrooms_min as number | undefined) ?? null,
      bathrooms: (criteria.bathrooms_min as number | undefined) ?? null,
    };
    return { operation: 'REQUEST', body, share, media: [], problems, notices };
  }
}

function dropEmpty(o: Record<string, unknown>): void {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))
      delete o[k];
  }
}
