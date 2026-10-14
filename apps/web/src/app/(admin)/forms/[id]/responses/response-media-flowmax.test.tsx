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
const draftSent: FlowmaxState = {
  integrationEnabled: true,
  mappingEnabled: true,
  precheck: null,
  sync: {
    status: 'SENT',
    operation: 'OFFER',
    flowmaxId: '1001',
    flowmaxRef: 'M-1001',
    detailUrl: 'https://flowmax.test/property/1001',
    remoteStatus: 'Draft',
    isPublic: false,
    publishState: 'NONE',
    publishError: null,
    sentAt: '2026-10-14T10:00:00Z',
    approvedAt: '2026-10-14T09:59:00Z',
    lastError: null,
    attempts: 1,
    media: [
      { fileId: 'f-png', role: 'image', status: 'SENT', error: null, excludedReason: null },
      { fileId: 'f-mp4', role: 'video', status: 'SENT', error: null, excludedReason: null },
    ],
    share: null,
  },
};
const published: FlowmaxState = {
  ...draftSent,
  sync: {
    ...draftSent.sync!,
    remoteStatus: 'Published',
    isPublic: true,
    publishState: 'PUBLISHED',
    share,
  },
};
const notApproved: FlowmaxState = {
  integrationEnabled: true,
  mappingEnabled: true,
  sync: null,
  precheck: { problems: [], incompatibleMedia: [] },
};

let canPlay = 'maybe';
beforeEach(() => {
  apiMock.mockReset();
  state.flowmax = notApproved;
  canPlay = 'maybe';
  HTMLMediaElement.prototype.canPlayType = () => canPlay as CanPlayTypeResult;
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
  expect(screen.queryByAltText(/صك\.pdf/)).toBeNull();
  const dl = screen.getByRole('link', { name: 'تنزيل صك.pdf' });
  expect(dl.getAttribute('href')).toBe(`${BASE}/f-pdf`);
  for (const el of document.querySelectorAll('img[src], source[src], a[href*="files"]')) {
    expect(el.getAttribute('src') ?? el.getAttribute('href')).toMatch(/^\/api\/forms\/form-1\//);
  }
});

it('ترميز فيديو لا يدعمه المتصفح: رسالة واضحة وخيار التنزيل بدل مشغّل معطّل', async () => {
  canPlay = '';
  state.me = user(FILES);
  render(<ResponseDetailPage />);
  const notes = await screen.findAllByText(
    'هذا المتصفح لا يدعم تشغيل ترميز هذا الفيديو داخل الصفحة.',
  );
  expect(notes).toHaveLength(2);
  const links = screen.getAllByRole('link', { name: 'تنزيل الفيديو لمشاهدته' });
  expect(links.map((a) => a.getAttribute('href')).sort()).toEqual([
    `${BASE}/f-mp4`,
    `${BASE}/f-webm`,
  ]);
  expect(document.querySelector('video')).toBeNull();
});

it('فشل فك الترميز أثناء التحميل يعرض الرسالة نفسها', async () => {
  state.me = user(FILES);
  render(<ResponseDetailPage />);
  const mp4 = (await screen.findByLabelText('فيديو: جولة.mp4')) as HTMLVideoElement;
  fireEvent.error(mp4);
  expect(
    await screen.findByText('هذا المتصفح لا يدعم تشغيل ترميز هذا الفيديو داخل الصفحة.'),
  ).toBeTruthy();
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

it('قبل الاعتماد: الحقول الناقصة تُعرض والزر معطّل', async () => {
  state.flowmax = {
    ...notApproved,
    precheck: {
      problems: [{ field: 'city', message: '«المدينة»: الإجابة مطلوبة لإنشاء العقار.' }],
      incompatibleMedia: [],
    },
  };
  state.me = user(REVIEW);
  render(<ResponseDetailPage />);
  expect(await screen.findByText('«المدينة»: الإجابة مطلوبة لإنشاء العقار.')).toBeTruthy();
  const approve = screen.getByRole('button', { name: 'اعتماد وإرسال إلى Flowmax' });
  expect((approve as HTMLButtonElement).disabled).toBe(true);
});

it('مرفق غير متوافق: يُعرض بسببه ويمنع الاعتماد حتى يُستبعد صراحة، ويُرسل الاستبعاد', async () => {
  state.flowmax = {
    ...notApproved,
    precheck: {
      problems: [],
      incompatibleMedia: [
        {
          fileId: 'f-mp4',
          name: 'جولة.mp4',
          reason: 'حجم الفيديو 120.0MB يتجاوز حد Flowmax (100MB).',
        },
      ],
    },
  };
  state.me = user(REVIEW);
  render(<ResponseDetailPage />);
  const approve = (await screen.findByRole('button', {
    name: 'اعتماد وإرسال إلى Flowmax',
  })) as HTMLButtonElement;
  expect(screen.getByText(/يتجاوز حد Flowmax \(100MB\)/)).toBeTruthy();
  expect(approve.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  expect(approve.disabled).toBe(false);
  apiMock.mockResolvedValueOnce(draftSent);
  fireEvent.click(approve);
  await waitFor(() =>
    expect(apiMock).toHaveBeenCalledWith('/forms/form-1/responses/resp-1/flowmax/approve', {
      method: 'POST',
      body: { excludeFileIds: ['f-mp4'] },
    }),
  );
});

it('اعتماد مرفوض من الخادم: رسائل عربية لكل حقل', async () => {
  state.me = user(REVIEW);
  render(<ResponseDetailPage />);
  const approve = await screen.findByRole('button', { name: 'اعتماد وإرسال إلى Flowmax' });
  apiMock.mockRejectedValueOnce(
    new ApiError(422, 'FLOWMAX_INCOMPLETE', 'لا يمكن اعتماد الرد.', [
      { field: 'flowmax.city', message: '«المدينة»: الإجابة مطلوبة لإنشاء العقار.' },
    ]),
  );
  fireEvent.click(approve);
  expect(await screen.findByText('«المدينة»: الإجابة مطلوبة لإنشاء العقار.')).toBeTruthy();
});

it('المسودة المرسلة: رابط التفاصيل للإدارة وزر النشر، بلا مشاركة عامة', async () => {
  state.flowmax = draftSent;
  state.me = user(REVIEW);
  render(<ResponseDetailPage />);
  expect(await screen.findByText('رابط التفاصيل (غير منشور بعد):')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'مشاركة العقار' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'مشاركة واتساب' })).toBeNull();
  apiMock.mockResolvedValueOnce(published);
  fireEvent.click(screen.getByRole('button', { name: 'نشر في Flowmax' }));
  expect(await screen.findByRole('button', { name: 'مشاركة العقار' })).toBeTruthy();
  expect(apiMock).toHaveBeenCalledWith('/forms/form-1/responses/resp-1/flowmax/publish', {
    method: 'POST',
    body: {},
  });
});

it('فشل النشر: السبب وزر إعادة المحاولة، ولا مشاركة', async () => {
  state.flowmax = {
    ...draftSent,
    sync: {
      ...draftSent.sync!,
      publishState: 'FAILED',
      publishError: 'متطلبات النشر في Flowmax غير مكتملة: images.',
    },
  };
  state.me = user(REVIEW);
  render(<ResponseDetailPage />);
  expect(await screen.findByText('متطلبات النشر في Flowmax غير مكتملة: images.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'إعادة محاولة النشر' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'مشاركة العقار' })).toBeNull();
});

it('فشل مرفق: يظهر بوضوح مع زر إعادة المحاولة للمراجع فقط', async () => {
  const failed: FlowmaxState = {
    ...draftSent,
    sync: {
      ...draftSent.sync!,
      status: 'FAILED',
      lastError: 'لم يكتمل نقل 1 من المرفقات؛ أعد المحاولة.',
      media: [
        {
          fileId: 'f-png',
          role: 'image',
          status: 'FAILED',
          error: 'خطأ من Flowmax (500).',
          excludedReason: null,
        },
        { fileId: 'f-mp4', role: 'video', status: 'SENT', error: null, excludedReason: null },
      ],
    },
  };
  state.flowmax = failed;
  state.me = user(REVIEW);
  render(<ResponseDetailPage />);
  expect(await screen.findByText('لم يكتمل نقل 1 من المرفقات؛ أعد المحاولة.')).toBeTruthy();
  expect(screen.getByText('فشل النقل — خطأ من Flowmax (500).')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'نشر في Flowmax' })).toBeNull();
  apiMock.mockResolvedValueOnce(draftSent);
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  await waitFor(() =>
    expect(apiMock).toHaveBeenCalledWith('/forms/form-1/responses/resp-1/flowmax/retry', {
      method: 'POST',
      body: {},
    }),
  );

  cleanup();
  state.me = user(VIEW);
  render(<ResponseDetailPage />);
  expect(await screen.findByText('لم يكتمل نقل 1 من المرفقات؛ أعد المحاولة.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'إعادة المحاولة' })).toBeNull();
});

it('الطلب: رابط تفاصيل الطلب وتحديث الحالة، دون زر نشر', async () => {
  state.flowmax = {
    ...draftSent,
    sync: {
      ...draftSent.sync!,
      operation: 'REQUEST',
      flowmaxRef: 'PD1001',
      detailUrl: 'https://flowmax.test/properties/demands/PD1001',
      media: [],
    },
  };
  state.me = user(REVIEW);
  render(<ResponseDetailPage />);
  expect(
    await screen.findByRole('link', { name: 'https://flowmax.test/properties/demands/PD1001' }),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'نشر في Flowmax' })).toBeNull();
  expect(screen.getByRole('button', { name: 'تحديث الحالة من Flowmax' })).toBeTruthy();
});

it('بعد النشر: مشاركة واتساب ونسخ الرابط دون بيانات المالك', async () => {
  state.flowmax = published;
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
  expect(text).toContain('https://flowmax.test/property/1001');
  expect(text).not.toMatch(/سارة|05\d{8}|\+966/);
  expect(href).not.toMatch(/[\s؀-ۿ]/);
  expect(wa.getAttribute('rel')).toContain('noopener');
  fireEvent.click(screen.getByRole('button', { name: 'نسخ الرابط' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://flowmax.test/property/1001'));
  expect(await screen.findByText('نُسخ الرابط.')).toBeTruthy();
});
