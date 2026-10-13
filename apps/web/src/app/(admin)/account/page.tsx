'use client';

import { useState, type FormEvent } from 'react';
import { NewPasswordFields, validateNewPassword } from '@/components/password-fields';
import { Alert, Button, Card, Field, PageHeader, TextInput } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { PERMISSION_LABELS, ROLE_LABELS } from '@/lib/permissions';

export default function AccountPage() {
  const { me } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!me) return null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const local = validateNewPassword(newPassword, confirm, 'newPassword');
    if (!currentPassword) local.currentPassword = 'كلمة المرور الحالية مطلوبة.';
    setErrors(local);
    setError(null);
    setSuccess(null);
    if (Object.keys(local).length) return;
    setSubmitting(true);
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
      setSuccess('تم تغيير كلمة المرور، وأُنهيت جلساتك على الأجهزة الأخرى.');
    } catch (e) {
      if (e instanceof ApiError && e.fields.length) setErrors(e.fieldMap());
      else setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader title="حسابي" description="بيانات حسابك وتغيير كلمة المرور." />
      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        <Card className="h-fit p-5">
          <h2 className="mb-4 text-base font-bold text-velvet-900">بيانات الحساب</h2>
          <dl className="flex flex-col gap-4 text-sm">
            <div>
              <dt className="text-xs font-semibold text-muted">الاسم</dt>
              <dd className="mt-1">{me.displayName}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-muted">اسم المستخدم</dt>
              <dd className="mt-1" dir="ltr">
                <span className="block text-end">{me.username}</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-muted">نوع الحساب</dt>
              <dd className="mt-1">{ROLE_LABELS[me.role]}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-muted">الصلاحيات</dt>
              <dd className="mt-1">
                {me.role === 'ADMIN'
                  ? 'جميع الصلاحيات'
                  : me.permissions.length
                    ? me.permissions.map((p) => PERMISSION_LABELS[p]).join('، ')
                    : 'بلا صلاحيات'}
              </dd>
            </div>
          </dl>
        </Card>

        <Card className="p-5 sm:p-6">
          <h2 className="mb-4 text-lg font-bold text-velvet-900">تغيير كلمة المرور</h2>
          <form onSubmit={onSubmit} noValidate className="flex max-w-lg flex-col gap-5">
            {error && <Alert tone="error">{error}</Alert>}
            {success && <Alert tone="success">{success}</Alert>}
            <Field label="كلمة المرور الحالية" error={errors.currentPassword} required>
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  type="password"
                  dir="ltr"
                  className="text-start"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  required
                />
              )}
            </Field>
            <NewPasswordFields
              label="كلمة المرور الجديدة"
              passwordField="newPassword"
              password={newPassword}
              confirm={confirm}
              errors={errors}
              onPassword={setNewPassword}
              onConfirm={setConfirm}
            />
            <div>
              <Button type="submit" loading={submitting}>
                حفظ كلمة المرور
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
