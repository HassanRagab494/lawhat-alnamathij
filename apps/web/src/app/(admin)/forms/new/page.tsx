'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FormBasicsFields, validateFormBasics } from '@/components/form-fields';
import { RequirePermission } from '@/components/guards';
import { Alert, Button, Card, LinkButton, PageHeader } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { FormItem } from '@/lib/types';

type Template = 'blank' | 'real-estate-unified';

const TEMPLATES: { value: Template; title: string; description: string }[] = [
  { value: 'blank', title: 'نموذج فارغ', description: 'ابدأ بلا أسئلة وأضفها من المحرر.' },
  {
    value: 'real-estate-unified',
    title: 'نموذج عقاري موحّد',
    description:
      'يبدأ بسؤال «وش ترغب تسجّل؟» (عرض عقار أو طلب عقار)، ثم تظهر أسئلة كل مسار وشروطها جاهزة، ومربوطة بـ Flowmax.',
  },
];

function NewForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState<Template>('blank');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const local = validateFormBasics(title);
    setErrors(local);
    setError(null);
    if (Object.keys(local).length) return;
    setSubmitting(true);
    try {
      const form = await api<FormItem>('/forms', {
        method: 'POST',
        body: {
          title,
          description: description.trim() ? description : null,
          ...(template === 'blank' ? {} : { template }),
        },
      });
      router.push(`/forms/${form.id}?created=1`);
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldMap());
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="إنشاء نموذج"
        description="سيُحفظ النموذج كمسودة غير منشورة، ويمكنك تعديل بياناته لاحقًا."
        back={{ href: '/forms', label: 'النماذج' }}
      />
      <Card className="max-w-2xl p-5 sm:p-6">
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
          {error && <Alert tone="error">{error}</Alert>}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold text-ink">طريقة البدء</legend>
            {TEMPLATES.map((t) => (
              <label
                key={t.value}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
                  template === t.value
                    ? 'border-velvet-500 bg-velvet-50'
                    : 'border-smoke-300 bg-white/70 hover:border-velvet-300'
                }`}
              >
                <input
                  type="radio"
                  name="template"
                  className="mt-0.5 size-5 accent-velvet-700"
                  checked={template === t.value}
                  onChange={() => {
                    setTemplate(t.value);
                    if (t.value !== 'blank' && !title.trim()) setTitle(t.title);
                  }}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-semibold text-ink">{t.title}</span>
                  <span className="text-xs text-muted">{t.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <FormBasicsFields
            title={title}
            description={description}
            errors={errors}
            onTitle={setTitle}
            onDescription={setDescription}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={submitting}>
              إنشاء نموذج
            </Button>
            <LinkButton href="/forms" variant="secondary">
              إلغاء
            </LinkButton>
          </div>
        </form>
      </Card>
    </>
  );
}

export default function NewFormPage() {
  return (
    <RequirePermission permission="FORMS_CREATE">
      <NewForm />
    </RequirePermission>
  );
}
