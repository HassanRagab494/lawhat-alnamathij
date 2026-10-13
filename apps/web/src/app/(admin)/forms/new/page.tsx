'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FormBasicsFields, validateFormBasics } from '@/components/form-fields';
import { RequirePermission } from '@/components/guards';
import { Alert, Button, Card, LinkButton, PageHeader } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { FormItem } from '@/lib/types';

function NewForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
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
        body: { title, description: description.trim() ? description : null },
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
