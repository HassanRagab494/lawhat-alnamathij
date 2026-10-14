import { describe, expect, it } from 'vitest';
import {
  formatPriceSar,
  formatValueTable,
  parseValueTable,
  shareText,
  whatsappShareUrl,
  type FlowmaxShare,
} from './flowmax';

const share: FlowmaxShare = {
  title: 'فيلا للبيع',
  operation: 'OFFER',
  purpose: 'بيع',
  category: 'فيلا',
  city: 'جدة',
  district: 'الشاطئ',
  priceSar: '2500000.50',
};

describe('نص المشاركة', () => {
  it('يحتوي العنوان والنوع والموقع والسعر والرابط بالترتيب', () => {
    expect(shareText(share, 'https://flowmax.test/property/7')).toBe(
      [
        'فيلا للبيع',
        'عرض — بيع — فيلا',
        'الموقع: جدة — الشاطئ',
        'السعر: 2,500,000.50 ريال',
        'https://flowmax.test/property/7',
      ].join('\n'),
    );
  });

  it('الطلب يذكر الميزانية، والحقول الفارغة تُحذف', () => {
    const text = shareText(
      { ...share, operation: 'REQUEST', district: null, priceSar: null, purpose: null },
      'u',
    );
    expect(text).toBe(['فيلا للبيع', 'طلب — فيلا', 'الموقع: جدة', 'u'].join('\n'));
    expect(shareText({ ...share, operation: 'REQUEST' }, 'u')).toContain(
      'الميزانية: 2,500,000.50 ريال',
    );
  });

  it('رابط واتساب يرمّز النص كاملًا بـ encodeURIComponent', () => {
    const text = 'سطر\nhttps://x.test/p?a=1&b=2';
    expect(whatsappShareUrl(text)).toBe(`https://wa.me/?text=${encodeURIComponent(text)}`);
    expect(whatsappShareUrl(text)).not.toContain('&b=');
  });

  it('formatPriceSar', () => {
    expect(formatPriceSar('850000')).toBe('850,000 ريال');
    expect(formatPriceSar('1000.00')).toBe('1,000 ريال');
  });
});

describe('جدول تحويل القيم', () => {
  it('يحلل السطور ويتجاهل الفارغ والناقص، ويعيد التنسيق', () => {
    const t = parseValueTable('شقة دوبلكس = duplex\n\nبلا قيمة =\n= x\nأرض = residential_land');
    expect(t).toEqual({ 'شقة دوبلكس': 'duplex', أرض: 'residential_land' });
    expect(formatValueTable(t)).toBe('شقة دوبلكس = duplex\nأرض = residential_land');
    expect(parseValueTable('')).toBeUndefined();
  });
});
