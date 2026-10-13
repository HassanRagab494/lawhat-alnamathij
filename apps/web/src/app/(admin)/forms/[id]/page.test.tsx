import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FormDetailsPage from './page';
const { form, apiMock, setData } = vi.hoisted(() => ({
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
  },
  apiMock: vi.fn(),
  setData: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'f' }),
  useSearchParams: () => new URLSearchParams(),
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
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it.each([true, false])(
  'preserves inputs until explicit conflict resolution; keepMine=%s',
  async (keepMine) => {
    const current = { ...form, title: 'winner', description: 'winner description', revision: 2 };
    apiMock.mockRejectedValue(new ApiError(409, 'REVISION_CONFLICT', 'conflict', [], { current }));
    render(<FormDetailsPage />);
    const title = screen.getByRole('textbox', { name: /عنوان النموذج/ }) as HTMLInputElement;
    const description = screen.getByRole('textbox', { name: /الوصف/ }) as HTMLTextAreaElement;
    await waitFor(() => expect(title.value).toBe('original'));
    fireEvent.change(title, { target: { value: 'my title' } });
    fireEvent.change(description, { target: { value: 'my description' } });
    fireEvent.click(screen.getByText('حفظ التغييرات'));
    await screen.findByText('الإبقاء على تعديلاتي ومراجعتها');
    expect(title.value).toBe('my title');
    expect(description.value).toBe('my description');
    expect(setData).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByText(keepMine ? 'الإبقاء على تعديلاتي ومراجعتها' : 'تحميل النسخة الحالية'),
    );
    expect(setData).toHaveBeenCalledWith(current);
    expect(title.value).toBe(keepMine ? 'my title' : 'winner');
    expect(description.value).toBe(keepMine ? 'my description' : 'winner description');
  },
);
