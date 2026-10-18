import { describe, expect, it } from 'vitest';
import { validateAnswers, visibleKeys, type RenderQuestion } from './answer-validation';
import {
  clearConditionsOn,
  dependentsOf,
  fromServer,
  newQuestion,
  toPayload,
  validateDraft,
  type FormDraft,
} from './draft';
import { buildPayload, toRenderQuestions, type PublicForm } from './public-form';

const q = (key: string, extra: Partial<RenderQuestion> = {}): RenderQuestion => ({
  key,
  type: 'SHORT_TEXT',
  title: key,
  description: null,
  required: false,
  settings: {},
  options: [],
  ...extra,
});

const kind = q('kind', {
  type: 'SINGLE_CHOICE',
  required: true,
  options: [
    { key: 'offer', label: 'عرض عقار' },
    { key: 'request', label: 'طلب عقار' },
  ],
});
const price = q('price', {
  required: true,
  showIf: { questionKey: 'kind', optionKeys: ['offer'] },
});
const budget = q('budget', {
  required: true,
  showIf: { questionKey: 'kind', optionKeys: ['request'] },
});
const category = q('category', {
  type: 'DROPDOWN',
  showIf: { questionKey: 'kind', optionKeys: ['offer'] },
  options: [
    { key: 'apt', label: 'شقة' },
    { key: 'land', label: 'أرض' },
  ],
});
const rooms = q('rooms', { showIf: { questionKey: 'category', optionKeys: ['apt'] } });
const questions = [kind, price, budget, category, rooms];

describe('الظهور في الواجهة', () => {
  it('قبل الاختيار يظهر السؤال الأول فقط، ثم أسئلة المسار المختار', () => {
    expect([...visibleKeys(questions, {})]).toEqual(['kind']);
    expect([...visibleKeys(questions, { kind: 'offer', category: 'apt' })]).toEqual([
      'kind',
      'price',
      'category',
      'rooms',
    ]);
    expect([...visibleKeys(questions, { kind: 'request', category: 'apt' })]).toEqual([
      'kind',
      'budget',
    ]);
  });

  it('السؤال المخفي ليس إجباريًا، والظاهر يبقى إجباريًا', () => {
    expect(validateAnswers(questions, { kind: 'request' })).toEqual({
      budget: 'هذا السؤال إجباري.',
    });
  });
});

describe('الإرسال لا يتضمن الفرع غير النشط', () => {
  const pq = (rq: RenderQuestion, id: string) => ({
    id,
    key: rq.key,
    type: rq.type,
    title: rq.title,
    description: null,
    required: rq.required,
    settings: rq.settings,
    options: rq.options.map((o, i) => ({ id: `${id}-o${i}`, key: o.key, label: o.label })),
    showIf: rq.showIf ?? null,
  });
  const form: PublicForm = {
    publicId: 'p',
    title: 't',
    description: null,
    acceptingResponses: true,
    versionId: 'v',
    questions: [pq(kind, 'q1'), pq(price, 'q2'), pq(budget, 'q3')],
  };

  it('إجابات الفرع السابق تبقى في الصفحة لكن لا تُرسل', () => {
    const payload = buildPayload(form, { kind: 'request', price: '900000', budget: '500000' }, 'k');
    expect(payload.answers).toEqual([
      { questionId: 'q1', value: 'q1-o1' },
      { questionId: 'q3', value: '500000' },
    ]);
    expect(toRenderQuestions(form)[1]!.showIf).toEqual({
      questionKey: 'kind',
      optionKeys: ['offer'],
    });
  });
});

describe('الشروط في المحرر', () => {
  const server: FormDraft = {
    id: 'f',
    title: 'ن',
    description: null,
    questions: [
      {
        id: 'a',
        type: 'SINGLE_CHOICE',
        title: 'وش ترغب تسجّل؟',
        description: null,
        required: true,
        settings: {},
        semanticKey: 'listing.kind',
        options: [
          { id: 'a1', label: 'عرض عقار', semanticKey: 'offer' },
          { id: 'a2', label: 'طلب عقار', semanticKey: 'request' },
        ],
      },
      {
        id: 'b',
        type: 'SHORT_TEXT',
        title: 'المدينة',
        description: null,
        required: true,
        settings: {},
        options: [],
        showIf: { questionId: 'a', optionIds: ['a2'] },
      },
    ],
  } as unknown as FormDraft;

  it('من الخادم بالمعرّفات إلى المواقع عند الحفظ، مع الإبقاء على الهويات الدلالية', () => {
    const editor = fromServer(server);
    expect(editor.questions[1]!.showIf).toEqual({
      questionKey: editor.questions[0]!.key,
      optionKeys: [editor.questions[0]!.options[1]!.key],
    });
    const payload = toPayload(editor, 3);
    expect(payload.questions[1]).toMatchObject({
      showIf: { questionIndex: 0, optionIndexes: [1] },
    });
    expect(payload.questions[0]).toMatchObject({
      semanticKey: 'listing.kind',
      options: [
        { id: 'a1', label: 'عرض عقار', semanticKey: 'offer' },
        { id: 'a2', label: 'طلب عقار', semanticKey: 'request' },
      ],
    });
    expect(payload.questions[0]).not.toHaveProperty('showIf');
  });

  it('يرفض شرطًا على سؤال لاحق أو غير اختياري أو بلا خيارات', () => {
    const editor = fromServer(server);
    const [first, second] = editor.questions;
    // نقل السؤال المشروط قبل سؤاله المرجعي
    expect(validateDraft({ ...editor, questions: [second!, first!] })['questions.0.showIf']).toBe(
      'الشرط يجب أن يعتمد على سؤال سابق لهذا السؤال.',
    );
    const text = newQuestion('SHORT_TEXT');
    const onText = {
      ...newQuestion('SHORT_TEXT'),
      showIf: { questionKey: text.key, optionKeys: [] },
    };
    expect(validateDraft({ ...editor, questions: [text, onText] })['questions.1.showIf']).toMatch(
      /سؤال اختيار/,
    );
    const empty = { ...second!, showIf: { questionKey: first!.key, optionKeys: [] } };
    expect(validateDraft({ ...editor, questions: [first!, empty] })['questions.1.showIf']).toBe(
      'اختر خيارًا واحدًا على الأقل يُظهر هذا السؤال.',
    );
  });

  it('حذف سؤال يزيل الشروط المعتمدة عليه', () => {
    const editor = fromServer(server);
    const key = editor.questions[0]!.key;
    expect(dependentsOf(editor, key)).toHaveLength(1);
    expect(clearConditionsOn(editor.questions.slice(1), key)[0]!.showIf).toBeNull();
  });
});
