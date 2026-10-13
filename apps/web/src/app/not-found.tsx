import Link from 'next/link';
import { site } from '@/config/site';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <section className="glass w-full max-w-lg rounded-2xl p-8 text-center">
        <p className="mb-2 text-sm font-semibold text-velvet-600">{site.name}</p>
        <h1 className="mb-2 text-2xl font-bold text-velvet-900">الصفحة غير موجودة</h1>
        <p className="mb-6 text-sm text-muted">
          قد يكون الرابط غير صحيح أو أن الصفحة نُقلت. تحقق من العنوان أو عُد إلى الرئيسية.
        </p>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-velvet-600 px-4 py-2 text-sm font-semibold text-velvet-700 hover:bg-velvet-50"
        >
          العودة إلى الرئيسية
        </Link>
      </section>
    </main>
  );
}
