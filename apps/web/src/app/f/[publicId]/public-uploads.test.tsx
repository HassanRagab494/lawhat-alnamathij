import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PublicForm } from '@/lib/public-form';

const { apiMock, uploadMock, sessionMock, deleteMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  uploadMock: vi.fn(),
  sessionMock: vi.fn(),
  deleteMock: vi.fn(),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: apiMock,
}));
vi.mock('@/lib/uploads', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createFillSession: sessionMock,
  uploadFile: uploadMock,
  deleteUploadedFile: deleteMock,
}));
import { ApiError } from '@/lib/api';
import { PublicFormView } from './public-form-view';

const Q_NAME = '11111111-1111-4111-8111-111111111111';
const Q_FILE = '22222222-2222-4222-8222-222222222222';
const FILE_ID = '33333333-3333-4333-8333-333333333333';

function makeForm(overrides: Partial<PublicForm> = {}): PublicForm {
  return {
    publicId: 'pub_abcdefghijklmnop',
    title: 'طلب توظيف',
    description: null,
    acceptingResponses: true,
    versionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    questions: [
      {
        id: Q_NAME,
        key: 'k-name',
        type: 'SHORT_TEXT',
        title: 'الاسم',
        description: null,
        required: false,
        settings: {},
        options: [],
      },
      {
        id: Q_FILE,
        key: 'k-file',
        type: 'FILE_UPLOAD',
        title: 'السيرة الذاتية',
        description: null,
        required: true,
        settings: { allowedTypes: ['pdf', 'png'], maxFileSizeMb: 1, maxFiles: 2 },
        options: [],
      },
    ],
    ...overrides,
  };
}

/** رفع وهمي يمكن التحكم في مراحله: progress ثم uploaded (بدء الفحص) ثم resolve/reject. */
function controllableUpload() {
  const ctl: {
    progress?: (p: number) => void;
    uploaded?: () => void;
    resolve?: (v: unknown) => void;
    reject?: (e: unknown) => void;
  } = {};
  uploadMock.mockImplementationOnce((_p, _t, _q, _f, onProgress, onUploaded) => {
    ctl.progress = onProgress;
    ctl.uploaded = onUploaded;
    return {
      promise: new Promise((resolve, reject) => {
        ctl.resolve = resolve;
        ctl.reject = reject;
      }),
      abort: vi.fn(),
    };
  });
  return ctl;
}

const pdf = (name = 'cv.pdf', size = 2048) =>
  new File([new Uint8Array(size)], name, { type: 'application/pdf' });

const submitCalls = () => apiMock.mock.calls.filter(([, o]) => o?.method === 'POST');

beforeEach(() => {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  apiMock.mockReset();
  uploadMock.mockReset();
  sessionMock.mockReset();
  deleteMock.mockReset();
  sessionMock.mockResolvedValue('t'.repeat(43));
});
afterEach(() => cleanup());

async function renderReady(form = makeForm()) {
  apiMock.mockResolvedValueOnce(form);
  render(<PublicFormView publicId={form.publicId} />);
  return (await screen.findByLabelText(/السيرة الذاتية/)) as HTMLInputElement;
}

it('سؤال الملفات الإجباري يمنع الإرسال دون ملف مقبول', async () => {
  await renderReady();
  fireEvent.click(screen.getByRole('button', { name: 'إرسال' }));
  expect(await screen.findByText(/أرفق ملفًا واحدًا على الأقل/)).toBeTruthy();
  expect(submitCalls()).toHaveLength(0);
});

it('فحص مبدئي: نوع غير مسموح أو حجم زائد يظهر خطأً عربيًا دون رفع', async () => {
  const input = await renderReady();
  fireEvent.change(input, {
    target: { files: [new File(['x'], 'run.exe'), pdf('big.pdf', 2 * 1024 * 1024)] },
  });
  expect(await screen.findByText(/نوع الملف غير مسموح/)).toBeTruthy();
  expect(screen.getByText(/يتجاوز الحد المسموح \(1 ميغابايت\)/)).toBeTruthy();
  expect(uploadMock).not.toHaveBeenCalled();
  expect(sessionMock).not.toHaveBeenCalled();
});

it('رفع ⇒ فحص ⇒ جاهز، ومنع الإرسال أثناءه، ثم إرسال معرّف الملف ورمز الجلسة', async () => {
  const input = await renderReady();
  const up = controllableUpload();
  fireEvent.change(input, { target: { files: [pdf()] } });
  await waitFor(() => expect(uploadMock).toHaveBeenCalled());
  act(() => up.progress!(40));
  expect(screen.getByText(/جارٍ الرفع 40%/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'إرسال' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('انتظر اكتمال رفع الملفات والتحقق منها قبل الإرسال.')).toBeTruthy();
  act(() => up.uploaded!());
  expect(screen.getAllByText(/جارٍ التحقق والفحص/)[0]).toBeTruthy();
  await act(async () => up.resolve!({ id: FILE_ID, name: 'cv.pdf', size: 2048 }));
  expect((await screen.findAllByText(/جاهز/))[0]).toBeTruthy();

  apiMock.mockResolvedValueOnce({ referenceCode: 'AAAA-BBBB-CCCC', submittedAt: 'x' });
  const button = screen.getByRole('button', { name: 'إرسال' }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await screen.findByText('AAAA-BBBB-CCCC');
  const body = submitCalls()[0]![1].body;
  expect(body.fillSession).toBe('t'.repeat(43));
  expect(body.answers).toEqual([{ questionId: Q_FILE, value: [FILE_ID] }]);
  expect(sessionMock).toHaveBeenCalledTimes(1);
});

it('رفض الخادم (فحص) يظهر بجانب الملف، والإجابات تبقى، والإزالة تحذف المقبول من الخادم', async () => {
  const input = await renderReady();
  fireEvent.change(screen.getByRole('textbox', { name: /الاسم/ }), { target: { value: 'سارة' } });
  const bad = controllableUpload();
  fireEvent.change(input, { target: { files: [pdf('virus.pdf')] } });
  await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
  await act(async () =>
    bad.reject!(new ApiError(422, 'FILE_INFECTED', 'رُفض الملف لأن الفحص اكتشف محتوى ضارًا.')),
  );
  expect(await screen.findByText('رُفض الملف لأن الفحص اكتشف محتوى ضارًا.')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: /الاسم/ }) as HTMLInputElement).value).toBe('سارة');

  const good = controllableUpload();
  fireEvent.change(input, { target: { files: [pdf('ok.pdf')] } });
  await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(2));
  await act(async () => good.resolve!({ id: FILE_ID, name: 'ok.pdf', size: 2048 }));
  await screen.findAllByText(/جاهز/);
  fireEvent.click(screen.getByRole('button', { name: 'إزالة ok.pdf' }));
  expect(deleteMock).toHaveBeenCalledWith('pub_abcdefghijklmnop', 't'.repeat(43), FILE_ID);
  expect(screen.queryByText('ok.pdf')).toBeNull();
});

it('تحديث الإصدار يزيل الملفات المرتبطة بالإصدار القديم ويطلب رفعها من جديد', async () => {
  const input = await renderReady();
  const up = controllableUpload();
  fireEvent.change(input, { target: { files: [pdf()] } });
  await waitFor(() => expect(uploadMock).toHaveBeenCalled());
  await act(async () => up.resolve!({ id: FILE_ID, name: 'cv.pdf', size: 2048 }));
  await screen.findAllByText(/جاهز/);
  apiMock.mockRejectedValueOnce(new ApiError(409, 'VERSION_OUTDATED', 'نُشر تحديث.'));
  fireEvent.click(screen.getByRole('button', { name: 'إرسال' }));
  await screen.findByText('يلزم تحديث النموذج');
  apiMock.mockResolvedValueOnce(makeForm({ versionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
  fireEvent.click(screen.getByRole('button', { name: 'تحديث النموذج' }));
  expect(await screen.findByText(/أعد رفعها قبل الإرسال/)).toBeTruthy();
  expect(screen.queryByText('cv.pdf')).toBeNull();
});

it('دون فحص برمجيات خبيثة على الخادم: لا تُعرض عبارات الفحص', async () => {
  const input = await renderReady(makeForm({ fileScanning: false }));
  expect(screen.getByText(/يُتحقق من نوع كل ملف وحجمه قبل قبوله/)).toBeTruthy();
  expect(screen.queryByText(/يُفحص كل ملف/)).toBeNull();
  const up = controllableUpload();
  fireEvent.change(input, { target: { files: [pdf()] } });
  await waitFor(() => expect(uploadMock).toHaveBeenCalled());
  act(() => up.uploaded!());
  expect(screen.getAllByText(/جارٍ التحقق من الملف/)[0]).toBeTruthy();
  expect(screen.queryByText(/الفحص/)).toBeNull();
});
