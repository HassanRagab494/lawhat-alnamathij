import { parseSaveDraft, type OptionInput } from '../questions/draft-schema';
import { visibleQuestionIds } from '../questions/visibility';
import { realEstateTemplateQuestions } from './real-estate';

function parsed() {
  return parseSaveDraft({
    revision: 1,
    title: 'نموذج عقاري',
    questions: realEstateTemplateQuestions(),
  }).questions;
}

/** يحاكي الظهور بالمواقع: كل سؤال بمعرّف = موقعه، وكل خيار بمعرّف = semanticKey. */
function visibleKeys(picks: Record<string, string[]>): string[] {
  const qs = parsed();
  const id = (i: number) => String(i);
  const questions = qs.map((q, i) => ({
    id: id(i),
    showIf: q.showIf
      ? {
          questionId: id(q.showIf.questionIndex),
          optionIds: q.showIf.optionIndexes.map(
            (oi) => (qs[q.showIf!.questionIndex]!.options[oi] as OptionInput).semanticKey!,
          ),
        }
      : null,
  }));
  const selected = new Map<string, string[]>();
  qs.forEach((q, i) => {
    if (q.semanticKey && picks[q.semanticKey]) selected.set(id(i), picks[q.semanticKey]!);
  });
  const visible = visibleQuestionIds(questions, selected);
  return qs.filter((_, i) => visible.has(id(i))).map((q) => q.semanticKey!);
}

describe('قالب النموذج العقاري الموحّد', () => {
  it('يجتاز مخطط حفظ المسودة نفسه، وأول سؤال إجباري «وش ترغب تسجّل؟»', () => {
    const qs = parsed();
    expect(qs[0]).toMatchObject({
      title: 'وش ترغب تسجّل؟',
      required: true,
      type: 'SINGLE_CHOICE',
      semanticKey: 'listing.kind',
      showIf: null,
    });
    expect((qs[0]!.options as OptionInput[]).map((o) => o.semanticKey)).toEqual([
      'offer',
      'request',
    ]);
    // كل سؤال بعد الأول مشروط، فلا يظهر شيء قبل اختيار المسار
    expect(qs.slice(1).every((q) => q.showIf)).toBe(true);
    expect(new Set(qs.map((q) => q.semanticKey)).size).toBe(qs.length);
  });

  it('قبل الاختيار لا يظهر إلا السؤال الأول', () => {
    expect(visibleKeys({})).toEqual(['listing.kind']);
  });

  it('العرض: أسئلة العرض والتواصل فقط، والغرف حسب نوع العقار', () => {
    const apartment = visibleKeys({ 'listing.kind': ['offer'], 'offer.category': ['apartment'] });
    expect(apartment).toEqual(
      expect.arrayContaining([
        'offer.title',
        'offer.price',
        'offer.images',
        'offer.bedrooms',
        'contact.phone',
      ]),
    );
    expect(apartment.some((k) => k.startsWith('request.'))).toBe(false);
    expect(apartment).not.toContain('offer.units');

    const land = visibleKeys({ 'listing.kind': ['offer'], 'offer.category': ['residential_land'] });
    expect(land).not.toContain('offer.bedrooms');
    const building = visibleKeys({ 'listing.kind': ['offer'], 'offer.category': ['building'] });
    expect(building).toEqual(expect.arrayContaining(['offer.units', 'offer.bedrooms']));
  });

  it('الطلب: أسئلة الطلب فقط، وأسئلة الغرض والأرض حسب الإجابة', () => {
    const sale = visibleKeys({
      'listing.kind': ['request'],
      'request.category': ['apartment'],
      'request.purpose': ['sale'],
    });
    expect(sale.some((k) => k.startsWith('offer.'))).toBe(false);
    expect(sale).toEqual(
      expect.arrayContaining(['request.budget_max', 'request.sale_priority', 'request.consent']),
    );
    expect(sale).not.toContain('request.rent_duration');
    expect(sale).not.toContain('request.land_use');

    const land = visibleKeys({
      'listing.kind': ['request'],
      'request.category': ['land'],
      'request.purpose': ['investment'],
    });
    expect(land).toEqual(
      expect.arrayContaining([
        'request.land_use',
        'request.land_area_min',
        'request.investment_goal',
      ]),
    );
    expect(land).not.toContain('request.bedrooms_min');
  });

  it('تغيير المسار يخفي أسئلة الفرع السابق حتى لو بقيت لها خيارات محددة', () => {
    const keys = visibleKeys({ 'listing.kind': ['request'], 'offer.category': ['apartment'] });
    expect(keys).not.toContain('offer.bedrooms');
    expect(keys).not.toContain('offer.category');
  });
});
