import { describe, expect, it } from 'vitest';
import { validateAnswer, type RenderQuestion } from './answer-validation';
import {
  changeQuestionType,
  fromServer,
  moveItem,
  newQuestion,
  rebaseOnServer,
  snapshot,
  toPayload,
  toRenderQuestions,
  validateDraft,
  type FormDraft,
} from './draft';

const server: FormDraft = {
  id: 'f',
  title: 'نموذج',
  description: null,
  publicationStatus: 'draft',
  publication: {
    publicId: null,
    acceptingResponses: false,
    latestVersion: null,
    hasUnpublishedChanges: true,
  },
  isArchived: false,
  revision: 3,
  createdBy: { id: 'u', displayName: 'مدير' },
  createdAt: '2026-10-13T00:00:00.000Z',
  updatedAt: '2026-10-13T00:00:00.000Z',
  archivedAt: null,
  questions: [
    {
      id: 'q1',
      type: 'MULTIPLE_CHOICE',
      title: 'الخدمات',
      description: null,
      required: true,
      settings: { minSelections: 1, maxSelections: 2 },
      options: [
        { id: 'o1', label: 'أ' },
        { id: 'o2', label: 'ب' },
        { id: 'o3', label: 'ج' },
      ],
    },
    {
      id: 'q2',
      type: 'NUMBER',
      title: 'العمر',
      description: 'بالسنوات',
      required: false,
      settings: { allowDecimals: false, min: 18 },
      options: [],
    },
  ],
};

describe('fromServer / toPayload', () => {
  it('ذهاب وعودة دون فقد بيانات، مع إرسال المعرّفات وإعدادات النوع فقط', () => {
    const payload = toPayload(fromServer(server), server.revision);
    expect(payload).toEqual({
      revision: 3,
      title: 'نموذج',
      description: null,
      questions: [
        {
          id: 'q1',
          type: 'MULTIPLE_CHOICE',
          title: 'الخدمات',
          description: null,
          required: true,
          settings: { minSelections: 1, maxSelections: 2 },
          options: [
            { id: 'o1', label: 'أ' },
            { id: 'o2', label: 'ب' },
            { id: 'o3', label: 'ج' },
          ],
        },
        {
          id: 'q2',
          type: 'NUMBER',
          title: 'العمر',
          description: 'بالسنوات',
          required: false,
          settings: { allowDecimals: false, min: 18 },
          options: [],
        },
      ],
    });
  });

  it('البصمة لا تتأثر بالمفاتيح المحلية وتتغير بتغيير المحتوى', () => {
    const a = fromServer(server);
    const b = fromServer(server);
    expect(snapshot(a)).toBe(snapshot(b));
    b.questions[0]!.required = false;
    expect(snapshot(a)).not.toBe(snapshot(b));
  });

  it('السؤال الجديد بلا معرّف خادم', () => {
    const d = fromServer(server);
    d.questions.push(newQuestion('DROPDOWN'));
    const p = toPayload(d, 3);
    expect(p.questions[2]!.id).toBeUndefined();
    expect(p.questions[2]!.options.every((o) => o.id === undefined)).toBe(true);
  });
});

describe('changeQuestionType', () => {
  const editor = () => fromServer(server);

  it('يحتفظ بالعنوان والوصف والإلزام ويمسح الإعدادات غير المتوافقة', () => {
    const q = editor().questions[1]!; // NUMBER
    const { question, losesData } = changeQuestionType(q, 'SHORT_TEXT');
    expect(question).toMatchObject({ title: 'العمر', description: 'بالسنوات', required: false });
    expect(question.settings.min).toBe('');
    expect(losesData).toBe(true); // min = 18 كان مُدخلًا
  });

  it('بين أنواع الاختيار تبقى الخيارات، وتُفقد حدود الاختيار المتعدد بتأكيد', () => {
    const q = editor().questions[0]!;
    const r = changeQuestionType(q, 'DROPDOWN');
    expect(r.question.options.map((o) => o.id)).toEqual(['o1', 'o2', 'o3']);
    expect(r.losesData).toBe(true);
    const noLimits = { ...q, settings: { ...q.settings, minSelections: '', maxSelections: '' } };
    expect(changeQuestionType(noLimits, 'SINGLE_CHOICE').losesData).toBe(false);
  });

  it('من اختيار إلى نص تُفقد الخيارات (يتطلب تأكيدًا)', () => {
    const r = changeQuestionType(editor().questions[0]!, 'PARAGRAPH');
    expect(r.question.options).toEqual([]);
    expect(r.losesData).toBe(true);
  });

  it('سؤال جديد بإعدادات افتراضية لا يحتاج تأكيدًا، وحدود الطول تنتقل بين النص والفقرة', () => {
    expect(changeQuestionType(newQuestion('FILE_UPLOAD'), 'DATE').losesData).toBe(false);
    const short = { ...newQuestion('SHORT_TEXT') };
    short.settings = { ...short.settings, maxLength: '40' };
    const r = changeQuestionType(short, 'PARAGRAPH');
    expect(r.question.settings.maxLength).toBe('40');
    expect(r.losesData).toBe(false);
    expect(
      changeQuestionType(newQuestion('NUMBER'), 'FILE_UPLOAD').question.settings.allowedTypes,
    ).toEqual(['pdf']);
  });
});

describe('validateDraft (مطابق لقواعد الخادم)', () => {
  it('مسودة سليمة بلا أخطاء، ومسودة دون أسئلة مقبولة', () => {
    expect(validateDraft(fromServer(server))).toEqual({});
    expect(validateDraft({ title: 'س', description: '', questions: [] })).toEqual({});
  });

  it('يعيد الأخطاء بمسارات الخادم', () => {
    const d = fromServer(server);
    d.title = '  ';
    d.questions[0]!.title = ' ';
    d.questions[0]!.options[1]!.label = ' أ ';
    d.questions[0]!.settings.maxSelections = '5';
    d.questions[1]!.settings.min = '1.5';
    d.questions.push({ ...newQuestion('FILE_UPLOAD'), title: 'ملف' });
    d.questions[2]!.settings.allowedTypes = [];
    d.questions[2]!.settings.maxFiles = '';
    d.questions.push({ ...newQuestion('DATE'), title: 'تاريخ' });
    d.questions[3]!.settings.minDate = '2026-02-30';
    expect(validateDraft(d)).toEqual({
      title: 'عنوان النموذج مطلوب.',
      'questions.0.title': 'عنوان السؤال مطلوب.',
      'questions.0.options.1.label': 'هذا الخيار مكرر.',
      'questions.0.settings.maxSelections': 'يتجاوز عدد الخيارات المتاحة.',
      'questions.1.settings.min': 'يجب أن يكون عددًا صحيحًا لأن الكسور غير مسموحة.',
      'questions.2.settings.allowedTypes': 'اختر نوع ملف واحدًا على الأقل.',
      'questions.2.settings.maxFiles': 'هذا الحقل مطلوب.',
      'questions.3.settings.minDate': 'التاريخ غير صالح.',
    });
  });

  it('يرفض سؤال اختيار بأقل من خيارين', () => {
    const q = newQuestion('SINGLE_CHOICE');
    q.title = 'سؤال';
    q.options = q.options.slice(0, 1);
    expect(
      validateDraft({ title: 'ن', description: '', questions: [q] })['questions.0.options'],
    ).toBe('أضف 2 خيارات على الأقل.');
  });
});

describe('التعارض والترتيب', () => {
  it('rebaseOnServer يزيل معرّفات الأسئلة والخيارات المحذوفة على الخادم ويحتفظ بالمحتوى', () => {
    const local = fromServer(server);
    local.questions[0]!.title = 'عنواني المحلي';
    const latest: FormDraft = {
      ...server,
      revision: 5,
      questions: [{ ...server.questions[0]!, options: server.questions[0]!.options.slice(0, 2) }],
    };
    const rebased = rebaseOnServer(local, latest);
    expect(rebased.questions[0]!.title).toBe('عنواني المحلي');
    expect(rebased.questions[0]!.options.map((o) => o.id)).toEqual(['o1', 'o2', undefined]);
    expect(rebased.questions[1]!.id).toBeUndefined();
  });

  it('moveItem ينقل ولا يتجاوز الحدود', () => {
    expect(moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
  });
});

describe('المعاينة والتحقق من الإجابات', () => {
  const qs = toRenderQuestions(fromServer(server));
  const [multi, age] = qs as [RenderQuestion, RenderQuestion];

  it('تحوّل الإعدادات إلى قيم رقمية', () => {
    expect(age.settings).toEqual({ allowDecimals: false, min: 18 });
  });

  it('تتحقق حسب الإعدادات', () => {
    expect(validateAnswer(multi, [])).toBe('هذا السؤال إجباري.');
    expect(
      validateAnswer(
        multi,
        multi.options.map((o) => o.key),
      ),
    ).toBe('اختر 2 كحد أقصى.');
    expect(validateAnswer(multi, [multi.options[0]!.key])).toBeNull();
    expect(validateAnswer(age, '')).toBeNull();
    expect(validateAnswer(age, '17')).toBe('يجب ألا يقل الرقم عن 18.');
    expect(validateAnswer(age, '20.5')).toBe('أدخل عددًا صحيحًا دون كسور.');
    expect(validateAnswer(age, 'abc')).toBe('أدخل رقمًا صحيحًا.');
  });

  it('النص والتاريخ والملفات', () => {
    const text: RenderQuestion = {
      key: 't',
      type: 'SHORT_TEXT',
      title: 'س',
      description: null,
      required: false,
      settings: { minLength: 3, maxLength: 5 },
      options: [],
    };
    expect(validateAnswer(text, 'ab')).toMatch(/3/);
    expect(validateAnswer(text, 'abcdef')).toMatch(/5/);
    const date: RenderQuestion = { ...text, type: 'DATE', settings: { minDate: '2026-01-01' } };
    expect(validateAnswer(date, '2025-12-31')).toMatch(/قبل/);
    const file: RenderQuestion = { ...text, type: 'FILE_UPLOAD', required: true, settings: {} };
    expect(validateAnswer(file, undefined)).toBeNull();
  });
});
