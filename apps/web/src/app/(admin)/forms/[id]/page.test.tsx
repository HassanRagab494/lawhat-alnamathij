import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FormDetailsPage from './page';
const { form, apiMock, setData, replaceMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  form: {
    id: 'f',
    title: 'original',
    description: 'old',
    revision: 1,
    isArchived: false,
    createdBy: { id: 'u', displayName: 'Admin' },
    createdAt: '2026-10-12T00:00:00Z',
    updatedAt: '2026-10-12T00:00:00Z',
    archivedAt: null,
    publicationStatus: 'draft',
    publication: {
      publicId: null,
      acceptingResponses: false,
      latestVersion: null,
      hasUnpublishedChanges: true,
    },
    questions: [] as unknown[],
  },
  apiMock: vi.fn(),
  setData: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'f' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}));
vi.mock('@/components/guards', () => ({
  RequirePermission: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ me: { role: 'ADMIN' }, refresh: vi.fn() }),
}));
vi.mock('@/lib/use-api', async () => {
  const { useState } = await import('react');
  return {
    useApi: () => {
      const [data, update] = useState(form);
      return {
        data,
        loading: false,
        setData: (value: typeof form) => {
          setData(value);
          update(value);
        },
      };
    },
  };
});
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: apiMock,
}));
import { ApiError } from '@/lib/api';
// jsdom لا يدعم <dialog>.showModal
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it.each([true, false])(
  'preserves inputs until explicit conflict resolution; keepMine=%s',
  async (keepMine) => {
    const current = {
      ...form,
      title: 'winner',
      description: 'winner description',
      revision: 2,
      questions: [],
    };
    apiMock.mockRejectedValue(new ApiError(409, 'REVISION_CONFLICT', 'conflict', [], { current }));
    render(<FormDetailsPage />);
    const title = screen.getByRole('textbox', { name: /عنوان النموذج/ }) as HTMLInputElement;
    const description = screen.getByRole('textbox', { name: /الوصف/ }) as HTMLTextAreaElement;
    await waitFor(() => expect(title.value).toBe('original'));
    fireEvent.change(title, { target: { value: 'my title' } });
    fireEvent.change(description, { target: { value: 'my description' } });
    fireEvent.click(screen.getByText('حفظ التغييرات'));
    await screen.findByText('الإبقاء على تعديلاتي لمراجعتها');
    // الحفظ أُرسل كاملًا عبر PUT بـ revision المحمّل
    expect(apiMock).toHaveBeenCalledWith(
      '/forms/f/draft',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(apiMock.mock.calls[0]![1].body.revision).toBe(1);
    expect(title.value).toBe('my title');
    expect(description.value).toBe('my description');
    fireEvent.click(
      screen.getByText(
        keepMine ? 'الإبقاء على تعديلاتي لمراجعتها' : 'تحميل نسخة الخادم (تُلغى تعديلاتي)',
      ),
    );
    // المراجعة الأساسية أصبحت نسخة الخادم الأحدث
    expect(screen.getByText('رقم مراجعة المسودة').nextSibling?.textContent).toBe('2');
    expect(title.value).toBe(keepMine ? 'my title' : 'winner');
    expect(description.value).toBe(keepMine ? 'my description' : 'winner description');
  },
);

it('لا زر ولا رابط «ربط Flowmax» في صفحة النموذج (التكامل تلقائي)', async () => {
  render(<FormDetailsPage />);
  const title = screen.getByRole('textbox', { name: /عنوان النموذج/ }) as HTMLInputElement;
  await waitFor(() => expect(title.value).toBe('original'));
  expect(screen.queryByText(/ربط Flowmax/)).toBeNull();
  expect(document.querySelector('a[href$="/flowmax"]')).toBeNull();
});

it('المدير يحذف النموذج بعد التأكيد ثم يعود إلى قائمة النماذج', async () => {
  apiMock.mockResolvedValue(undefined);
  render(<FormDetailsPage />);
  fireEvent.click(screen.getByRole('button', { name: 'حذف النموذج' }));
  const dialog = screen.getByRole('dialog', { name: 'حذف النموذج' });
  expect(dialog.textContent).toMatch(/تبقى محفوظة في قاعدة البيانات/);
  expect(apiMock).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'حذف النموذج' }));
  await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/forms?deleted=1'));
  expect(apiMock).toHaveBeenCalledWith('/forms/f', { method: 'DELETE' });
});
