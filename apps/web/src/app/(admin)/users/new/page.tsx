'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/guards';
import { NewPasswordFields, validateNewPassword } from '@/components/password-fields';
import { PermissionPicker } from '@/components/permission-picker';
import { Alert, Button, Card, Field, LinkButton, PageHeader, TextInput } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { Permission, UserItem } from '@/lib/types';

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{2,30})[a-z0-9]$/;

function NewSupervisor() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [permissions, setPermissions] = useState<Permission[]>(['FORMS_VIEW']);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const local: Record<string, string> = validateNewPassword(password, confirm);
    const normalized = username.trim().toLowerCase();
    if (!normalized) local.username = 'اسم المستخدم مطلوب.';
    else if (!USERNAME_PATTERN.test(normalized)) {
      local.username =
        'من 4 إلى 32 حرفًا لاتينيًا صغيرًا أو أرقامًا، ويمكن أن يحتوي على . أو _ أو - في الوسط.';
    }
    if (displayName.trim().length < 2) local.displayName = 'الاسم يجب ألا يقل عن حرفين.';
    setErrors(local);
    setError(null);
    if (Object.keys(local).length) return;

    setSubmitting(true);
    try {
      const user = await api<UserItem>('/users', {
        method: 'POST',
        body: { username: normalized, displayName, password, permissions },
      });
      router.push(`/users/${user.id}?created=1`);
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldMap());
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="إنشاء مشرف"
        description="سلّم المشرف اسم المستخدم وكلمة المرور بطريقة آمنة، ويمكنه تغييرها من صفحة حسابه."
        back={{ href: '/users', label: 'المستخدمون' }}
      />
      <Card className="max-w-2xl p-5 sm:p-6">
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
          {error && <Alert tone="error">{error}</Alert>}
          <Field label="الاسم" error={errors.displayName} required>
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                value={displayName}
                maxLength={100}
                autoComplete="off"
                onChange={(e) => setDisplayName(e.target.value)}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                required
              />
            )}
          </Field>
          <Field
            label="اسم المستخدم"
            error={errors.username}
            required
            hint="أحرف لاتينية صغيرة وأرقام، مثل sara.ali"
          >
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                dir="ltr"
                className="text-start"
                value={username}
                maxLength={32}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => setUsername(e.target.value)}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                required
              />
            )}
          </Field>
          <NewPasswordFields
            password={password}
            confirm={confirm}
            errors={errors}
            onPassword={setPassword}
            onConfirm={setConfirm}
          />
          <PermissionPicker
            value={permissions}
            onChange={setPermissions}
            error={errors.permissions}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={submitting}>
              إنشاء مشرف
            </Button>
            <LinkButton href="/users" variant="secondary">
              إلغاء
            </LinkButton>
          </div>
        </form>
      </Card>
    </>
  );
}

export default function NewSupervisorPage() {
  return (
    <RequirePermission adminOnly>
      <NewSupervisor />
    </RequirePermission>
  );
}
