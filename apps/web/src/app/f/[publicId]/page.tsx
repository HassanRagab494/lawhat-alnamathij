import type { Metadata } from 'next';
import { PublicFormView } from './public-form-view';

export const metadata: Metadata = { title: 'تعبئة نموذج', referrer: 'no-referrer' };

export default async function PublicFormPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6 sm:py-10">
      <PublicFormView publicId={publicId} />
    </main>
  );
}
