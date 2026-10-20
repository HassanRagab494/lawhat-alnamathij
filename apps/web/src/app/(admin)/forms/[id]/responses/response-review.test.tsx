import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Me } from '@/lib/types';
import { ApiError } from '@/lib/api';
import { changedAnswers, toRenderQuestions, type EditForm } from '@/components/response-editor';

const { apiMock, state } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  state: { me: null as Me | null },
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'form-1', responseId: 'resp-1' }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/forms/form-1/responses/resp-1',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
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

import ResponseDetailPage from './[responseId]/page';

// jsdom لا يدعم <dialog>.showModal
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
};

const user = (permissions: Me['permissions']): Me => ({
  id: 'u',
  username: 'u',
  displayName: 'u',
  role: 'SUPERVISOR',
  permissions,
});
const REVIEWER = user(['FORMS_VIEW', 'RESPONSES_VIEW', 'RESPONSES_REVIEW']);
const VIEWER = user(['FORMS_VIEW', 'RESPONSES_VIEW']);

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
  answers: [
    {
      questionId: 'q-city',
      position: 0,
      type: 'SHORT_TEXT',
      title: 'المدينة',
      description: null,
      required: true,
      hidden: false,
      kind: 'text',
      value: 'جدة',
    },
  ],
  statusHistory: [],
  editRevision: 0,
  edits: [],
  locked: false,
  rejection: null,
};

let flowmaxState: Record<string, unknown> = {
  integrationEnabled: true,
  mappingEnabled: true,
  sync: null,
  precheck: { problems: [], incompatibleMedia: [], notices: [] },
  rejected: false,
  editRevision: 0,
};

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation((path: string) => {
    if (path === '/forms/form-1/responses/resp-1') return Promise.resolve(detail);
    if (path === '/forms/form-1/responses/resp-1/flowmax') return Promise.resolve(flowmaxState);
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('مراجعة الرد', () => {
  it('صاحب العرض فقط لا يرى تعديل الرد ولا تغيير الحالة', async () => {
    state.me = VIEWER;
    render(<ResponseDetailPage />);
    await screen.findByText('جدة');
    expect(screen.queryByRole('button', { name: 'تعديل بيانات الرد' })).toBeNull();
    expect(screen.queryByText('تغيير الحالة')).toBeNull();
  });

  it('الرفض يتطلب سببًا قبل أي طلب، ثم يُرسل السبب ويظهر مع زر المشاركة', async () => {
    state.me = REVIEWER;
    render(<ResponseDetailPage />);
    await screen.findByRole('button', { name: 'تعديل بيانات الرد' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'REJECTED' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الحالة' }));
    expect(await screen.findByText(/سبب الرفض إجباري/)).toBeTruthy();
    expect(apiMock).not.toHaveBeenCalledWith(
      '/forms/form-1/responses/resp-1/status',
      expect.anything(),
    );

    const rejected = {
      ...detail,
      status: 'REJECTED',
      rejection: {
        reason: 'الصور غير واضحة',
        rejectedBy: 'مراجع',
        rejectedAt: '2026-10-02T10:00:00Z',
      },
      statusHistory: [
        {
          fromStatus: 'NEW',
          toStatus: 'REJECTED',
          reason: 'الصور غير واضحة',
          changedBy: 'مراجع',
          changedAt: '2026-10-02T10:00:00Z',
        },
      ],
    };
    apiMock.mockImplementationOnce(() => Promise.resolve({ changed: true, response: rejected }));
    fireEvent.change(screen.getByPlaceholderText(/الصور غير واضحة/), {
      target: { value: 'الصور غير واضحة' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الحالة' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/forms/form-1/responses/resp-1/status', {
        method: 'PATCH',
        body: { status: 'REJECTED', reason: 'الصور غير واضحة' },
      }),
    );
    expect(await screen.findByRole('heading', { name: 'سبب الرفض' })).toBeTruthy();
    expect(screen.getByText('السبب: الصور غير واضحة')).toBeTruthy();

    // المشاركة: نافذة تُفتح عند النقر ثم يُوجَّه إليها رابط واتساب من الخادم؛ لا إرسال تلقائي
    const win = { opener: {}, location: { href: '' }, close: vi.fn() };
    const open = vi.fn(() => win);
    vi.stubGlobal('open', open);
    const url = 'https://wa.me/966500000097?text=%D8%A7%D9%84%D8%B3%D9%84%D8%A7%D9%85';
    apiMock.mockImplementationOnce(() => Promise.resolve({ url }));
    fireEvent.click(screen.getByRole('button', { name: 'مشاركة سبب الرفض مع العميل' }));
    await waitFor(() => expect(win.location.href).toBe(url));
    expect(win.opener).toBeNull();
    expect(apiMock).toHaveBeenCalledWith('/forms/form-1/responses/resp-1/rejection-share', {
      method: 'POST',
    });
    expect(screen.getByText(/فُتح واتساب برسالة جاهزة/)).toBeTruthy();

    // بلا رقم صالح: رسالة واضحة وتُغلق النافذة
    apiMock.mockImplementationOnce(() =>
      Promise.reject(
        new ApiError(422, 'REJECTION_SHARE_NO_PHONE', 'لا يوجد رقم جوال صالح في هذا الرد.'),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'مشاركة سبب الرفض مع العميل' }));
    expect(await screen.findByText('لا يوجد رقم جوال صالح في هذا الرد.')).toBeTruthy();
    expect(win.close).toHaveBeenCalled();
  });

  it('سجل التعديلات يعرض الأصلية والمعدلة ومن عدّل، والرد المرسل لا يُعدَّل', async () => {
    state.me = REVIEWER;
    apiMock.mockImplementation((path: string) => {
      if (path === '/forms/form-1/responses/resp-1') {
        return Promise.resolve({
          ...detail,
          locked: true,
          editRevision: 1,
          edits: [
            {
              revision: 1,
              questionId: 'q-city',
              questionTitle: 'المدينة',
              oldValue: { kind: 'text', value: 'الرياض' },
              newValue: { kind: 'text', value: 'جدة' },
              editedBy: 'مراجع',
              editedAt: '2026-10-01T12:00:00Z',
            },
          ],
        });
      }
      return Promise.resolve(flowmaxState);
    });
    render(<ResponseDetailPage />);
    expect(await screen.findByRole('heading', { name: 'سجل التعديلات' })).toBeTruthy();
    expect(screen.getByText('الرياض')).toBeTruthy();
    expect(screen.getAllByText('جدة').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'تعديل بيانات الرد' })).toBeNull();
    expect(screen.getByText(/أُرسل هذا الرد إلى Flowmax، فلا يمكن تعديله/)).toBeTruthy();
  });

  it('الاعتماد بعد التعديل يطلب تأكيدًا ويرسل رقم المراجعة', async () => {
    state.me = REVIEWER;
    flowmaxState = { ...flowmaxState, editRevision: 2 };
    render(<ResponseDetailPage />);
    const approve = await screen.findByRole('button', { name: 'اعتماد وإرسال إلى Flowmax' });
    fireEvent.click(approve);
    expect(await screen.findByText('تأكيد الاعتماد بعد التعديل')).toBeTruthy();
    expect(apiMock).not.toHaveBeenCalledWith(
      '/forms/form-1/responses/resp-1/flowmax/approve',
      expect.anything(),
    );
    apiMock.mockImplementationOnce(() => Promise.resolve(flowmaxState));
    fireEvent.click(screen.getByRole('button', { name: 'اعتماد بالقيم المعدلة' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/forms/form-1/responses/resp-1/flowmax/approve', {
        method: 'POST',
        body: { excludeFileIds: [], editRevision: 2 },
      }),
    );
    flowmaxState = { ...flowmaxState, editRevision: 0 };
  });

  it('الرد المرفوض: لا زر اعتماد ولا رابط أو مشاركة', async () => {
    state.me = REVIEWER;
    flowmaxState = { ...flowmaxState, rejected: true, precheck: null };
    render(<ResponseDetailPage />);
    expect(await screen.findByText(/هذا الرد مرفوض، فلا يُرسل إلى Flowmax/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'اعتماد وإرسال إلى Flowmax' })).toBeNull();
    expect(screen.queryByText('مشاركة واتساب')).toBeNull();
    flowmaxState = {
      ...flowmaxState,
      rejected: false,
      precheck: { problems: [], incompatibleMedia: [], notices: [] },
    };
  });
});

describe('تعديلات الرد المرسلة', () => {
  const edit: EditForm = {
    revision: 0,
    locked: false,
    status: 'NEW',
    questions: [
      {
        id: 'kind',
        type: 'SINGLE_CHOICE',
        title: 'وش ترغب تسجّل؟',
        description: null,
        required: true,
        settings: {},
        options: [
          { id: 'o-offer', label: 'عرض عقار' },
          { id: 'o-request', label: 'طلب عقار' },
        ],
        showIf: null,
      },
      {
        id: 'price',
        type: 'NUMBER',
        title: 'السعر',
        description: null,
        required: true,
        settings: { allowDecimals: false },
        options: [],
        showIf: { questionId: 'kind', optionIds: ['o-offer'] },
      },
      {
        id: 'budget',
        type: 'NUMBER',
        title: 'الميزانية',
        description: null,
        required: true,
        settings: { allowDecimals: false },
        options: [],
        showIf: { questionId: 'kind', optionIds: ['o-request'] },
      },
    ],
    values: { kind: 'o-offer', price: '900000' },
    files: {},
  };

  it('تُرسل الأسئلة الظاهرة التي تغيّرت فقط، ولا يُرسل الفرع المخفي', () => {
    const questions = toRenderQuestions(edit);
    expect(changedAnswers(questions, edit.values, { ...edit.values })).toEqual([]);
    expect(
      changedAnswers(questions, edit.values, {
        kind: 'o-request',
        price: '950000',
        budget: '70000',
      }),
    ).toEqual([
      { questionId: 'kind', value: 'o-request' },
      { questionId: 'budget', value: '70000' },
    ]);
    expect(changedAnswers(questions, edit.values, { kind: 'o-offer', price: ' ' })).toEqual([
      { questionId: 'price', value: null },
    ]);
  });
});
