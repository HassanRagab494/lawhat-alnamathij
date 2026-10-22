import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Me } from '@/lib/types';

const { apiMock, replaceMock, state } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  replaceMock: vi.fn(),
  state: { me: null as Me | null, pathname: '/responses', search: '' },
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'form-1', responseId: 'resp-1' }),
  useSearchParams: () => new URLSearchParams(state.search),
  usePathname: () => state.pathname,
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ me: state.me, refresh: vi.fn(), logout: vi.fn() }),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: apiMock,
}));

import AllResponsesPage from './page';
import ResponseDetailPage from '../forms/[id]/responses/[responseId]/page';
import { AppShell } from '@/components/app-shell';

// jsdom لا يدعم <dialog>.showModal
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
};

const me = (role: Me['role'], permissions: Me['permissions']): Me => ({
  id: 'u',
  username: 'u',
  displayName: 'u',
  role,
  permissions,
});
const ADMIN = me('ADMIN', [
  'FORMS_VIEW',
  'RESPONSES_VIEW',
  'RESPONSES_REVIEW',
  'RESPONSES_FILES_DOWNLOAD',
]);
const REVIEWER = me('SUPERVISOR', ['FORMS_VIEW', 'RESPONSES_VIEW', 'RESPONSES_REVIEW']);

const detail = {
  id: 'resp-1',
  referenceCode: 'AAAA-BBBB-CCCC',
  submittedAt: '2026-10-01T09:00:00.000Z',
  status: 'NEW',
  formId: 'form-1',
  formTitle: 'نموذج عقاري',
  version: {
    versionNumber: 1,
    title: 'نموذج عقاري',
    description: null,
    publishedAt: '2026-10-01T00:00:00Z',
  },
  answers: [],
  statusHistory: [],
  editRevision: 0,
  edits: [],
  locked: false,
  rejection: null,
};

beforeEach(() => {
  apiMock.mockReset();
  replaceMock.mockReset();
  state.search = '';
  apiMock.mockImplementation((path: string, options?: { method?: string }) => {
    if (path.startsWith('/responses?')) {
      return Promise.resolve({
        items: [
          {
            id: 'resp-1',
            formId: 'form-1',
            formTitle: 'تحقق القالب العقاري الموحّد',
            referenceCode: 'AAAA-BBBB-CCCC',
            status: 'NEW',
            submittedAt: '2026-10-01T09:00:00.000Z',
            versionNumber: 3,
          },
        ],
        meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
      });
    }
    if (path === '/forms/form-1/responses/resp-1' && options?.method === 'DELETE') {
      return Promise.resolve(undefined);
    }
    if (path === '/forms/form-1/responses/resp-1') return Promise.resolve(detail);
    if (path === '/forms/form-1/responses/resp-1/flowmax') {
      return Promise.resolve({
        integrationEnabled: false,
        mappingEnabled: false,
        sync: null,
        precheck: null,
        rejected: false,
        editRevision: 0,
      });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});
afterEach(() => cleanup());

describe('الردود في الشريط العلوي', () => {
  it('يظهر رابط «الردود» لمن يملك عرض الردود فقط', () => {
    state.me = REVIEWER;
    state.pathname = '/responses';
    render(<AppShell>محتوى</AppShell>);
    const nav = screen.getAllByRole('navigation', { name: 'القائمة الرئيسية' })[0]!;
    const link = within(nav).getByRole('link', { name: 'الردود' });
    expect(link.getAttribute('href')).toBe('/responses');
    expect(link.getAttribute('aria-current')).toBe('page');
    cleanup();

    state.me = me('SUPERVISOR', ['FORMS_VIEW']);
    render(<AppShell>محتوى</AppShell>);
    const nav2 = screen.getAllByRole('navigation', { name: 'القائمة الرئيسية' })[0]!;
    expect(within(nav2).queryByRole('link', { name: 'الردود' })).toBeNull();
  });

  it('صفحة ردود رد نموذج تُبرز «الردود» لا «النماذج»', () => {
    state.me = REVIEWER;
    state.pathname = '/forms/form-1/responses/resp-1';
    render(<AppShell>محتوى</AppShell>);
    const nav = screen.getAllByRole('navigation', { name: 'القائمة الرئيسية' })[0]!;
    expect(within(nav).getByRole('link', { name: 'الردود' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'النماذج' }).getAttribute('aria-current')).toBe(
      null,
    );
  });

  it('قائمة كل الردود تعرض النموذج ورابط التفاصيل يعود إليها', async () => {
    state.me = REVIEWER;
    render(<AllResponsesPage />);
    expect(await screen.findAllByText('تحقق القالب العقاري الموحّد')).not.toHaveLength(0);
    expect(apiMock.mock.calls[0]![0]).toBe('/responses?pageSize=20');
    const link = screen.getAllByRole('link', { name: 'تفاصيل الرد AAAA-BBBB-CCCC' })[0]!;
    expect(link.getAttribute('href')).toBe('/forms/form-1/responses/resp-1?source=all');
  });
});

describe('حذف الرد', () => {
  it('المشرف المراجع لا يرى زر الحذف', async () => {
    state.me = REVIEWER;
    render(<ResponseDetailPage />);
    await screen.findByRole('button', { name: 'تعديل بيانات الرد' });
    expect(screen.queryByRole('button', { name: 'حذف الرد' })).toBeNull();
  });

  it('المدير يحذف بعد التأكيد ويعود إلى القائمة التي جاء منها', async () => {
    state.me = ADMIN;
    state.search = 'source=all';
    render(<ResponseDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'حذف الرد' }));
    const dialog = screen.getByRole('dialog', { name: 'حذف الرد' });
    expect(within(dialog).getByText(/تبقى محفوظة في قاعدة البيانات/)).toBeTruthy();
    expect(apiMock).not.toHaveBeenCalledWith(
      '/forms/form-1/responses/resp-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'حذف الرد' }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/responses?deleted=1'));
    expect(apiMock).toHaveBeenCalledWith('/forms/form-1/responses/resp-1', { method: 'DELETE' });
  });
});
