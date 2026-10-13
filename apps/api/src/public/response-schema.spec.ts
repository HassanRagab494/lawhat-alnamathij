import { HttpException } from '@nestjs/common';
import type { ApiErrorBody } from '../common/errors';
import { publishBlockers } from '../forms/publish.service';
import { generateReferenceCode } from './public.service';
import {
  parseSubmitResponse,
  requestHash,
  validateAgainstVersion,
  type VersionQuestionForValidation,
} from './response-schema';

const id = (n: number) => `0190d6b4-0000-7000-8000-${String(n).padStart(12, '0')}`;
const V = id(900);
const KEY = id(901);

const Q: Record<string, VersionQuestionForValidation> = {
  short: {
    id: id(1),
    type: 'SHORT_TEXT',
    title: 'الاسم',
    required: true,
    settings: { minLength: 2, maxLength: 10 },
    options: [],
  },
  para: { id: id(2), type: 'PARAGRAPH', title: 'نبذة', required: false, settings: {}, options: [] },
  single: {
    id: id(3),
    type: 'SINGLE_CHOICE',
    title: 'المدينة',
    required: true,
    settings: {},
    options: [{ id: id(31) }, { id: id(32) }],
  },
  multi: {
    id: id(4),
    type: 'MULTIPLE_CHOICE',
    title: 'الخدمات',
    required: false,
    settings: { minSelections: 2, maxSelections: 3 },
    options: [{ id: id(41) }, { id: id(42) }, { id: id(43) }, { id: id(44) }],
  },
  drop: {
    id: id(5),
    type: 'DROPDOWN',
    title: 'القسم',
    required: false,
    settings: {},
    options: [{ id: id(51) }, { id: id(52) }],
  },
  int: {
    id: id(6),
    type: 'NUMBER',
    title: 'العدد',
    required: false,
    settings: { allowDecimals: false, min: 1, max: 100 },
    options: [],
  },
  dec: {
    id: id(7),
    type: 'NUMBER',
    title: 'المبلغ',
    required: false,
    settings: { allowDecimals: true },
    options: [],
  },
  date: {
    id: id(8),
    type: 'DATE',
    title: 'التاريخ',
    required: false,
    settings: { minDate: '2026-01-01', maxDate: '2026-12-31' },
    options: [],
  },
};
const all = Object.values(Q);

function errors(answers: { questionId: string; value: string | string[] }[], qs = all) {
  try {
    validateAgainstVersion(qs, answers);
  } catch (e) {
    const body = (e as HttpException).getResponse() as ApiErrorBody;
    expect(body.code).toBe('VALIDATION_FAILED');
    return Object.fromEntries((body.fields ?? []).map((f) => [f.field, f.message]));
  }
  throw new Error('expected validation failure');
}

const valid = [
  { questionId: Q.short!.id, value: '  سارة  ' },
  { questionId: Q.single!.id, value: id(32) },
];

describe('validateAgainstVersion', () => {
  it('يقبل كل الأنواع السبعة القابلة للإرسال ويطبّع القيم', () => {
    const out = validateAgainstVersion(all, [
      ...valid,
      { questionId: Q.para!.id, value: 'نص' },
      { questionId: Q.multi!.id, value: [id(41), id(43)] },
      { questionId: Q.drop!.id, value: id(51) },
      { questionId: Q.int!.id, value: '42' },
      { questionId: Q.dec!.id, value: '-12.3456789012' },
      { questionId: Q.date!.id, value: '2026-06-30' },
    ]);
    const byQ = Object.fromEntries(out.map((a) => [a.questionId, a]));
    expect(byQ[Q.short!.id]!.textValue).toBe('سارة');
    expect(byQ[Q.single!.id]!.optionIds).toEqual([id(32)]);
    expect(byQ[Q.multi!.id]!.optionIds).toEqual([id(41), id(43)]);
    expect(byQ[Q.int!.id]!.numberValue).toBe('42');
    expect(byQ[Q.dec!.id]!.numberValue).toBe('-12.3456789012');
    expect(byQ[Q.date!.id]!.dateValue?.toISOString()).toBe('2026-06-30T00:00:00.000Z');
    expect(out).toHaveLength(8);
  });

  it('السؤال الاختياري الفارغ لا يُحفظ ولا تُطبق قيوده', () => {
    const out = validateAgainstVersion(all, [
      ...valid,
      { questionId: Q.multi!.id, value: [] },
      { questionId: Q.int!.id, value: '  ' },
    ]);
    expect(out.map((a) => a.questionId)).toEqual([Q.short!.id, Q.single!.id]);
  });

  it('يرفض الإجابة المطلوبة الناقصة أو المسافات فقط', () => {
    expect(errors([{ questionId: Q.short!.id, value: '   ' }])).toEqual({
      [`answers.${Q.short!.id}`]: 'هذا السؤال إجباري.',
      [`answers.${Q.single!.id}`]: 'هذا السؤال إجباري.',
    });
  });

  it('يرفض الأسئلة غير المعروفة والمكررة', () => {
    const e = errors([
      ...valid,
      { questionId: id(999), value: 'x' },
      { questionId: Q.short!.id, value: 'مكرر' },
    ]);
    expect(e['answers.2.questionId']).toBe('هذا السؤال لا يخص الإصدار الحالي.');
    expect(e['answers.3.questionId']).toBe('تكررت الإجابة على السؤال نفسه.');
  });

  it('يرفض أنواع القيم الخاطئة', () => {
    expect(
      errors([{ questionId: Q.short!.id, value: ['x'] }, valid[1]!])[`answers.${Q.short!.id}`],
    ).toBe('نوع الإجابة غير صحيح.');
    expect(
      errors([...valid, { questionId: Q.multi!.id, value: id(41) }])[`answers.${Q.multi!.id}`],
    ).toBe('نوع الإجابة غير صحيح.');
    expect(
      errors([valid[0]!, { questionId: Q.single!.id, value: [id(31), id(32)] }])[
        `answers.${Q.single!.id}`
      ],
    ).toBe('اختر خيارًا واحدًا فقط.');
  });

  it('يطبق حدود النص والعدد والتاريخ والاختيارات', () => {
    expect(
      errors([{ questionId: Q.short!.id, value: 'س' }, valid[1]!])[`answers.${Q.short!.id}`],
    ).toMatch(/لا تقل/);
    expect(
      errors([{ questionId: Q.short!.id, value: 'س'.repeat(11) }, valid[1]!])[
        `answers.${Q.short!.id}`
      ],
    ).toMatch(/لا تزيد/);
    const cases: [VersionQuestionForValidation, string | string[], RegExp][] = [
      [Q.int!, '0', /لا يقل/],
      [Q.int!, '101', /لا يزيد/],
      [Q.int!, '5.5', /دون كسور/],
      [Q.int!, '1e3', /رقمًا صحيحًا/],
      [Q.dec!, '1.12345678901', /10 خانات/],
      [Q.dec!, '9999999999999', /خارج الحدود/],
      [Q.date!, '2025-12-31', /قبل/],
      [Q.date!, '2027-01-01', /بعد/],
      [Q.date!, '2026-02-30', /تاريخًا صحيحًا/],
      [Q.multi!, [id(41)], /على الأقل/],
      [Q.multi!, [id(41), id(42), id(43), id(44)], /كحد أقصى/],
      [Q.multi!, [id(41), id(41)], /تكرر/],
      [Q.multi!, [id(41), id(31)], /غير موجود/],
      [Q.drop!, id(31), /غير موجود/],
    ];
    for (const [q, value, re] of cases) {
      expect([
        q.title,
        value,
        errors([...valid, { questionId: q.id, value }])[`answers.${q.id}`],
      ]).toEqual([q.title, value, expect.stringMatching(re)]);
    }
  });

  it('يرفض أي بيانات لسؤال ملفات', () => {
    const file: VersionQuestionForValidation = {
      id: id(10),
      type: 'FILE_UPLOAD',
      title: 'ملف',
      required: false,
      settings: {},
      options: [],
    };
    expect(errors([{ questionId: file.id, value: 'file.pdf' }], [file])[`answers.${file.id}`]).toBe(
      'رفع الملفات غير متاح.',
    );
  });
});

describe('parseSubmitResponse', () => {
  it('يرفض الحقول غير المعروفة والمعرّفات غير الصالحة وتجاوز العدد', () => {
    const fieldsOf = (body: unknown) => {
      try {
        parseSubmitResponse(body);
      } catch (e) {
        return ((e as HttpException).getResponse() as ApiErrorBody).fields!.map((f) => f.field);
      }
      return [];
    };
    expect(fieldsOf({ versionId: V, idempotencyKey: KEY, answers: [], files: [] })).toContain(
      'files',
    );
    expect(
      fieldsOf({
        versionId: V,
        idempotencyKey: KEY,
        answers: [{ questionId: Q.short!.id, value: 'x', file: 'a' }],
      }),
    ).toContain('answers.0.file');
    expect(fieldsOf({ versionId: 'x', idempotencyKey: KEY, answers: [] })).toContain('versionId');
    expect(
      fieldsOf({
        versionId: V,
        idempotencyKey: KEY,
        answers: Array.from({ length: 101 }, () => ({ questionId: V, value: '' })),
      }),
    ).toContain('answers');
    expect(
      fieldsOf({ versionId: V, idempotencyKey: KEY, answers: [{ questionId: V, value: 5 }] }),
    ).toContain('answers.0.value');
  });
});

describe('requestHash', () => {
  const base = {
    versionId: V,
    idempotencyKey: KEY,
    answers: [
      { questionId: id(1), value: ' أ ' },
      { questionId: id(4), value: [id(43), id(41)] },
    ],
  };
  it('ثابت للمحتوى نفسه بغض النظر عن الترتيب والمسافات', () => {
    const shuffled = {
      ...base,
      answers: [
        { questionId: id(4), value: [id(41), id(43)] },
        { questionId: id(1), value: 'أ' },
      ],
    };
    expect(requestHash(parseSubmitResponse(base))).toBe(requestHash(parseSubmitResponse(shuffled)));
  });
  it('يتغير بتغير المحتوى أو الإصدار', () => {
    const h = requestHash(parseSubmitResponse(base));
    expect(
      requestHash(parseSubmitResponse({ ...base, answers: [{ questionId: id(1), value: 'ب' }] })),
    ).not.toBe(h);
    expect(requestHash(parseSubmitResponse({ ...base, versionId: id(777) }))).not.toBe(h);
  });
});

describe('generateReferenceCode', () => {
  it('صيغة XXXX-XXXX-XXXX عشوائية وغير متسلسلة', () => {
    const codes = new Set(Array.from({ length: 2000 }, generateReferenceCode));
    expect(codes.size).toBe(2000);
    for (const c of [...codes].slice(0, 50))
      expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });
});

describe('publishBlockers', () => {
  const draft = (questions: unknown[]) =>
    ({
      id: 'd',
      formId: 'f',
      title: 'ن',
      description: null,
      revision: 3,
      updatedById: 'u',
      createdAt: new Date(),
      updatedAt: new Date(),
      questions,
    }) as never;
  const q = (type: string, extra: object = {}) => ({
    id: id(Math.floor(Math.random() * 1e6)),
    draftId: 'd',
    position: 0,
    type,
    title: 'سؤال',
    description: null,
    required: false,
    settings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    options: [],
    ...extra,
  });
  it('يمنع النموذج الفارغ وسؤال الملفات والإعدادات غير الصحيحة', () => {
    expect(publishBlockers(draft([]))).toEqual(['لا يمكن نشر نموذج بلا أسئلة.']);
    expect(
      publishBlockers(
        draft([
          q('FILE_UPLOAD', { settings: { allowedTypes: ['pdf'], maxFileSizeMb: 1, maxFiles: 1 } }),
        ]),
      )[0],
    ).toMatch(/رفع ملفات/);
    expect(
      publishBlockers(draft([q('SHORT_TEXT', { settings: { minLength: 9, maxLength: 1 } })]))[0],
    ).toMatch(/غير صحيحة/);
    expect(publishBlockers(draft([q('SHORT_TEXT')]))).toEqual([]);
  });
});
