import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Me } from '@/lib/types';

const { apiMock, state } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  state: { me: null as Me | null, params: new URLSearchParams() },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => state.params,
  usePathname: () => '/forms',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}));
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ me: state.me, refresh: vi.fn() }) }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: apiMock,
}));

import FormsPage from './page';

const base = {
  description: null,
  isArchived: false,
  revision: 1,
  createdBy: { id: 'u', displayName: 'مدير' },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  archivedAt: null,
};
const forms = {
  items: [
    {
      ...base,
      id: 'f1',
      title: 'منشور',
      publicationStatus: 'published',
      publication: {
        publicId: 'p',
        acceptingResponses: true,
        latestVersion: { id: 'v', versionNumber: 1, publishedAt: 'x', publishedBy: null },
        hasUnpublishedChanges: false,
      },
    },
    {
      ...base,
      id: 'f2',
      title: 'مسودة',
      publicationStatus: 'draft',
      publication: {
        publicId: null,
        acceptingResponses: false,
        latestVersion: null,
        hasUnpublishedChanges: true,
      },
    },
  ],
  meta: { page: 1, pageSize: 20, total: 2, totalPages: 1 },
};

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

const me = (permissions: Me['permissions']): Me => ({
  id: 'u',
  username: 'u',
  displayName: 'u',
  role: 'SUPERVISOR',
  permissions,
});

it('رابط الردود يظهر لمن يملك عرض الردود وللنماذج المنشورة فقط', async () => {
  state.me = me(['FORMS_VIEW', 'RESPONSES_VIEW']);
  apiMock.mockResolvedValue(forms);
  render(<FormsPage />);
  const links = await screen.findAllByRole('link', { name: 'ردود «منشور»' });
  expect(links.length).toBeGreaterThan(0);
  expect(links[0]!.getAttribute('href')).toBe('/forms/f1/responses');
  expect(screen.queryAllByRole('link', { name: 'ردود «مسودة»' })).toHaveLength(0);
  expect(screen.getAllByText('منشور').length).toBeGreaterThan(0);
});

it('لا رابط للردود دون صلاحية العرض', async () => {
  state.me = me(['FORMS_VIEW']);
  apiMock.mockResolvedValue(forms);
  render(<FormsPage />);
  await screen.findAllByRole('link', { name: 'منشور' });
  expect(screen.queryAllByRole('link', { name: /ردود/ })).toHaveLength(0);
});
