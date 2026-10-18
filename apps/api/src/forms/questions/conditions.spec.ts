import { AppError } from '../../common/errors';
import { validateAgainstVersion } from '../../public/response-schema';
import { parseSaveDraft } from './draft-schema';
import { readShowIf, versionConditions, visibleQuestionIds } from './visibility';

const choice = (title: string, labels = ['نعم', 'لا']) => ({
  type: 'SINGLE_CHOICE',
  title,
  required: true,
  settings: {},
  options: labels.map((label) => ({ label })),
});
const text = (title: string, showIf?: unknown, required = false) => ({
  type: 'SHORT_TEXT',
  title,
  required,
  settings: {},
  ...(showIf !== undefined ? { showIf } : {}),
});

function fieldsOf(fn: () => unknown): Record<string, string> {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) {
      const fields = (e.getResponse() as { fields?: { field: string; message: string }[] }).fields;
      return Object.fromEntries((fields ?? []).map((f) => [f.field, f.message]));
    }
    throw e;
  }
  throw new Error('expected validation error');
}

describe('شروط الظهور في حفظ المسودة', () => {
  it('يقبل شرطًا على سؤال اختيار سابق ويطبّعه', () => {
    const draft = parseSaveDraft({
      revision: 1,
      title: 'ن',
      questions: [choice('س1'), text('س2', { questionIndex: 0, optionIndexes: [1] })],
    });
    expect(draft.questions[1]!.showIf).toEqual({ questionIndex: 0, optionIndexes: [1] });
    expect(draft.questions[0]!.showIf).toBeNull();
  });

  it.each([
    [
      'سؤال لاحق (دورة)',
      [text('س1', { questionIndex: 1, optionIndexes: [0] }), choice('س2')],
      'questions.0.showIf.questionIndex',
    ],
    [
      'السؤال نفسه',
      [choice('س1'), text('س2', { questionIndex: 1, optionIndexes: [0] })],
      'questions.1.showIf.questionIndex',
    ],
    [
      'سؤال غير اختياري',
      [text('س1'), text('س2', { questionIndex: 0, optionIndexes: [0] })],
      'questions.1.showIf.questionIndex',
    ],
    [
      'خيار غير موجود',
      [choice('س1'), text('س2', { questionIndex: 0, optionIndexes: [5] })],
      'questions.1.showIf.optionIndexes',
    ],
    [
      'خيار مكرر',
      [choice('س1'), text('س2', { questionIndex: 0, optionIndexes: [0, 0] })],
      'questions.1.showIf.optionIndexes',
    ],
    [
      'بلا خيارات',
      [choice('س1'), text('س2', { questionIndex: 0, optionIndexes: [] })],
      'questions.1.showIf.optionIndexes',
    ],
  ])('يرفض الشرط: %s', (_name, questions, field) => {
    const errors = fieldsOf(() => parseSaveDraft({ revision: 1, title: 'ن', questions }));
    expect(errors[field]).toMatch(/[؀-ۿ]/);
  });

  it('يرفض الهوية الدلالية المكررة أو غير الصالحة', () => {
    const duplicate = fieldsOf(() =>
      parseSaveDraft({
        revision: 1,
        title: 'ن',
        questions: [
          { ...text('س1'), semanticKey: 'offer.price' },
          { ...text('س2'), semanticKey: 'offer.price' },
        ],
      }),
    );
    expect(duplicate['questions.1.semanticKey']).toBe('الهوية الدلالية مكررة في النموذج.');
    const invalid = fieldsOf(() =>
      parseSaveDraft({
        revision: 1,
        title: 'ن',
        questions: [{ ...text('س1'), semanticKey: 'Bad Key' }],
      }),
    );
    expect(invalid['questions.0.semanticKey']).toBe('الهوية الدلالية غير صالحة.');
  });
});

describe('الظهور', () => {
  const qs = [
    { id: 'a', showIf: null },
    { id: 'b', showIf: { questionId: 'a', optionIds: ['a1'] } },
    { id: 'c', showIf: { questionId: 'b', optionIds: ['b1'] } },
  ];

  it('السؤال المخفي يخفي ما يعتمد عليه حتى لو بقيت له إجابة', () => {
    expect([
      ...visibleQuestionIds(
        qs,
        new Map([
          ['a', ['a1']],
          ['b', ['b1']],
        ]),
      ),
    ]).toEqual(['a', 'b', 'c']);
    expect([
      ...visibleQuestionIds(
        qs,
        new Map([
          ['a', ['a2']],
          ['b', ['b1']],
        ]),
      ),
    ]).toEqual(['a']);
  });

  it('يحوّل الشروط المنطقية إلى معرّفات الإصدار', () => {
    const map = versionConditions([
      {
        id: 'v1',
        logicalId: 'l1',
        showIf: null,
        options: [
          { id: 'vo1', logicalId: 'lo1' },
          { id: 'vo2', logicalId: 'lo2' },
        ],
      },
      { id: 'v2', logicalId: 'l2', showIf: { questionId: 'l1', optionIds: ['lo2'] }, options: [] },
    ]);
    expect(map.get('v2')).toEqual({ questionId: 'v1', optionIds: ['vo2'] });
    expect(readShowIf({ questionId: 1 })).toBeNull();
  });
});

describe('التحقق من الرد مع الشروط', () => {
  const Q = '00000000-0000-4000-8000-00000000000';
  const questions = [
    {
      id: `${Q}1`,
      type: 'SINGLE_CHOICE' as const,
      title: 'نوع',
      required: true,
      settings: {},
      options: [{ id: `${Q}a` }, { id: `${Q}b` }],
    },
    {
      id: `${Q}2`,
      type: 'SHORT_TEXT' as const,
      title: 'عرض',
      required: true,
      settings: {},
      options: [],
      showIf: { questionId: `${Q}1`, optionIds: [`${Q}a`] },
    },
    {
      id: `${Q}3`,
      type: 'FILE_UPLOAD' as const,
      title: 'صور',
      required: true,
      settings: { maxFiles: 3 },
      options: [],
      showIf: { questionId: `${Q}1`, optionIds: [`${Q}a`] },
    },
    {
      id: `${Q}4`,
      type: 'SHORT_TEXT' as const,
      title: 'طلب',
      required: true,
      settings: {},
      options: [],
      showIf: { questionId: `${Q}1`, optionIds: [`${Q}b`] },
    },
  ];

  it('السؤال المخفي ليس إجباريًا', () => {
    const out = validateAgainstVersion(questions, [
      { questionId: `${Q}1`, value: `${Q}b` },
      { questionId: `${Q}4`, value: 'أبحث عن شقة' },
    ]);
    expect(out.map((a) => a.questionId)).toEqual([`${Q}1`, `${Q}4`]);
  });

  it('يرفض إجابة أو ملفات مرسلة لسؤال فرع مخفي', () => {
    const errors = fieldsOf(() =>
      validateAgainstVersion(questions, [
        { questionId: `${Q}1`, value: `${Q}b` },
        { questionId: `${Q}2`, value: 'تلاعب' },
        { questionId: `${Q}3`, value: ['11111111-1111-4111-8111-111111111111'] },
        { questionId: `${Q}4`, value: 'طلب' },
      ]),
    );
    expect(errors[`answers.${Q}2`]).toBe('هذا السؤال غير ظاهر حسب إجاباتك، فلا تُقبل له إجابة.');
    expect(errors[`answers.${Q}3`]).toBe('هذا السؤال غير ظاهر حسب إجاباتك، فلا تُقبل له إجابة.');
  });

  it('السؤال الظاهر يبقى إجباريًا', () => {
    const errors = fieldsOf(() =>
      validateAgainstVersion(questions, [{ questionId: `${Q}1`, value: `${Q}a` }]),
    );
    expect(Object.keys(errors).sort()).toEqual([`answers.${Q}2`, `answers.${Q}3`]);
  });
});
