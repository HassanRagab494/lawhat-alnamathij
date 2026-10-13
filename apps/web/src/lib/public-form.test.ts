import { expect, it } from 'vitest';
import { buildPayload, carryOverAnswers, mapServerErrors, type PublicForm } from './public-form';

const form: PublicForm = {
  publicId: 'p',
  title: 't',
  description: null,
  acceptingResponses: true,
  versionId: 'v1',
  questions: [
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      key: 'k-num',
      type: 'NUMBER',
      title: 'رقم',
      description: null,
      required: false,
      settings: {},
      options: [],
    },
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000002',
      key: 'k-multi',
      type: 'MULTIPLE_CHOICE',
      title: 'متعدد',
      description: null,
      required: false,
      settings: {},
      options: [
        { id: 'o1', key: 'ok1', label: 'أ' },
        { id: 'o2', key: 'ok2', label: 'ب' },
      ],
    },
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000003',
      key: 'k-file',
      type: 'FILE_UPLOAD',
      title: 'ملف',
      description: null,
      required: false,
      settings: {},
      options: [],
    },
  ],
};

it('builds payload with version ids, drops empties and never sends file data', () => {
  const payload = buildPayload(
    form,
    { 'k-num': ' 12.5 ', 'k-multi': ['ok2', 'gone'], 'k-file': 'C:\\x.pdf', unknown: 'x' },
    'key',
  );
  expect(payload).toEqual({
    versionId: 'v1',
    idempotencyKey: 'key',
    answers: [
      { questionId: 'aaaaaaaa-0000-4000-8000-000000000001', value: '12.5' },
      { questionId: 'aaaaaaaa-0000-4000-8000-000000000002', value: ['o2'] },
    ],
  });
  expect(buildPayload(form, { 'k-num': '   ', 'k-multi': [] }, 'k').answers).toEqual([]);
});

it('carries answers to a new version by logical key and drops incompatible values', () => {
  const next: PublicForm = {
    ...form,
    versionId: 'v2',
    questions: [
      { ...form.questions[1]!, options: [{ id: 'n1', key: 'ok1', label: 'أ' }] },
      { ...form.questions[0]!, key: 'k-num', type: 'DROPDOWN', options: [] },
    ],
  };
  expect(carryOverAnswers(next, { 'k-num': '5', 'k-multi': ['ok1', 'ok2'], removed: 'x' })).toEqual(
    { 'k-multi': ['ok1'] },
  );
});

it('maps server field errors to question keys and keeps the rest general', () => {
  const result = mapServerErrors(form, [
    { field: 'answers.AAAAAAAA-0000-4000-8000-000000000001', message: 'أدخل رقمًا صحيحًا.' },
    { field: 'answers.0.questionId', message: 'هذا السؤال لا يخص الإصدار الحالي.' },
  ]);
  expect(result.byQuestion).toEqual({ 'k-num': 'أدخل رقمًا صحيحًا.' });
  expect(result.general).toEqual(['هذا السؤال لا يخص الإصدار الحالي.']);
});
