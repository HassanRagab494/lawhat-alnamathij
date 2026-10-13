'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, TextInput } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { Me } from '@/lib/types';

/** يقبل مسارات داخلية فقط لمنع إعادة التوجيه المفتوحة. */
function safeNext(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\'))
    return '/';
  return value;
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);

  // إن كانت هناك جلسة صالحة فلا داعي لعرض نموذج الدخول.
  useEffect(() => {
    api<Me>('/auth/me')
      .then(() => router.replace(next))
      .catch(() => usernameRef.current?.focus());
  }, [next, router]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const errors: Record<string, string> = {};
    if (!username.trim()) errors.username = 'اسم المستخدم مطلوب.';
    if (!password) errors.password = 'كلمة المرور مطلوبة.';
    setFieldErrors(errors);
    setError(null);
    if (Object.keys(errors).length) return;

    setSubmitting(true);
    try {
      await api('/auth/login', { method: 'POST', body: { username, password } });
      router.replace(next);
    } catch (e) {
      setPassword('');
      if (e instanceof ApiError && e.fields.length) setFieldErrors(e.fieldMap());
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-6 sm:p-8">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="اسم المستخدم" error={fieldErrors.username} required>
          {({ id, describedBy, invalid }) => (
            <TextInput
              ref={usernameRef}
              id={id}
              name="username"
              dir="ltr"
              className="text-start"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              required
            />
          )}
        </Field>
        <Field label="كلمة المرور" error={fieldErrors.password} required>
          {({ id, describedBy, invalid }) => (
            <TextInput
              id={id}
              name="password"
              type="password"
              dir="ltr"
              className="text-start"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              required
            />
          )}
        </Field>
        <Button type="submit" loading={submitting} className="w-full">
          تسجيل الدخول
        </Button>
      </form>
    </Card>
  );
}
