import { realEstateTemplateQuestions } from '../../forms/templates/real-estate';
import type { AnswerInput } from './mapping';
import { buildTemplateRequest } from './template-property';

const ctx = {
  referenceCode: 'ABCD-EFGH-JKMN',
  submittedAt: new Date('2026-10-18T09:00:00Z'),
  approvedAt: new Date('2026-10-18T21:30:00Z'), // 19 أكتوبر بتوقيت الرياض
  developerId: 7,
};

type Value =
  string | number | string[] | { files: { kind: 'JPG' | 'MP4' | 'PDF'; name: string }[] };

/** إجابات بصيغة الخدمة لكل أسئلة القالب؛ ما لم يُذكر يبقى فارغًا. hidden يحاكي الفرع غير النشط. */
function answers(values: Record<string, Value>, hidden: string[] = []): AnswerInput[] {
  return realEstateTemplateQuestions().map((q, i) => {
    const v = values[q.semanticKey!];
    const base: AnswerInput = {
      logicalId: `q${i}`,
      title: q.title,
      type: q.type,
      semanticKey: q.semanticKey,
      hidden: hidden.includes(q.semanticKey!),
    };
    if (v === undefined) return base;
    if (Array.isArray(v)) return { ...base, choiceKeys: v };
    if (typeof v === 'number') return { ...base, number: String(v) };
    if (typeof v === 'object')
      return {
        ...base,
        files: v.files.map((f, j) => ({
          id: `f${i}-${j}`,
          name: f.name,
          kind: f.kind,
          size: 1000,
        })),
      };
    return { ...base, text: v };
  });
}

const OFFER: Record<string, Value> = {
  'listing.kind': ['offer'],
  'offer.category': ['apartment'],
  'offer.purpose': ['sale'],
  'offer.role': ['owner'],
  'offer.title': 'شقة للبيع في النرجس',
  'offer.description': 'شقة اختبار — ليست عقارًا حقيقيًا.',
  'offer.city': 'الرياض',
  'offer.district': 'النرجس',
  'offer.price': 950000,
  'offer.area': 160,
  'offer.bedrooms': 4,
  'offer.bathrooms': 3,
  'offer.images': { files: [{ kind: 'JPG', name: 'front.jpg' }] },
  'offer.videos': { files: [{ kind: 'MP4', name: 'tour.mp4' }] },
  'contact.name': 'مالك تجريبي',
  'contact.phone': '0500000097',
};

const REQUEST: Record<string, Value> = {
  'listing.kind': ['request'],
  'request.category': ['land'],
  'request.purpose': ['investment'],
  'request.land_use': 'سكني',
  'request.city': 'جدة',
  'request.budget_max': 2000000,
  'request.budget_min': 1500000,
  'request.investment_goal': 'إعادة بيع',
  'request.land_area_min': 500,
  'request.finance_required': ['false'],
  'request.amenities': 'كهرباء، ماء',
  'request.consent': ['yes'],
  'contact.name': 'طالب تجريبي',
  'contact.phone': '0500000098',
};

describe('ربط النموذج العقاري الموحّد بـ Flowmax', () => {
  it('العرض يذهب لمسار العروض بقيم Flowmax والسعر بالهللة ورمز التصنيف حسب الغرض', () => {
    const built = buildTemplateRequest(answers(OFFER), ctx);
    expect(built.problems).toEqual([]);
    expect(built.operation).toBe('OFFER');
    expect(built.body).toEqual({
      title_ar: 'شقة للبيع في النرجس',
      description_ar: 'شقة اختبار — ليست عقارًا حقيقيًا.',
      type_letter: 'B',
      listing_kind: 'offer',
      developer_id: 7,
      mediation_contract_number: 'LAWHA-ABCD-EFGH-JKMN',
      contract_day: '19',
      contract_month: '10',
      property_category: 'apartment',
      listing_purpose: 'sale',
      city: 'الرياض',
      district: 'النرجس',
      currency: 'SAR',
      requested_price: 95_000_000,
      area_sqm: 160,
      bedrooms_count: 4,
      bathrooms_count: 3,
      contact_phone: '+966500000097',
      listing_notes: 'الاسم: مالك تجريبي — الصفة: مالك — رد لوحة النماذج ABCD-EFGH-JKMN',
    });
    expect(built.media.map((m) => m.role)).toEqual(['image', 'video']);
    expect(built.share).toMatchObject({
      title: 'شقة للبيع في النرجس',
      priceSar: '950000',
      purpose: 'بيع',
    });
    expect(JSON.stringify(built.share)).not.toMatch(/0500000097|مالك تجريبي/);
  });

  it('تغيير صياغة السؤال لا يكسر الربط (الهوية الدلالية لا العنوان)', () => {
    const renamed = answers(OFFER).map((a) =>
      a.semanticKey === 'offer.price' ? { ...a, title: 'كم تبي فيه؟' } : a,
    );
    expect(buildTemplateRequest(renamed, ctx).body.requested_price).toBe(95_000_000);
  });

  it('العرض الناقص يُرفض برسائل عربية تحدد الحقول، دون أي قيمة افتراضية', () => {
    const { problems, body } = buildTemplateRequest(
      answers({
        ...OFFER,
        'offer.district': '',
        'offer.price': undefined as never,
        'offer.images': { files: [] },
      }),
      ctx,
    );
    expect(body).toEqual({});
    expect(problems.map((p) => p.message)).toEqual([
      '«الحي»: الإجابة مطلوبة.',
      '«السعر المطلوب (ريال)»: الإجابة مطلوبة.',
      '«صور العقار»: أرفق صورة واحدة على الأقل.',
    ]);
  });

  it('إجابات الفرع المخفي لا تُرسل', () => {
    const built = buildTemplateRequest(
      answers({ ...REQUEST, 'offer.title': 'تلاعب', 'offer.price': 1 }, [
        'offer.title',
        'offer.price',
      ]),
      ctx,
    );
    expect(built.operation).toBe('REQUEST');
    expect(JSON.stringify(built.body)).not.toMatch(/تلاعب/);
  });

  it('الطلب يذهب لمسار الطلبات بالميزانية بالهللة والمعايير وموافقة المرسل', () => {
    const built = buildTemplateRequest(answers(REQUEST), ctx);
    expect(built.problems).toEqual([]);
    expect(built.operation).toBe('REQUEST');
    expect(built.media).toEqual([]);
    expect(built.body).toEqual({
      requester_name: 'طالب تجريبي',
      requester_phone: '+966500000098',
      property_category: 'land',
      listing_purpose: 'investment',
      land_use: 'سكني',
      city: 'جدة',
      budget_max_halalas: 200_000_000,
      budget_min_halalas: 150_000_000,
      criteria: {
        land_area_sqm_min: 500,
        finance_required: false,
        amenities: ['كهرباء', 'ماء'],
        investment_goal: 'إعادة بيع',
      },
      consent_version: 'lawha-forms-1',
      intake_consent_evidence:
        'موافقة المرسل ضمن رد لوحة النماذج ABCD-EFGH-JKMN بتاريخ 2026-10-18T09:00:00.000Z',
    });
    expect(built.share?.title).toBe('طلب أرض للاستثمار في جدة');
  });

  it('قيود الطلب: الأرض تتطلب استخدامها، والحد الأدنى لا يتجاوز الأعلى، والموافقة إلزامية', () => {
    const { problems } = buildTemplateRequest(
      answers({
        ...REQUEST,
        'request.land_use': '',
        'request.budget_min': 3000000,
        'request.consent': ['no'],
        'contact.phone': '123',
      }),
      ctx,
    );
    expect(problems.map((p) => p.message)).toEqual([
      '«رقم الجوال»: رقم الجوال غير صالح (مثال: 05xxxxxxxx).',
      '«استخدام الأرض»: الإجابة مطلوبة.',
      '«الحد الأدنى للميزانية (ريال)»: يجب ألا يتجاوز الحد الأعلى للميزانية.',
      '«الموافقة على إرسال الطلب»: لم يوافق المرسل على إرسال الطلب.',
    ]);
  });

  it('بلا اختيار المسار: رسالة واحدة على السؤال الأول', () => {
    const { problems, operation } = buildTemplateRequest(answers({}), ctx);
    expect(operation).toBeNull();
    expect(problems).toEqual([
      { field: 'listing.kind', message: '«وش ترغب تسجّل؟»: الإجابة مطلوبة.' },
    ]);
  });

  it('العرض بلا مطور داخلي مضبوط يُمنع', () => {
    const { problems } = buildTemplateRequest(answers(OFFER), { ...ctx, developerId: undefined });
    expect(problems.map((p) => p.field)).toEqual(['developer_id']);
  });
});
