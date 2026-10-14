import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Me } from '@/lib/types';

const { apiMock, replaceMock, state } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  replaceMock: vi.fn(),
  state: {
    me: null as Me | null,
    search: '',
    paramsKey: null as string | null,
    params: null as URLSearchParams | null,
  },
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'form-1', responseId: 'resp-1' }),
  // كما في Next: الكائن نفسه ما دام الرابط لم يتغير.
  useSearchParams: () => {
    if (state.paramsKey !== state.search || !state.params) {
      state.paramsKey = state.search;
      state.params = new URLSearchParams(state.search);
    }
    return state.params;
  },
  usePathname: () => '/forms/form-1/responses',
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ me: state.me, refresh: vi.fn() }),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: apiMock,
}));

import ResponsesPage from './page';
import ResponseDetailPage from './[responseId]/page';

const user = (role: Me['role'], permissions: Me['permissions'] = []): Me => ({
  id: 'u',
  username: 'u',
  displayName: 'u',
  role,
  permissions,
});

const form = {
  id: 'form-1',
  title: 'استبيان',
  publication: {
    publicId: 'p',
    acceptingResponses: true,
    latestVersion: {
      id: 'v2',
      versionNumber: 2,
      publishedAt: '2026-10-01T00:00:00Z',
      publishedBy: null,
    },
    hasUnpublishedChanges: false,
  },
};

const list = {
  items: [
    {
      id: 'resp-1',
      referenceCode: 'AAAA-BBBB-CCCC',
      submittedAt: '2026-10-01T09:00:00.000Z',
      status: 'NEW',
      versionNumber: 1,
    },
    {
      id: 'resp-2',
      referenceCode: 'DDDD-EEEE-FFFF',
      submittedAt: '2026-10-02T09:00:00.000Z',
      status: 'ACCEPTED',
      versionNumber: 2,
    },
  ],
  meta: { page: 1, pageSize: 20, total: 2, totalPages: 1 },
};

const detail = {
  id: 'resp-1',
  referenceCode: 'AAAA-BBBB-CCCC',
  submittedAt: '2026-10-01T09:00:00.000Z',
  status: 'NEW',
  formId: 'form-1',
  formTitle: 'استبيان',
  version: { versionNumber: 1, title: 'استبيان (إصدار 1)', description: null, publishedAt: 'x' },
  answers: [
    {
      questionId: 'q1',
      position: 0,
      type: 'SHORT_TEXT',
      title: 'الاسم',
      description: null,
      required: true,
      kind: 'text',
      value: '<img src=x onerror=alert(1)>',
    },
    {
      questionId: 'q2',
      position: 1,
      type: 'PARAGRAPH',
      title: 'ملاحظات',
      description: null,
      required: false,
      kind: 'empty',
    },
    {
      questionId: 'q3',
      position: 2,
      type: 'MULTIPLE_CHOICE',
      title: 'الاهتمامات',
      description: null,
      required: false,
      kind: 'choice',
      options: [
        { label: 'تقنية', selected: true },
        { label: 'تصميم', selected: false },
      ],
    },
    {
      questionId: 'q4',
      position: 3,
      type: 'FILE_UPLOAD',
      title: 'السيرة',
      description: null,
      required: false,
      kind: 'file',
    },
    {
      questionId: 'q5',
      position: 4,
      type: 'NUMBER',
      title: 'المبلغ',
      description: null,
      required: false,
      kind: 'number',
      value: '-12.5',
    },
  ],
  statusHistory: [],
};

function routeApi(path: string) {
  if (path === '/forms/form-1') return Promise.resolve(form);
  if (path.startsWith('/forms/form-1/responses?')) return Promise.resolve(list);
  if (path === '/forms/form-1/responses/resp-1') return Promise.resolve(detail);
  return Promise.reject(new Error(`unexpected ${path}`));
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation((path: string) => routeApi(path));
  replaceMock.mockReset();
  state.search = '';
});
afterEach(() => cleanup());

it('القائمة: الأعمدة والروابط، والتصدير مخفي دون صلاحيته', async () => {
  state.me = user('SUPERVISOR', ['FORMS_VIEW', 'RESPONSES_VIEW']);
  render(<ResponsesPage />);
  const table = await screen.findByRole('table', { name: 'ردود النموذج' });
  const rows = within(table).getAllByRole('row');
  expect(rows).toHaveLength(3);
  expect(within(rows[1]!).getByText('AAAA-BBBB-CCCC')).toBeTruthy();
  expect(within(rows[1]!).getByText('جديد')).toBeTruthy();
  expect(within(rows[2]!).getByText('مقبول')).toBeTruthy();
  expect(
    within(rows[1]!).getByRole('link', { name: 'تفاصيل الرد AAAA-BBBB-CCCC' }).getAttribute('href'),
  ).toBe('/forms/form-1/responses/resp-1');
  expect(screen.queryByRole('button', { name: 'تصدير CSV' })).toBeNull();
  expect(apiMock).toHaveBeenCalledWith('/forms/form-1/responses?pageSize=20', expect.anything());
});

it('القائمة: الفلاتر تُطبَّق عبر الرابط وتُرسل للخادم، وزر التصدير يظهر بالصلاحية', async () => {
  state.me = user('ADMIN');
  state.search = 'status=ACCEPTED&version=2';
  render(<ResponsesPage />);
  await screen.findByRole('table', { name: 'ردود النموذج' });
  expect(apiMock).toHaveBeenCalledWith(
    '/forms/form-1/responses?status=ACCEPTED&version=2&pageSize=20',
    expect.anything(),
  );
  expect(screen.getByRole('button', { name: 'تصدير CSV' })).toBeTruthy();
  // روابط التفاصيل تحمل فلاتر القائمة للعودة إليها
  expect(
    screen.getAllByRole('link', { name: 'تفاصيل الرد AAAA-BBBB-CCCC' })[0]!.getAttribute('href'),
  ).toBe('/forms/form-1/responses/resp-1?list=status%3DACCEPTED%26version%3D2');

  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'aaaa' } });
  fireEvent.change(screen.getByLabelText('من تاريخ'), { target: { value: '2026-10-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'تطبيق' }));
  expect(replaceMock).toHaveBeenCalledWith(
    '/forms/form-1/responses?search=aaaa&status=ACCEPTED&from=2026-10-01&version=2',
  );
});

it('القائمة: يمنع نطاق تاريخ معكوسًا قبل الطلب، ويعرض حالة لا نتائج', async () => {
  state.me = user('ADMIN');
  apiMock.mockImplementation((path: string) =>
    path.startsWith('/forms/form-1/responses?')
      ? Promise.resolve({ items: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } })
      : routeApi(path),
  );
  state.search = 'status=REJECTED';
  render(<ResponsesPage />);
  expect(await screen.findByText('لا توجد ردود مطابقة')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('من تاريخ'), { target: { value: '2026-10-05' } });
  fireEvent.change(screen.getByLabelText('إلى تاريخ'), { target: { value: '2026-10-01' } });
  expect(screen.getByText(/تاريخ النهاية يجب أن يكون بعد/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'تطبيق' }) as HTMLButtonElement).disabled).toBe(true);
});

it('القائمة: صفحة ممنوعة دون عرض الردود', () => {
  state.me = user('SUPERVISOR', ['FORMS_VIEW']);
  render(<ResponsesPage />);
  expect(screen.getByText('لا تملك صلاحية الوصول')).toBeTruthy();
  expect(apiMock).not.toHaveBeenCalled();
});

it('التفاصيل: كل نوع إجابة كنص آمن، دون أداة تغيير الحالة لمن لا يملك المراجعة', async () => {
  state.me = user('SUPERVISOR', ['FORMS_VIEW', 'RESPONSES_VIEW']);
  render(<ResponseDetailPage />);
  expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  expect(document.querySelector('img')).toBeNull();
  expect(screen.getByText('لم تُقدَّم إجابة (سؤال اختياري).')).toBeTruthy();
  expect(screen.getByText(/رفع الملفات الفعلي غير متاح بعد/)).toBeTruthy();
  expect(screen.getByText('-12.5')).toBeTruthy();
  expect(screen.getByText('(مختار)', { exact: false })).toBeTruthy();
  expect(screen.getByText('لم تتغير الحالة منذ الإرسال.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'حفظ الحالة' })).toBeNull();
  expect(screen.queryByText(/resp-1|q1/)).toBeNull();
});

it('التفاصيل: المراجع يغيّر الحالة ويظهر السجل المحدّث', async () => {
  state.me = user('SUPERVISOR', ['FORMS_VIEW', 'RESPONSES_VIEW', 'RESPONSES_REVIEW']);
  render(<ResponseDetailPage />);
  const select = (await screen.findByLabelText('الحالة الجديدة')) as HTMLSelectElement;
  const save = screen.getByRole('button', { name: 'حفظ الحالة' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  apiMock.mockResolvedValueOnce({
    changed: true,
    response: {
      ...detail,
      status: 'ACCEPTED',
      statusHistory: [
        {
          fromStatus: 'NEW',
          toStatus: 'ACCEPTED',
          changedBy: 'مراجع',
          changedAt: '2026-10-03T10:00:00Z',
        },
      ],
    },
  });
  fireEvent.change(select, { target: { value: 'ACCEPTED' } });
  fireEvent.click(save);
  expect(await screen.findByText('تم تغيير الحالة إلى «مقبول».')).toBeTruthy();
  expect(apiMock).toHaveBeenCalledWith('/forms/form-1/responses/resp-1/status', {
    method: 'PATCH',
    body: { status: 'ACCEPTED' },
  });
  await waitFor(() => expect(screen.getByText(/مراجع ·/)).toBeTruthy());
});

it('التفاصيل: رد غير موجود أو من نموذج آخر', async () => {
  state.me = user('ADMIN');
  const { ApiError } = await import('@/lib/api');
  apiMock.mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'الرد غير موجود.'));
  render(<ResponseDetailPage />);
  expect(await screen.findByText('الرد غير موجود')).toBeTruthy();
});
