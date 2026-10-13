import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AuthProvider } from '@/lib/auth-context';
import FormDetailsPage from '@/app/(admin)/forms/[id]/page';
import { FormRenderer } from './form-renderer';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/forms/f1',
  useParams: () => ({ id: 'f1' }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}));

// jsdom لا يدعم <dialog>.showModal
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const draft = {
  id: 'f1',
  title: 'نموذج الاختبار',
  description: null,
  publicationStatus: 'draft',
  isArchived: false,
  revision: 2,
  createdBy: { id: 'u', displayName: 'مدير' },
  createdAt: '2026-10-13T00:00:00.000Z',
  updatedAt: '2026-10-13T00:00:00.000Z',
  archivedAt: null,
  questions: [
    {
      id: 'q1',
      type: 'SHORT_TEXT',
      title: 'الاسم',
      description: null,
      required: true,
      settings: {},
      options: [],
    },
  ],
};

function mount(me: object, onPut: (body: any) => Response | Promise<Response>) {
  const puts: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') return new Response(JSON.stringify(me));
      if (url === '/api/forms/f1/draft' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return onPut(body);
      }
      if (url === '/api/forms/f1/draft') return new Response(JSON.stringify(draft));
      return new Response('{}', { status: 404 });
    }),
  );
  render(
    <AuthProvider fallback={<p>loading</p>} errorView={(m) => <p>{m}</p>}>
      <FormDetailsPage />
    </AuthProvider>,
  );
  return puts;
}

const admin = { id: 'u', username: 'admin', displayName: 'مدير', role: 'ADMIN', permissions: [] };
const viewer = {
  id: 'v',
  username: 'viewer',
  displayName: 'مشاهد',
  role: 'SUPERVISOR',
  permissions: ['FORMS_VIEW'],
};

describe('محرر النموذج', () => {
  it('يحتفظ بالتعديلات المحلية عند التعارض ويعرض نسخة الخادم مع خيارات المعالجة', async () => {
    const latest = { ...draft, revision: 3, title: 'عنوان أحدث من مستخدم آخر' };
    const puts = mount(
      admin,
      () =>
        new Response(
          JSON.stringify({
            statusCode: 409,
            code: 'REVISION_CONFLICT',
            message: 'تعارض',
            details: { current: latest },
          }),
          { status: 409 },
        ),
    );
    const title = await screen.findByLabelText(/^عنوان السؤال/);
    fireEvent.change(title, { target: { value: 'الاسم الكامل' } });
    expect(screen.getByText('● لديك تغييرات غير محفوظة')).toBeTruthy();
    fireEvent.click(screen.getByText('حفظ التغييرات'));

    await screen.findByText('عدّل شخص آخر هذا النموذج بعد أن فتحته');
    expect(puts[0].revision).toBe(2);
    expect(screen.getByText('عنوان أحدث من مستخدم آخر')).toBeTruthy();
    expect((screen.getByLabelText(/^عنوان السؤال/) as HTMLInputElement).value).toBe('الاسم الكامل');

    fireEvent.click(screen.getByText('الإبقاء على تعديلاتي لمراجعتها'));
    expect((screen.getByLabelText(/^عنوان السؤال/) as HTMLInputElement).value).toBe('الاسم الكامل');
    expect(screen.getByText('رقم مراجعة المسودة').nextSibling?.textContent).toBe('3');
  });

  it('يحتفظ بالتعديلات عند فشل الشبكة ويعرض أخطاء الخادم بجانب الحقل', async () => {
    let call = 0;
    mount(admin, () => {
      call++;
      if (call === 1) throw new TypeError('network down');
      return new Response(
        JSON.stringify({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: 'بعض البيانات المدخلة غير صحيحة.',
          fields: [{ field: 'questions.0.title', message: 'رسالة من الخادم' }],
        }),
        { status: 400 },
      );
    });
    const title = await screen.findByLabelText(/^عنوان السؤال/);
    fireEvent.change(title, { target: { value: 'تعديل محلي' } });
    fireEvent.click(screen.getByText('حفظ التغييرات'));
    await screen.findByText(/تعذر الاتصال بالخادم/);
    expect((screen.getByLabelText(/^عنوان السؤال/) as HTMLInputElement).value).toBe('تعديل محلي');

    fireEvent.click(screen.getByText('حفظ التغييرات'));
    await screen.findByText('رسالة من الخادم');
    expect((screen.getByLabelText(/^عنوان السؤال/) as HTMLInputElement).value).toBe('تعديل محلي');
  });

  it('لا يرسل سؤالًا ناقصًا ويعرض الخطأ بجانبه مع إبقائه في المحرر', async () => {
    const puts = mount(admin, () => new Response(JSON.stringify(draft)));
    await screen.findByLabelText(/^عنوان السؤال/);
    fireEvent.click(screen.getByText('+ إضافة سؤال'));
    expect(screen.getAllByLabelText(/^عنوان السؤال/)).toHaveLength(2);
    fireEvent.click(screen.getByText('حفظ التغييرات'));
    await screen.findByText(/لم يُحفظ شيء. أكمل أو صحّح السؤال 2/);
    expect(screen.getByText('عنوان السؤال مطلوب.')).toBeTruthy();
    expect(puts).toHaveLength(0);
    expect(screen.getAllByLabelText(/^عنوان السؤال/)).toHaveLength(2);
  });

  it('رفض الحجم (413) يعرض رسالة الخادم ويحتفظ بكل التعديلات ويسمح بإعادة المحاولة', async () => {
    const message =
      'حجم المسودة يتجاوز الحد المسموح (4 ميغابايت). لم يُحفظ شيء؛ قلّل المحتوى ثم أعد المحاولة.';
    let call = 0;
    const puts = mount(admin, (body) => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message }),
          {
            status: 413,
          },
        );
      }
      return new Response(
        JSON.stringify({
          ...draft,
          revision: 3,
          questions: body.questions.map((q: any, i: number) => ({
            ...q,
            id: q.id ?? `new-${i}`,
            options: [],
          })),
        }),
      );
    });
    const title = await screen.findByLabelText(/^عنوان السؤال/);
    fireEvent.change(title, { target: { value: 'عنوان معدّل محليًا' } });
    fireEvent.click(screen.getByText('+ إضافة سؤال'));
    const titles = screen.getAllByLabelText(/^عنوان السؤال/);
    fireEvent.change(titles[1]!, { target: { value: 'سؤال جديد غير محفوظ' } });

    fireEvent.click(screen.getByText('حفظ التغييرات'));
    await screen.findByText(`لم يُحفظ شيء. ${message}`);
    const after = screen.getAllByLabelText(/^عنوان السؤال/) as HTMLInputElement[];
    expect(after.map((i) => i.value)).toEqual(['عنوان معدّل محليًا', 'سؤال جديد غير محفوظ']);
    expect(screen.getByText('● لديك تغييرات غير محفوظة')).toBeTruthy();
    expect((screen.getByText('حفظ التغييرات') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByText('حفظ التغييرات'));
    await screen.findByText('تم حفظ التغييرات.');
    expect(puts).toHaveLength(2);
    expect(puts[1].questions.map((q: any) => q.title)).toEqual([
      'عنوان معدّل محليًا',
      'سؤال جديد غير محفوظ',
    ]);
  });

  it('صاحب صلاحية العرض فقط لا يرى أدوات التعديل', async () => {
    mount(viewer, () => new Response('{}', { status: 403 }));
    await screen.findByText('الأسئلة (1)');
    expect(screen.queryByText('حفظ التغييرات')).toBeNull();
    expect(screen.queryByText('+ إضافة سؤال')).toBeNull();
    expect(screen.queryByLabelText(/^عنوان السؤال/)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /المعاينة/ }));
    expect(screen.getByText('معاينة — لن تُحفظ الإجابات')).toBeTruthy();
  });
});

describe('FormRenderer', () => {
  const questions = [
    {
      key: 'a',
      type: 'SHORT_TEXT' as const,
      title: 'الاسم',
      description: null,
      required: true,
      settings: { minLength: 3 },
      options: [],
    },
    {
      key: 'f',
      type: 'FILE_UPLOAD' as const,
      title: 'المرفق',
      description: null,
      required: false,
      settings: { allowedTypes: ['pdf' as const], maxFileSizeMb: 5, maxFiles: 2 },
      options: [],
    },
  ];

  it('معاينة دون إرسال: لا زر إرسال، والتحقق يعرض الأخطاء، والملف معطّل', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(<FormRenderer title="نموذج" description={null} questions={questions} />);
    expect(screen.getByText('معاينة — لن تُحفظ الإجابات')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /إرسال/ })).toBeNull();

    fireEvent.click(screen.getByText('تجربة التحقق من الإجابات'));
    expect(screen.getByText('هذا السؤال إجباري.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/الاسم/), { target: { value: 'ab' } });
    fireEvent.click(screen.getByText('تجربة التحقق من الإجابات'));
    expect(screen.getByText(/لا تقل الإجابة عن 3/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/الاسم/), { target: { value: 'سارة' } });
    fireEvent.click(screen.getByText('تجربة التحقق من الإجابات'));
    expect(screen.getByText(/الإجابات صالحة/)).toBeTruthy();

    const file = screen.getByLabelText('المرفق') as HTMLInputElement;
    expect(file.disabled).toBe(true);
    expect(screen.getByText(/رفع الملفات الفعلي غير متاح بعد/)).toBeTruthy();
    expect(within(document.body).getByText(/الحجم الأقصى لكل ملف: 5/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
