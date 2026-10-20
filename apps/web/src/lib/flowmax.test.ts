import { describe, expect, it } from 'vitest';
import { formatPriceSar, shareText, whatsappShareUrl, type FlowmaxShare } from './flowmax';

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

  it('وصف العقار فوق الرابط مباشرة، مع الغرف والحمامات والمطابخ، ويُختصر الطويل', () => {
    const text = shareText(
      {
        ...share,
        description: 'فيلا مطلة على البحر بمسبح خاص.',
        bedrooms: 5,
        bathrooms: 4,
        kitchens: 2,
      },
      'https://flowmax.test/property/9',
    );
    const lines = text.split('\n');
    expect(lines.at(-1)).toBe('https://flowmax.test/property/9');
    expect(lines.at(-2)).toBe('فيلا مطلة على البحر بمسبح خاص.');
    expect(text).toContain('الغرف: 5 · الحمامات: 4 · المطابخ: 2');
    const long = shareText({ ...share, description: 'و'.repeat(400) }, 'u')
      .split('\n')
      .at(-2)!;
    expect(long.length).toBe(300);
    expect(long.endsWith('…')).toBe(true);
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
