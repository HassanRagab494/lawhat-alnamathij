import { CsvBuilder, csvCell, csvRow, riyadhDateTime } from './csv';
import {
  buildResponseWhere,
  normalizeReferenceSearch,
  responseOrder,
  riyadhDayRange,
} from './filters';

describe('csvCell — منع حقن الصيغ والهروب', () => {
  it.each([
    ['=SUM(A1:A2)', `"'=SUM(A1:A2)"`],
    ['+966500000000', `"'+966500000000"`],
    ['-5', `"'-5"`],
    ['@cmd', `"'@cmd"`],
    ['\tTAB', `"'\tTAB"`],
    ['\r=x', `"'\r=x"`],
  ])('يسبق %j بعلامة اقتباس', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('يهرب التنصيص والفواصل والأسطر ولا يغيّر النص العادي', () => {
    expect(csvCell('نص "مقتبس", وسطر\nثانٍ')).toBe('"نص ""مقتبس"", وسطر\nثانٍ"');
    expect(csvCell('سارة')).toBe('"سارة"');
    expect(csvCell(12)).toBe('"12"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell('a=b')).toBe('"a=b"');
  });

  it('الصف ينتهي بـ CRLF', () => {
    expect(csvRow(['a', '=b'])).toBe(`"a","'=b"\r\n`);
  });
});

describe('CsvBuilder', () => {
  it('يبدأ بـ BOM ويرفض تجاوز الحد بالبايت دون إضافة الصف', () => {
    const csv = new CsvBuilder(10);
    expect(csv.bytes).toBe(3);
    expect(csv.push('abcd')).toBe(true);
    expect(csv.push('عربي')).toBe(false); // 8 بايت تتجاوز الحد
    expect(csv.toBuffer().toString('utf8')).toBe('﻿abcd');
  });
});

describe('الوقت والتواريخ بتوقيت الرياض', () => {
  it('يعرض وقت UTC بتوقيت الرياض', () => {
    expect(riyadhDateTime(new Date('2026-10-13T22:30:05.000Z'))).toBe('2026-10-14 01:30:05');
  });

  it('يحوّل أيام الرياض إلى نطاق UTC شامل للطرفين', () => {
    expect(riyadhDayRange('2026-10-01', '2026-10-01')).toEqual({
      gte: new Date('2026-09-30T21:00:00.000Z'),
      lt: new Date('2026-10-01T21:00:00.000Z'),
    });
    expect(riyadhDayRange(undefined, undefined)).toEqual({});
  });

  it('يرفض التواريخ غير الصالحة والنطاق المعكوس', () => {
    expect(() => riyadhDayRange('2026-02-30')).toThrow();
    expect(() => riyadhDayRange('2026-10-05', '2026-10-01')).toThrow();
  });
});

describe('فلاتر القائمة', () => {
  it('يطبّع البحث بالرقم المرجعي', () => {
    expect(normalizeReferenceSearch(' k7q2 m9xd ')).toBe('K7Q2-M9XD');
    expect(normalizeReferenceSearch('K7Q2-M9XD-4TPB')).toBe('K7Q2-M9XD-4TPB');
    expect(normalizeReferenceSearch('k7q')).toBe('K7Q');
    expect(normalizeReferenceSearch(' - ')).toBeNull();
    expect(normalizeReferenceSearch(undefined)).toBeNull();
  });

  it('يقيّد الشرط دائمًا بالنموذج ويستبعد المحذوف ويجمع الفلاتر', () => {
    expect(buildResponseWhere('f1', { sort: 'newest' })).toEqual({ formId: 'f1', deletedAt: null });
    // قائمة كل النماذج: بلا قيد نموذج، والمحذوف مستبعد دائمًا.
    expect(buildResponseWhere(undefined, { sort: 'newest' })).toEqual({
      formId: undefined,
      deletedAt: null,
    });
    const where = buildResponseWhere(
      'f1',
      { sort: 'oldest', status: 'ACCEPTED', search: 'abcd', from: '2026-10-01' },
      'v1',
    );
    expect(where).toEqual({
      formId: 'f1',
      deletedAt: null,
      versionId: 'v1',
      status: 'ACCEPTED',
      referenceCode: { startsWith: 'ABCD' },
      submittedAt: { gte: new Date('2026-09-30T21:00:00.000Z') },
    });
  });

  it('الترتيب بالتاريخ ثم المعرّف', () => {
    expect(responseOrder('oldest')).toEqual([{ submittedAt: 'asc' }, { id: 'asc' }]);
    expect(responseOrder('newest')).toEqual([{ submittedAt: 'desc' }, { id: 'desc' }]);
  });
});
