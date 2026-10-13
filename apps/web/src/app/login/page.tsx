import type { Metadata } from 'next';
import { Suspense } from 'react';
import { site } from '@/config/site';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'تسجيل الدخول' };

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <span
            aria-hidden="true"
            className="grid size-14 place-items-center rounded-2xl bg-velvet-700 text-2xl font-bold text-white shadow-lg shadow-velvet-900/20"
          >
            ل
          </span>
          <h1 className="text-2xl font-bold text-velvet-900">{site.name}</h1>
          <p className="text-sm text-muted">سجّل الدخول بحسابك للمتابعة</p>
        </div>
        <Suspense>
          <LoginForm />
        </Suspense>
        <p className="mt-6 text-center text-xs text-muted">
          الحسابات يُنشئها مدير النظام. إذا نسيت كلمة المرور فتواصل معه لإعادة تعيينها.
        </p>
      </div>
    </main>
  );
}
