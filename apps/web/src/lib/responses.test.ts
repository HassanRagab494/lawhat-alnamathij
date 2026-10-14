import { describe, expect, it } from 'vitest';
import { togglePermission } from './permissions';
import {
  EMPTY_FILTERS,
  filterErrors,
  filtersFromParams,
  filtersToQuery,
  hasActiveFilters,
  responsesCount,
} from './responses';

describe('فلاتر الردود في الرابط', () => {
  it('يقرأ القيم الصالحة ويتجاهل غير الصالحة', () => {
    const f = filtersFromParams(
      new URLSearchParams(
        'search=k7q2&status=ACCEPTED&from=2026-10-01&to=bad&version=2&sort=oldest&page=3',
      ),
    );
    expect(f).toEqual({
      search: 'k7q2',
      status: 'ACCEPTED',
      from: '2026-10-01',
      to: '',
      version: '2',
      sort: 'oldest',
      page: 3,
    });
    expect(filtersFromParams(new URLSearchParams('status=DELETED&page=-1&version=0'))).toEqual(
      EMPTY_FILTERS,
    );
  });

  it('يكتب غير الافتراضي فقط، ويمكن حذف الصفحة للتصدير', () => {
    expect(filtersToQuery(EMPTY_FILTERS)).toBe('');
    const f = { ...EMPTY_FILTERS, search: ' AB ', status: 'NEW' as const, page: 2 };
    expect(filtersToQuery(f)).toBe('search=AB&status=NEW&page=2');
    expect(filtersToQuery(f, { paging: false })).toBe('search=AB&status=NEW');
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, sort: 'oldest' })).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, version: '1' })).toBe(true);
  });

  it('يتحقق محليًا من البحث ونطاق التاريخ', () => {
    expect(filterErrors({ ...EMPTY_FILTERS, search: '<x>' }).search).toMatch(/الرقم المرجعي/);
    expect(filterErrors({ ...EMPTY_FILTERS, from: '2026-10-05', to: '2026-10-01' }).to).toMatch(
      /تاريخ النهاية/,
    );
    expect(filterErrors({ ...EMPTY_FILTERS, from: '2026-10-01', to: '2026-10-01' })).toEqual({});
  });
});

describe('اعتماديات صلاحيات الردود', () => {
  it('تفعيل المراجعة يفعّل عرض الردود وعرض النماذج', () => {
    expect(togglePermission([], 'RESPONSES_REVIEW', true)).toEqual([
      'FORMS_VIEW',
      'RESPONSES_VIEW',
      'RESPONSES_REVIEW',
    ]);
  });

  it('إلغاء عرض الردود يلغي المراجعة والتصدير، وإلغاء عرض النماذج يلغي كل التوابع', () => {
    const all = [
      'FORMS_VIEW',
      'FORMS_EDIT',
      'RESPONSES_VIEW',
      'RESPONSES_REVIEW',
      'RESPONSES_EXPORT',
    ] as const;
    expect(togglePermission([...all], 'RESPONSES_VIEW', false)).toEqual([
      'FORMS_VIEW',
      'FORMS_EDIT',
    ]);
    expect(togglePermission([...all], 'FORMS_VIEW', false)).toEqual([]);
  });
});

describe('responsesCount', () => {
  it('يصوغ العدد بالعربية', () => {
    expect([0, 1, 2, 3, 10, 11, 103, 111].map((n) => responsesCount(n))).toEqual([
      'لا توجد ردود',
      'رد واحد',
      'ردّان',
      '3 ردود',
      '10 ردود',
      '11 ردًا',
      '103 ردود',
      '111 ردًا',
    ]);
  });
});
