import { Prisma } from '@prisma/client';
import { toDetailDto } from './responses.service';

const q = (
  id: string,
  type: string,
  position: number,
  options: { id: string; label: string }[] = [],
) => ({
  id,
  versionId: 'v',
  logicalId: `l-${id}`,
  position,
  type,
  title: `سؤال ${id}`,
  description: null,
  required: false,
  settings: {},
  options: options.map((o, i) => ({ ...o, questionId: id, logicalId: `l-${o.id}`, position: i })),
});

function response(answers: unknown[]) {
  return {
    id: 'r',
    formId: 'f',
    versionId: 'v',
    referenceCode: 'AAAA-BBBB-CCCC',
    status: 'NEW',
    idempotencyKey: 'k',
    requestHash: 'h',
    submittedAt: new Date('2026-10-01T10:00:00.000Z'),
    form: { draft: { title: 'العنوان الحالي' } },
    version: {
      versionNumber: 1,
      title: 'العنوان المنشور',
      description: null,
      publishedAt: new Date('2026-09-01T00:00:00.000Z'),
      questions: [
        q('file', 'FILE_UPLOAD', 0),
        q('text', 'SHORT_TEXT', 1),
        q('num', 'NUMBER', 2),
        q('choice', 'DROPDOWN', 3, [
          { id: 'o1', label: 'أ' },
          { id: 'o2', label: 'ب' },
        ]),
        q('date', 'DATE', 4),
      ],
    },
    answers,
    statusChanges: [
      {
        fromStatus: 'NEW',
        toStatus: 'ACCEPTED',
        changedAt: new Date('2026-10-02T00:00:00.000Z'),
        changedBy: { displayName: 'مراجع' },
      },
    ],
  } as never;
}

const answer = (questionId: string, extra: object) => ({
  questionId,
  textValue: null,
  numberValue: null,
  dateValue: null,
  options: [],
  files: [],
  ...extra,
});

describe('toDetailDto', () => {
  it('يعرض كل نوع بطريقته، والملفات والفارغ برسائل واضحة، دون تعديل الترتيب', () => {
    const dto = toDetailDto(
      response([
        answer('file', {
          files: [{ id: 'fl1', originalName: 'سيرة.pdf', sizeBytes: 1200, kind: 'PDF' }],
        }),
        answer('num', { numberValue: new Prisma.Decimal('1000000.5000000000') }),
        answer('choice', { options: [{ optionId: 'o2' }] }),
        answer('date', { dateValue: new Date('2026-10-01T00:00:00.000Z') }),
      ]),
    );
    expect(dto.answers.map((a) => [a.questionId, a.kind, a.value ?? null])).toEqual([
      ['file', 'files', null],
      ['text', 'empty', null],
      ['num', 'number', '1000000.5'],
      ['choice', 'choice', null],
      ['date', 'date', '2026-10-01'],
    ]);
    expect(dto.answers[3]!.options).toEqual([
      { label: 'أ', selected: false },
      { label: 'ب', selected: true },
    ]);
    expect(dto.answers[0]!.files).toEqual([
      { id: 'fl1', name: 'سيرة.pdf', size: 1200, kind: 'PDF' },
    ]);
    expect(dto.formTitle).toBe('العنوان الحالي');
    expect(dto.version.title).toBe('العنوان المنشور');
    expect(dto.statusHistory).toEqual([
      {
        fromStatus: 'NEW',
        toStatus: 'ACCEPTED',
        changedBy: 'مراجع',
        changedAt: '2026-10-02T00:00:00.000Z',
      },
    ]);
  });

  it('إجابة اختيار بلا خيارات تُعرض فارغة، والنص يبقى نصًا خامًا', () => {
    const dto = toDetailDto(
      response([answer('choice', {}), answer('text', { textValue: '<b>نص</b>' })]),
    );
    expect(dto.answers.find((a) => a.questionId === 'choice')!.kind).toBe('empty');
    expect(dto.answers.find((a) => a.questionId === 'file')!.kind).toBe('empty');
    expect(dto.answers.find((a) => a.questionId === 'text')!.value).toBe('<b>نص</b>');
  });
});
