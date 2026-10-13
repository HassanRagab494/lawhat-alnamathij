import { HttpException } from '@nestjs/common';
import type { ApiErrorBody } from '../../common/errors';
import { parseSaveDraft } from './draft-schema';
import { QUESTION_LIMITS as L } from './limits';

const ID1 = '0190d6b4-0000-7000-8000-000000000001';
const ID2 = '0190d6b4-0000-7000-8000-000000000002';

function draft(questions: unknown[], extra: Record<string, unknown> = {}) {
  return { revision: 1, title: 'نموذج', description: null, questions, ...extra };
}

const valid = {
  short: {
    type: 'SHORT_TEXT',
    title: 'الاسم',
    required: true,
    settings: { minLength: 2, maxLength: 50 },
  },
  paragraph: { type: 'PARAGRAPH', title: 'ملاحظات', required: false, settings: {} },
  single: {
    type: 'SINGLE_CHOICE',
    title: 'المدينة',
    required: true,
    settings: {},
    options: [{ label: 'الرياض' }, { label: 'جدة' }],
  },
  multiple: {
    type: 'MULTIPLE_CHOICE',
    title: 'الخدمات',
    required: false,
    settings: { minSelections: 1, maxSelections: 2 },
    options: [{ label: 'أ' }, { label: 'ب' }, { label: 'ج' }],
  },
  dropdown: {
    type: 'DROPDOWN',
    title: 'القسم',
    required: false,
    settings: {},
    options: [{ label: 'المالية' }, { label: 'الموارد البشرية' }],
  },
  number: {
    type: 'NUMBER',
    title: 'العمر',
    required: true,
    settings: { allowDecimals: false, min: 18, max: 65 },
  },
  date: {
    type: 'DATE',
    title: 'تاريخ البدء',
    required: false,
    settings: { minDate: '2026-01-01', maxDate: '2026-12-31' },
  },
  file: {
    type: 'FILE_UPLOAD',
    title: 'السيرة الذاتية',
    required: false,
    settings: { allowedTypes: ['pdf', 'docx'], maxFileSizeMb: 5, maxFiles: 1 },
  },
};

function errorsOf(body: unknown): Record<string, string> {
  try {
    parseSaveDraft(body);
  } catch (error) {
    const res = (error as HttpException).getResponse() as ApiErrorBody;
    expect(res.code).toBe('VALIDATION_FAILED');
    return Object.fromEntries((res.fields ?? []).map((f) => [f.field, f.message]));
  }
  throw new Error('expected validation failure');
}

describe('parseSaveDraft', () => {
  it('يقبل الأنواع الثمانية ويطبّع النصوص', () => {
    const out = parseSaveDraft(
      draft([
        { ...valid.short, title: '  الاسم  ', description: '   ' },
        valid.paragraph,
        { ...valid.single, options: [{ label: ' الرياض ' }, { label: 'جدة' }] },
        valid.multiple,
        valid.dropdown,
        valid.number,
        valid.date,
        valid.file,
      ]),
    );
    expect(out.questions).toHaveLength(8);
    expect(out.questions[0]!.title).toBe('الاسم');
    expect(out.questions[0]!.description).toBeNull();
    expect((out.questions[2]!.options as { label: string }[])[0]!.label).toBe('الرياض');
    expect(out.questions[1]!.options).toEqual([]);
  });

  it('يسمح بمسودة دون أسئلة', () => {
    expect(parseSaveDraft(draft([])).questions).toEqual([]);
  });

  it('يرفض عنوان سؤال فارغًا أو مسافات', () => {
    expect(errorsOf(draft([{ ...valid.short, title: '   ' }]))['questions.0.title']).toBe(
      'عنوان السؤال مطلوب.',
    );
  });

  it('يرفض نوعًا غير معروف', () => {
    expect(errorsOf(draft([{ ...valid.short, type: 'SIGNATURE' }]))['questions.0.type']).toBe(
      'نوع السؤال غير معروف.',
    );
  });

  it('يرفض إعدادات لا تخص النوع وحقولًا غير معروفة', () => {
    const e = errorsOf(draft([{ ...valid.short, settings: { allowDecimals: true } }]));
    expect(e['questions.0.settings.allowDecimals']).toBe('إعدادات لا تخص نوع السؤال.');
    expect(errorsOf(draft([{ ...valid.short, color: 'red' }]))['questions.0.color']).toBe(
      'حقل غير مسموح به.',
    );
    expect(errorsOf(draft([], { hack: 1 }))['hack']).toBe('حقل غير مسموح به.');
  });

  it('يرفض خيارات لسؤال ليس من أنواع الاختيار', () => {
    expect(
      errorsOf(draft([{ ...valid.number, options: [{ label: 'أ' }] }]))['questions.0.options'],
    ).toBe('هذا النوع لا يقبل خيارات.');
  });

  it('يرفض خيارات فارغة أو مكررة بعد إزالة المسافات، وأقل من خيارين', () => {
    expect(
      errorsOf(draft([{ ...valid.single, options: [{ label: 'أ' }, { label: '  ' }] }]))[
        'questions.0.options.1.label'
      ],
    ).toBe('نص الخيار مطلوب.');
    expect(
      errorsOf(draft([{ ...valid.single, options: [{ label: 'نعم' }, { label: ' نعم ' }] }]))[
        'questions.0.options.1.label'
      ],
    ).toBe('هذا الخيار مكرر.');
    expect(
      errorsOf(draft([{ ...valid.dropdown, options: [{ label: 'وحيد' }] }]))['questions.0.options'],
    ).toMatch(/2 خيارات على الأقل/);
  });

  it('يرفض حدًا أدنى يتجاوز الأقصى في النص والرقم والتاريخ والاختيار المتعدد', () => {
    expect(
      errorsOf(draft([{ ...valid.short, settings: { minLength: 10, maxLength: 5 } }]))[
        'questions.0.settings.minLength'
      ],
    ).toBeDefined();
    expect(
      errorsOf(draft([{ ...valid.number, settings: { allowDecimals: true, min: 5, max: 1 } }]))[
        'questions.0.settings.min'
      ],
    ).toBeDefined();
    expect(
      errorsOf(
        draft([{ ...valid.date, settings: { minDate: '2026-12-31', maxDate: '2026-01-01' } }]),
      )['questions.0.settings.minDate'],
    ).toBeDefined();
    expect(
      errorsOf(draft([{ ...valid.multiple, settings: { minSelections: 3, maxSelections: 2 } }]))[
        'questions.0.settings.minSelections'
      ],
    ).toBeDefined();
  });

  it('يرفض حدود اختيار متعدد تتجاوز عدد الخيارات', () => {
    expect(
      errorsOf(draft([{ ...valid.multiple, settings: { maxSelections: 4 } }]))[
        'questions.0.settings.maxSelections'
      ],
    ).toBe('يتجاوز عدد الخيارات المتاحة.');
  });

  it('يرفض تواريخ غير صالحة أو خارج النطاق', () => {
    expect(
      errorsOf(draft([{ ...valid.date, settings: { minDate: '2026-02-30' } }]))[
        'questions.0.settings.minDate'
      ],
    ).toBe('التاريخ غير صالح.');
    expect(
      errorsOf(draft([{ ...valid.date, settings: { maxDate: '2200-01-01' } }]))[
        'questions.0.settings.maxDate'
      ],
    ).toMatch(/بين/);
  });

  it('يرفض أعدادًا غير منتهية أو خارج الحدود أو كسورًا مع منع الكسور', () => {
    expect(
      errorsOf(draft([{ ...valid.number, settings: { allowDecimals: true, max: 1e15 } }]))[
        'questions.0.settings.max'
      ],
    ).toBe('القيمة خارج الحدود المسموحة.');
    expect(
      errorsOf(draft([{ ...valid.number, settings: { allowDecimals: false, min: 1.5 } }]))[
        'questions.0.settings.min'
      ],
    ).toMatch(/عددًا صحيحًا/);
    expect(
      errorsOf(draft([{ ...valid.short, settings: { maxLength: L.shortTextMaxLength + 1 } }]))[
        'questions.0.settings.maxLength'
      ],
    ).toBeDefined();
    expect(
      errorsOf(draft([{ ...valid.number, settings: { allowDecimals: true, min: '5' } }]))[
        'questions.0.settings.min'
      ],
    ).toBe('القيمة غير صحيحة.');
    expect(
      errorsOf(draft([{ ...valid.number, settings: { min: 1 } }]))[
        'questions.0.settings.allowDecimals'
      ],
    ).toBeDefined();
  });

  it('سؤال الملفات: يتطلب أنواعًا من القائمة الآمنة وحجمًا وعددًا ضمن الحدود', () => {
    expect(
      errorsOf(
        draft([{ ...valid.file, settings: { ...valid.file.settings, allowedTypes: ['exe'] } }]),
      )['questions.0.settings.allowedTypes.0'],
    ).toBe('نوع ملف غير مسموح.');
    expect(
      errorsOf(draft([{ ...valid.file, settings: { allowedTypes: ['pdf'], maxFiles: 1 } }]))[
        'questions.0.settings.maxFileSizeMb'
      ],
    ).toBe('هذا الحقل مطلوب.');
    expect(
      errorsOf(
        draft([
          {
            ...valid.file,
            settings: { ...valid.file.settings, maxFileSizeMb: L.fileMaxSizeMb + 1 },
          },
        ]),
      )['questions.0.settings.maxFileSizeMb'],
    ).toBeDefined();
  });

  it('يرفض معرّفات مكررة أو غير صالحة', () => {
    const e = errorsOf(
      draft([
        { ...valid.short, id: ID1 },
        { ...valid.paragraph, id: ID1 },
      ]),
    );
    expect(e['questions.1.id']).toBe('معرّف السؤال مكرر.');
    expect(
      errorsOf(
        draft([
          {
            ...valid.single,
            options: [
              { id: ID2, label: 'أ' },
              { id: ID2, label: 'ب' },
            ],
          },
        ]),
      )['questions.0.options.1.id'],
    ).toBe('معرّف الخيار مكرر.');
    expect(errorsOf(draft([{ ...valid.short, id: '1' }]))['questions.0.id']).toBe(
      'معرّف غير صالح.',
    );
  });

  it('يفرض الحدود المركزية لعدد الأسئلة والخيارات', () => {
    const many = Array.from({ length: L.maxQuestions + 1 }, () => valid.paragraph);
    expect(errorsOf(draft(many))['questions']).toMatch(/الحد الأقصى/);
    const options = Array.from({ length: L.maxOptions + 1 }, (_, i) => ({ label: `خيار ${i}` }));
    expect(errorsOf(draft([{ ...valid.single, options }]))['questions.0.options']).toMatch(
      /الحد الأقصى/,
    );
  });
});
