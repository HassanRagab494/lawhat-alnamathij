import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FormRenderer } from '@/components/form-renderer';
import type { PublicForm } from '@/lib/public-form';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: apiMock,
}));
import { ApiError } from '@/lib/api';
import { PublicFormView } from './public-form-view';

const Q_NAME = '11111111-1111-4111-8111-111111111111';
const Q_CITY = '22222222-2222-4222-8222-222222222222';
const O_RIYADH = '33333333-3333-4333-8333-333333333333';

function makeForm(overrides: Partial<PublicForm> = {}): PublicForm {
  return {
    publicId: 'pub_abcdefghijklmnop',
    title: 'استبيان الرضا',
    description: 'وصف قصير',
    acceptingResponses: true,
    versionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    questions: [
      {
        id: Q_NAME,
        key: 'logical-name',
        type: 'SHORT_TEXT',
        title: 'الاسم',
        description: null,
        required: true,
        settings: {},
        options: [],
      },
      {
        id: Q_CITY,
        key: 'logical-city',
        type: 'SINGLE_CHOICE',
        title: 'المدينة',
        description: null,
        required: false,
        settings: {},
        options: [
          { id: O_RIYADH, key: 'logical-riyadh', label: 'الرياض' },
          { id: '44444444-4444-4444-8444-444444444444', key: 'logical-jeddah', label: 'جدة' },
        ],
      },
    ],
    ...overrides,
  };
}

function submitCalls() {
  return apiMock.mock.calls.filter(([, opts]) => opts?.method === 'POST');
}

beforeEach(() => {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  apiMock.mockReset();
});
afterEach(() => cleanup());

async function renderReady(form = makeForm()) {
  apiMock.mockResolvedValueOnce(form);
  render(<PublicFormView publicId={form.publicId} />);
  return (await screen.findByRole('textbox', { name: /الاسم/ })) as HTMLInputElement;
}

it('shows only the public form (no admin tools or preview banner) and validates locally', async () => {
  await renderReady();
  expect(screen.getByRole('heading', { level: 1, name: 'استبيان الرضا' })).toBeTruthy();
  expect(screen.queryByText(/معاينة/)).toBeNull();
  expect(screen.queryByText(/تعديل|أرشفة|نشر/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'إرسال' }));
  expect(await screen.findByText('هذا السؤال إجباري.')).toBeTruthy();
  expect(submitCalls()).toHaveLength(0);
});

it('submits version ids, ignores double clicks, and shows the reference code', async () => {
  const name = await renderReady();
  fireEvent.change(name, { target: { value: '  سارة  ' } });
  fireEvent.click(screen.getByRole('radio', { name: 'الرياض' }));
  let resolve!: (v: unknown) => void;
  apiMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
  const button = screen.getByRole('button', { name: 'إرسال' });
  fireEvent.click(button);
  fireEvent.click(button);
  fireEvent.submit(button.closest('form')!);
  await waitFor(() => expect(submitCalls()).toHaveLength(1));
  const [path, opts] = submitCalls()[0]!;
  expect(path).toBe('/public/forms/pub_abcdefghijklmnop/responses');
  expect(opts.body).toMatchObject({
    versionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    answers: [
      { questionId: Q_NAME, value: 'سارة' },
      { questionId: Q_CITY, value: O_RIYADH },
    ],
  });
  expect(opts.body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  resolve({ referenceCode: 'K7Q2-M9XD-4TPB', submittedAt: '2026-10-13T10:00:00.000Z' });
  expect(await screen.findByText('K7Q2-M9XD-4TPB')).toBeTruthy();
  expect(screen.getByText('تم إرسال ردك بنجاح')).toBeTruthy();
  expect(window.location.href).not.toContain('K7Q2');
});

it('keeps answers on network failure and retries with the same idempotency key', async () => {
  const name = await renderReady();
  fireEvent.change(name, { target: { value: 'سارة' } });
  apiMock.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'تعذر الاتصال بالخادم.'));
  fireEvent.click(screen.getByRole('button', { name: 'إرسال' }));
  expect(await screen.findByText(/إجاباتك ما زالت في الصفحة/)).toBeTruthy();
  expect(name.value).toBe('سارة');

  apiMock.mockResolvedValueOnce({ referenceCode: 'AAAA-BBBB-CCCC', submittedAt: 'x' });
  fireEvent.click(screen.getByRole('button', { name: 'إرسال' }));
  await screen.findByText('AAAA-BBBB-CCCC');
  const [first, second] = submitCalls();
  expect(second![1].body.idempotencyKey).toBe(first![1].body.idempotencyKey);
});

it('uses a new idempotency key when answers change after a failure', async () => {
  const name = await renderReady();
  fireEvent.change(name, { target: { value: 'سارة' } });
  apiMock.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'تعذر الاتصال بالخادم.'));
  fireEvent.click(screen.getByRole('button', { name: 'إرسال' }));
  await screen.findByText(/إجاباتك ما زالت في الصفحة/);
  fireEvent.change(name, { target: { value: 'سارة علي' } });
  apiMock.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'تعذر الاتصال بالخادم.'));
  fireEvent.click(screen.getByRole('button', { name: 'إرسال' }));
  await waitFor(() => expect(submitCalls()).toHaveLength(2));
  const [first, second] = submitCalls();
  expect(second![1].body.idempotencyKey).not.toBe(first![1].body.idempotencyKey);
});

it('shows server validation errors next to the matching question and keeps answers', async () => {
  const name = await renderReady();
  fireEvent.change(name, { target: { value: 'س' } });
  apiMock.mockRejectedValueOnce(
    new ApiError(400, 'VALIDATION_FAILED', 'بعض البيانات المدخلة غير صحيحة.', [
      { field: `answers.${Q_NAME}`, message: 'يجب ألا تقل الإجابة عن 2 حرف.' },
    ]),
  );
  fireEvent.click(screen.getByRole('button', { name: 'إرسال' }));
  const error = await screen.findByText('يجب ألا تقل الإجابة عن 2 حرف.');
  expect(name.getAttribute('aria-describedby')).toContain(error.id);
  expect(name.value).toBe('س');
});

it('on outdated version: blocks submit, keeps answers, refreshes on request without auto-submit', async () => {
  const name = await renderReady();
  fireEvent.change(name, { target: { value: 'سارة' } });
  fireEvent.click(screen.getByRole('radio', { name: 'الرياض' }));
  apiMock.mockRejectedValueOnce(
    new ApiError(409, 'VERSION_OUTDATED', 'نُشر تحديث لهذا النموذج بعد أن فتحته، فلم يُرسل ردك.'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'إرسال' }));
  expect(await screen.findByText('يلزم تحديث النموذج')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'إرسال' }) as HTMLButtonElement).disabled).toBe(true);
  expect(name.value).toBe('سارة');

  const NEW_NAME = '55555555-5555-4555-8555-555555555555';
  const NEW_RIYADH = '66666666-6666-4666-8666-666666666666';
  const v2 = makeForm({
    versionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    questions: [
      { ...makeForm().questions[0]!, id: NEW_NAME, title: 'الاسم الكامل' },
      {
        ...makeForm().questions[1]!,
        id: '77777777-7777-4777-8777-777777777777',
        options: [{ id: NEW_RIYADH, key: 'logical-riyadh', label: 'الرياض' }],
      },
    ],
  });
  apiMock.mockResolvedValueOnce(v2);
  fireEvent.click(screen.getByRole('button', { name: 'تحديث النموذج' }));
  const renamed = (await screen.findByRole('textbox', {
    name: /الاسم الكامل/,
  })) as HTMLInputElement;
  expect(renamed.value).toBe('سارة');
  expect((screen.getByRole('radio', { name: 'الرياض' }) as HTMLInputElement).checked).toBe(true);
  expect(submitCalls()).toHaveLength(1);

  apiMock.mockResolvedValueOnce({ referenceCode: 'ZZZZ-YYYY-XXXX', submittedAt: 'x' });
  fireEvent.click(screen.getByRole('button', { name: 'إرسال' }));
  await screen.findByText('ZZZZ-YYYY-XXXX');
  const body = submitCalls()[1]![1].body;
  expect(body.versionId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  expect(body.answers[0]).toEqual({ questionId: NEW_NAME, value: 'سارة' });
  expect(body.idempotencyKey).not.toBe(submitCalls()[0]![1].body.idempotencyKey);
});

it('keeps answers when intake closes during filling', async () => {
  const name = await renderReady();
  fireEvent.change(name, { target: { value: 'سارة' } });
  apiMock.mockRejectedValueOnce(
    new ApiError(
      409,
      'RESPONSES_CLOSED',
      'استقبال الردود على هذا النموذج مغلق حاليًا، فلم يُرسل ردك.',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'إرسال' }));
  expect(await screen.findByText('الاستقبال مغلق')).toBeTruthy();
  expect(name.value).toBe('سارة');
});

it('shows closed, not-found and load-error states', async () => {
  apiMock.mockResolvedValueOnce(
    makeForm({ acceptingResponses: false, versionId: null, questions: [] }),
  );
  render(<PublicFormView publicId="pub_abcdefghijklmnop" />);
  expect(await screen.findByText(/مغلق حاليًا/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'إرسال' })).toBeNull();
  cleanup();

  apiMock.mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'غير موجود'));
  render(<PublicFormView publicId="missing_public_id_x" />);
  expect(await screen.findByText('النموذج غير متاح')).toBeTruthy();
  cleanup();

  apiMock.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'تعذر الاتصال بالخادم.'));
  render(<PublicFormView publicId="pub_abcdefghijklmnop" />);
  expect(await screen.findByText('تعذر تحميل النموذج')).toBeTruthy();
  apiMock.mockResolvedValueOnce(makeForm());
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByRole('textbox', { name: /الاسم/ })).toBeTruthy();
});

it('renders description and titles as text, never as HTML', async () => {
  await renderReady(makeForm({ title: '<img src=x onerror=alert(1)>', description: '<b>x</b>' }));
  expect(document.querySelector('img')).toBeNull();
  expect(screen.getByText('<b>x</b>')).toBeTruthy();
});

it('preview mode still works without a submit button', () => {
  render(
    <FormRenderer
      title="معاينة"
      description={null}
      questions={[
        {
          key: 'q',
          type: 'SHORT_TEXT',
          title: 'سؤال',
          description: null,
          required: true,
          settings: {},
          options: [],
        },
      ]}
    />,
  );
  expect(screen.getByText('معاينة — لن تُحفظ الإجابات')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'إرسال' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'تجربة التحقق من الإجابات' }));
  expect(screen.getByText('هذا السؤال إجباري.')).toBeTruthy();
});
