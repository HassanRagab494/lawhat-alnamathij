import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FormDraft } from '@/lib/draft';
import type { Me } from '@/lib/types';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: apiMock,
}));
import { PublishPanel } from './publish-panel';

beforeAll(() => {
  // jsdom لا ينفذ <dialog>؛ يكفي ضبط open لعرض المحتوى.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

const question = {
  id: 'q1',
  type: 'SHORT_TEXT',
  title: 'الاسم',
  description: null,
  required: true,
  settings: {},
  options: [],
};

function makeForm(overrides: Partial<FormDraft> = {}): FormDraft {
  return {
    id: 'f1',
    title: 'نموذج',
    description: null,
    publicationStatus: 'draft',
    isArchived: false,
    revision: 3,
    createdBy: { id: 'u', displayName: 'مدير' },
    createdAt: '2026-10-12T00:00:00Z',
    updatedAt: '2026-10-12T00:00:00Z',
    archivedAt: null,
    publication: {
      publicId: null,
      acceptingResponses: false,
      latestVersion: null,
      hasUnpublishedChanges: true,
    },
    questions: [question],
    ...overrides,
  } as FormDraft;
}

const admin: Me = { id: 'a', username: 'a', displayName: 'a', role: 'ADMIN', permissions: [] };
const supervisor = (permissions: Me['permissions']): Me => ({
  id: 's',
  username: 's',
  displayName: 's',
  role: 'SUPERVISOR',
  permissions,
});

function renderPanel(form: FormDraft, me: Me, dirty = false) {
  const onUpdated = vi.fn();
  const onConflict = vi.fn();
  render(
    <PublishPanel
      form={form}
      me={me}
      dirty={dirty}
      onUpdated={onUpdated}
      onConflict={onConflict}
    />,
  );
  return { onUpdated, onConflict };
}

it('requires saving local edits before publishing', () => {
  renderPanel(makeForm(), admin, true);
  expect((screen.getByRole('button', { name: 'نشر النموذج' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(screen.getByText(/احفظ التغييرات أولًا/)).toBeTruthy();
});

it('explains why empty drafts cannot be published; file questions are decided by the server', () => {
  renderPanel(makeForm({ questions: [] }), admin);
  expect(screen.getByText(/أضف سؤالًا واحدًا على الأقل/)).toBeTruthy();
  cleanup();
  renderPanel(
    makeForm({ questions: [{ ...question, type: 'FILE_UPLOAD', title: 'السيرة' }] as never }),
    admin,
  );
  // رفع الملفات منفذ؛ الخادم يمنع النشر فقط إن لم يكن الفاحص مضبوطًا ويعيد السبب في PUBLISH_BLOCKED
  expect(screen.queryByText(/«السيرة» من نوع رفع ملفات/)).toBeNull();
  expect((screen.getByRole('button', { name: 'نشر النموذج' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

it('hides publish and intake controls without the permissions', () => {
  renderPanel(
    makeForm({
      publication: {
        publicId: 'pub',
        acceptingResponses: true,
        latestVersion: {
          id: 'v',
          versionNumber: 1,
          publishedAt: '2026-10-12T00:00:00Z',
          publishedBy: null,
        },
        hasUnpublishedChanges: false,
      },
    }),
    supervisor(['FORMS_VIEW', 'FORMS_EDIT']),
  );
  expect(screen.queryByRole('button', { name: /نشر/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /استقبال الردود/ })).toBeNull();
  expect(screen.getByText('مفتوح')).toBeTruthy();
});

it('first publish sends the saved revision and the explicit intake choice', async () => {
  apiMock.mockResolvedValueOnce({
    form: {
      ...makeForm(),
      publication: {
        publicId: 'pub',
        acceptingResponses: true,
        latestVersion: null,
        hasUnpublishedChanges: false,
      },
    },
    version: { id: 'v', versionNumber: 1 },
    replayed: false,
  });
  const { onUpdated } = renderPanel(makeForm(), admin);
  fireEvent.click(screen.getByRole('button', { name: 'نشر النموذج' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /فتح استقبال الردود فور النشر/ }));
  fireEvent.click(screen.getByRole('button', { name: 'نشر' }));
  await waitFor(() => expect(onUpdated).toHaveBeenCalled());
  const [path, opts] = apiMock.mock.calls[0]!;
  expect(path).toBe('/forms/f1/publish');
  expect(opts.body).toMatchObject({ revision: 3, openResponses: true });
  expect(opts.body.publishKey).toMatch(/^[0-9a-f-]{36}$/);
});

it('a publisher without intake permission cannot open intake on first publish', async () => {
  renderPanel(makeForm(), supervisor(['FORMS_VIEW', 'FORMS_PUBLISH']));
  fireEvent.click(screen.getByRole('button', { name: 'نشر النموذج' }));
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.getByText(/سيبقى الاستقبال مغلقًا/)).toBeTruthy();
});
