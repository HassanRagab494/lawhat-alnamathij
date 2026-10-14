import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Me } from '@/lib/types';
import type { FlowmaxState } from '@/lib/flowmax';

const { apiMock, state } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  state: { me: null as Me | null, flowmax: null as unknown },
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

import { ApiError } from '@/lib/api';
import ResponseDetailPage from './[responseId]/page';

const user = (permissions: Me['permissions']): Me => ({
  id: 'u',
  username: 'u',
  displayName: 'u',
  role: 'SUPERVISOR',
  permissions,
});
const VIEW: Me['permissions'] = ['FORMS_VIEW', 'RESPONSES_VIEW'];
const FILES: Me['permissions'] = [...VIEW, 'RESPONSES_FILES_DOWNLOAD'];
const REVIEW: Me['permissions'] = [...VIEW, 'RESPONSES_REVIEW'];

const file = (id: string, name: string, kind: string, previewable: boolean) => ({
  id,
  name,
  size: 4096,
  kind,
  malwareScanned: false,
  previewable,
});

const detail = {
  id: 'resp-1',
  referenceCode: 'AAAA-BBBB-CCCC',
  submittedAt: '2026-10-14T09:00:00Z',
  status: 'NEW',
  formId: 'form-1',
  formTitle: 'عروض العقارات',
  version: { versionNumber: 1, title: 'عروض العقارات', description: null, publishedAt: 'x' },
  answers: [
    {
      questionId: 'q1',
      position: 0,
      type: 'FILE_UPLOAD',
      title: 'الوسائط',
      description: null,
      required: false,
      kind: 'files',
      files: [
        file('f-png', 'واجهة.png', 'PNG', true),
        file('f-mp4', 'جولة.mp4', 'MP4', true),
        file('f-webm', 'تسجيل.webm', 'WEBM', true),
        file('f-pdf', 'صك.pdf', 'PDF', false),
      ],
    },
  ],
  statusHistory: [],
};

const share = {
  title: 'شقة مطلة على الحديقة',
  operation: 'OFFER' as const,
  purpose: 'بيع',
  category: 'شقة',
  city: 'الرياض',
  district: 'النرجس',
  priceSar: '850000',
};
const sent: FlowmaxState = {
  integrationEnabled: true,
  mappingEnabled: true,
  sync: {
    status: 'SENT',
    operation: 'OFFER',
    flowmaxId: '1001',
    flowmaxRef: 'M-1001',
    url: 'https://flowmax.test/property/1001',
    sentAt: '2026-10-14T10:00:00Z',
    approvedAt: '2026-10-14T09:59:00Z',
    lastError: null,
    attempts: 1,
    published: false,
    mediaSent: 3,
    mediaSkipped: 0,
    share,
  },
};
const notApproved: FlowmaxState = { integrationEnabled: true, mappingEnabled: true, sync: null };

beforeEach(() => {
  apiMock.mockReset();
  state.flowmax = notApproved;
  apiMock.mockImplementation((path: string) => {
    if (path === '/forms/form-1/responses/resp-1') return Promise.resolve(detail);
    if (path === '/forms/form-1/responses/resp-1/flowmax') return Promise.resolve(state.flowmax);
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});
afterEach(() => cleanup());

const BASE = '/api/forms/form-1/responses/resp-1/files';

it('معاينة الصور والفيديو عبر المسار المحمي، وPDF تنزيل فقط', async () => {
  state.me = user(FILES);
  render(<ResponseDetailPage />);
  const img = (await screen.findByAltText('صورة: واجهة.png')) as HTMLImageElement;
  expect(img.getAttribute('src')).toBe(`${BASE}/f-png?disposition=inline`);
  const mp4 = screen.getByLabelText('فيديو: جولة.mp4') as HTMLVideoElement;
  expect(mp4.controls).toBe(true);
  expect(mp4.querySelector('source')!.getAttribute('src')).toBe(`${BASE}/f-mp4?disposition=inline`);
  expect(mp4.querySelector('source')!.getAttribute('type')).toBe('video/mp4');
  const webm = screen.getByLabelText('فيديو: تسجيل.webm') as HTMLVideoElement;
  expect(webm.querySelector('source')!.getAttribute('type')).toBe('video/webm');
  // PDF: لا معاينة، تنزيل فقط
  expect(screen.queryByAltText(/صك\.pdf/)).toBeNull();
  const dl = screen.getByRole('link', { name: 'تنزيل صك.pdf' });
  expect(dl.getAttribute('href')).toBe(`${BASE}/f-pdf`);
  // كل الروابط عبر الـ API المحمي، لا روابط عامة للملفات
  for (const el of document.querySelectorAll('img[src], source[src], a[href*="files"]')) {
    expect(el.getAttribute('src') ?? el.getAttribute('href')).toMatch(/^\/api\/forms\/form-1\//);
  }
});

it('دون صلاحية الملفات: لا معاينة ولا تنزيل', async () => {
  state.me = user(VIEW);
  render(<ResponseDetailPage />);
  expect(await screen.findByText('واجهة.png')).toBeTruthy();
  expect(document.querySelector('img, video')).toBeNull();
  expect(screen.queryByRole('link', { name: /تنزيل/ })).toBeNull();
  expect(screen.getByText(/معاينة الملفات وتنزيلها يحتاجان صلاحية/)).toBeTruthy();
});

it('زر الاعتماد يظهر لمن يملك المراجعة فقط', async () => {
  state.me = user(VIEW);
  render(<ResponseDetailPage />);
  expect(await screen.findByText('لم يُعتمد هذا الرد للإرسال إلى Flowmax.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'اعتماد وإرسال إلى Flowmax' })).toBeNull();
});

it('اعتماد رد ناقص: رسائل عربية واضحة لكل حقل', async () => {
  state.me = user(REVIEW);
  render(<ResponseDetailPage />);
  const approve = await screen.findByRole('button', { name: 'اعتماد وإرسال إلى Flowmax' });
  apiMock.mockRejectedValueOnce(
    new ApiError(422, 'FLOWMAX_INCOMPLETE', 'لا يمكن اعتماد الرد: بيانات مطلوبة ناقصة.', [
      { field: 'flowmax.city', message: '«المدينة»: الإجابة مطلوبة لإنشاء العقار.' },
    ]),
  );
  fireEvent.click(approve);
  expect(await screen.findByText('«المدينة»: الإجابة مطلوبة لإنشاء العقار.')).toBeTruthy();
  expect(apiMock).toHaveBeenCalledWith('/forms/form-1/responses/resp-1/flowmax/approve', {
    method: 'POST',
    body: {},
  });
});

it('اعتماد ناجح: يتحدث حتى الإرسال ويعيد تحميل الرد', async () => {
  state.me = user(REVIEW);
  render(<ResponseDetailPage />);
  const approve = await screen.findByRole('button', { name: 'اعتماد وإرسال إلى Flowmax' });
  apiMock.mockResolvedValueOnce({ ...notApproved, sync: { ...sent.sync!, status: 'SENT' } });
  fireEvent.click(approve);
  expect(
    await screen.findByRole('link', { name: 'https://flowmax.test/property/1001' }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(apiMock.mock.calls.filter(([p]) => p === '/forms/form-1/responses/resp-1').length).toBe(
      2,
    ),
  );
});

it('فشل الإرسال: الخطأ وزر إعادة المحاولة للمراجع فقط', async () => {
  state.flowmax = {
    ...sent,
    sync: {
      ...sent.sync!,
      status: 'FAILED',
      url: null,
      share: null,
      lastError: 'خطأ من Flowmax (500).',
    },
  };
  state.me = user(REVIEW);
  render(<ResponseDetailPage />);
  expect(await screen.findByText('خطأ من Flowmax (500).')).toBeTruthy();
  const retry = screen.getByRole('button', { name: 'إعادة المحاولة' });
  apiMock.mockResolvedValueOnce(sent);
  fireEvent.click(retry);
  expect(await screen.findByRole('button', { name: 'مشاركة العقار' })).toBeTruthy();
  expect(apiMock).toHaveBeenCalledWith('/forms/form-1/responses/resp-1/flowmax/retry', {
    method: 'POST',
    body: {},
  });

  cleanup();
  state.me = user(VIEW);
  render(<ResponseDetailPage />);
  expect(await screen.findByText('خطأ من Flowmax (500).')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'إعادة المحاولة' })).toBeNull();
});

it('بعد النجاح: رابط العقار ومشاركة واتساب ونسخ الرابط دون بيانات المالك', async () => {
  state.flowmax = sent;
  state.me = user(VIEW);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  render(<ResponseDetailPage />);
  const wa = await screen.findByRole('link', { name: 'مشاركة واتساب' });
  const href = wa.getAttribute('href')!;
  expect(href.startsWith('https://wa.me/?text=')).toBe(true);
  const text = decodeURIComponent(href.slice('https://wa.me/?text='.length));
  expect(text).toContain('شقة مطلة على الحديقة');
  expect(text).toContain('الرياض — النرجس');
  expect(text).toContain('السعر: 850,000 ريال');
  expect(text).toContain('عرض — بيع — شقة');
  expect(text).toContain('https://flowmax.test/property/1001');
  expect(href).not.toMatch(/[\s؀-ۿ]/); // مرمّز كاملًا
  expect(wa.getAttribute('rel')).toContain('noopener');

  fireEvent.click(screen.getByRole('button', { name: 'نسخ الرابط' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://flowmax.test/property/1001'));
  expect(await screen.findByText('نُسخ الرابط.')).toBeTruthy();
  expect(screen.getByText(/يظهر الرابط للزوار بعد نشره/)).toBeTruthy();
});
