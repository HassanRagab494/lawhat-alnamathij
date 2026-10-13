'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { DeleteSupervisorDialog } from '@/components/delete-supervisor-dialog';
import { RequirePermission } from '@/components/guards';
import { NewPasswordFields, validateNewPassword } from '@/components/password-fields';
import { PermissionPicker } from '@/components/permission-picker';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  LinkButton,
  LoadingState,
  PageHeader,
  TextInput,
} from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { PERMISSION_LABELS, ROLE_LABELS } from '@/lib/permissions';
import type { Permission, UserItem } from '@/lib/types';
import { useApi } from '@/lib/use-api';

function sameSet(a: Permission[], b: Permission[]): boolean {
  return a.length === b.length && a.every((p) => b.includes(p));
}

function UserDetails() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const params = useSearchParams();
  const {
    data: user,
    error,
    errorText,
    loading,
    reload,
    setData,
  } = useApi<UserItem>(`/users/${id}`);

  const [displayName, setDisplayName] = useState('');
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(
    params.get('created') ? 'تم إنشاء المشرف بنجاح.' : null,
  );
  const [saving, setSaving] = useState(false);

  const [statusDialog, setStatusDialog] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [resetPassword, setResetPassword] = useState('');
  const [resetConfirm, setResetConfirm] = useState('');
  const [resetErrors, setResetErrors] = useState<Record<string, string>>({});
  const [resetDialog, setResetDialog] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setDisplayName(user.displayName);
      setPermissions(user.permissions);
    }
  }, [user]);

  if (loading && !user) return <LoadingState />;
  if (error?.status === 404) {
    return (
      <Card>
        <EmptyState
          title="المستخدم غير موجود"
          action={
            <LinkButton href="/users" variant="secondary">
              العودة إلى المستخدمين
            </LinkButton>
          }
        />
      </Card>
    );
  }
  if (errorText || !user)
    return <ErrorState message={errorText ?? 'تعذر تحميل المستخدم.'} onRetry={reload} />;

  const isSupervisor = user.role === 'SUPERVISOR';
  const dirty = displayName.trim() !== user.displayName || !sameSet(permissions, user.permissions);

  async function onSave(event: FormEvent) {
    event.preventDefault();
    if (!user) return;
    const local: Record<string, string> = {};
    if (displayName.trim().length < 2) local.displayName = 'الاسم يجب ألا يقل عن حرفين.';
    setErrors(local);
    setSaveError(null);
    setSuccess(null);
    if (Object.keys(local).length) return;
    setSaving(true);
    try {
      setData(
        await api<UserItem>(`/users/${user.id}`, {
          method: 'PATCH',
          body: { displayName, permissions },
        }),
      );
      setSuccess('تم حفظ التغييرات. تسري الصلاحيات الجديدة فورًا على جلسات المشرف الحالية.');
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldMap());
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function onToggleStatus() {
    if (!user) return;
    setStatusBusy(true);
    setStatusError(null);
    try {
      const action = user.isActive ? 'deactivate' : 'activate';
      setData(await api<UserItem>(`/users/${user.id}/${action}`, { method: 'POST' }));
      setSuccess(user.isActive ? 'تم تعطيل الحساب وإنهاء جميع جلساته.' : 'تم تفعيل الحساب.');
      setStatusDialog(false);
    } catch (e) {
      setStatusError(errorMessage(e));
      if (e instanceof ApiError && e.status === 409) reload();
    } finally {
      setStatusBusy(false);
    }
  }

  function onResetSubmit(event: FormEvent) {
    event.preventDefault();
    const local = validateNewPassword(resetPassword, resetConfirm, 'newPassword');
    setResetErrors(local);
    if (!Object.keys(local).length) setResetDialog(true);
  }

  async function onResetConfirm() {
    if (!user) return;
    setResetBusy(true);
    setResetError(null);
    try {
      await api(`/users/${user.id}/reset-password`, {
        method: 'POST',
        body: { newPassword: resetPassword },
      });
      setResetDialog(false);
      setResetPassword('');
      setResetConfirm('');
      setSuccess('تمت إعادة تعيين كلمة المرور وإنهاء جميع جلسات المشرف.');
    } catch (e) {
      if (e instanceof ApiError && e.fields.length) {
        setResetErrors(e.fieldMap());
        setResetDialog(false);
      } else {
        setResetError(errorMessage(e));
      }
    } finally {
      setResetBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={user.displayName}
        description={`${ROLE_LABELS[user.role]} · ${user.username}`}
        back={{ href: '/users', label: 'المستخدمون' }}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-6">
          {success && <Alert tone="success">{success}</Alert>}

          {!isSupervisor ? (
            <Card className="p-5 sm:p-6">
              <h2 className="mb-2 text-lg font-bold text-velvet-900">حساب مدير النظام</h2>
              <p className="text-sm text-muted">
                يملك مدير النظام جميع الصلاحيات، ولا تُعدَّل بياناته من هنا. يمكنه تغيير كلمة مروره
                من صفحة «حسابي».
              </p>
            </Card>
          ) : (
            <>
              <Card className="p-5 sm:p-6">
                <h2 className="mb-4 text-lg font-bold text-velvet-900">البيانات والصلاحيات</h2>
                <form onSubmit={onSave} noValidate className="flex flex-col gap-5">
                  {saveError && <Alert tone="error">{saveError}</Alert>}
                  <Field label="الاسم" error={errors.displayName} required>
                    {({ id: fieldId, describedBy, invalid }) => (
                      <TextInput
                        id={fieldId}
                        value={displayName}
                        maxLength={100}
                        onChange={(e) => setDisplayName(e.target.value)}
                        aria-describedby={describedBy}
                        aria-invalid={invalid}
                        required
                      />
                    )}
                  </Field>
                  <PermissionPicker
                    value={permissions}
                    onChange={setPermissions}
                    error={errors.permissions}
                  />
                  <div>
                    <Button type="submit" loading={saving} disabled={!dirty}>
                      حفظ التغييرات
                    </Button>
                  </div>
                </form>
              </Card>

              <Card className="p-5 sm:p-6">
                <h2 className="mb-1 text-lg font-bold text-velvet-900">إعادة تعيين كلمة المرور</h2>
                <p className="mb-4 text-sm text-muted">
                  ستُنهى جميع جلسات المشرف الحالية ويلزمه الدخول بكلمة المرور الجديدة.
                </p>
                <form onSubmit={onResetSubmit} noValidate className="flex flex-col gap-5">
                  <NewPasswordFields
                    label="كلمة المرور الجديدة"
                    passwordField="newPassword"
                    password={resetPassword}
                    confirm={resetConfirm}
                    errors={resetErrors}
                    onPassword={setResetPassword}
                    onConfirm={setResetConfirm}
                  />
                  <div>
                    <Button type="submit" variant="secondary">
                      إعادة تعيين كلمة المرور
                    </Button>
                  </div>
                </form>
              </Card>
            </>
          )}
        </div>

        <Card className="h-fit p-5">
          <h2 className="mb-4 text-base font-bold text-velvet-900">حالة الحساب</h2>
          <dl className="flex flex-col gap-4 text-sm">
            <div>
              <dt className="text-xs font-semibold text-muted">الحالة</dt>
              <dd className="mt-1">
                {user.isActive ? (
                  <Badge tone="success">مفعّل</Badge>
                ) : (
                  <Badge tone="warning">معطّل</Badge>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-muted">الصلاحيات الحالية</dt>
              <dd className="mt-1">
                {user.role === 'ADMIN'
                  ? 'جميع الصلاحيات'
                  : user.permissions.length
                    ? user.permissions.map((p) => PERMISSION_LABELS[p]).join('، ')
                    : 'بلا صلاحيات'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-muted">آخر دخول</dt>
              <dd className="mt-1">{formatDateTime(user.lastLoginAt)}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-muted">تاريخ الإنشاء</dt>
              <dd className="mt-1">{formatDateTime(user.createdAt)}</dd>
            </div>
          </dl>
          {isSupervisor && (
            <Button
              variant={user.isActive ? 'danger' : 'primary'}
              className="mt-5 w-full"
              onClick={() => setStatusDialog(true)}
            >
              {user.isActive ? 'تعطيل الحساب' : 'تفعيل الحساب'}
            </Button>
          )}
          {isSupervisor && (
            <Button variant="danger" className="mt-3 w-full" onClick={() => setDeleteOpen(true)}>
              حذف المشرف
            </Button>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={statusDialog}
        title={user.isActive ? 'تعطيل الحساب' : 'تفعيل الحساب'}
        description={
          user.isActive
            ? `لن يتمكن «${user.displayName}» من الدخول، وستُنهى جميع جلساته الحالية فورًا.`
            : `سيتمكن «${user.displayName}» من الدخول مجددًا بكلمة مروره الحالية.`
        }
        confirmLabel={user.isActive ? 'تعطيل' : 'تفعيل'}
        tone={user.isActive ? 'danger' : 'primary'}
        loading={statusBusy}
        error={statusError}
        onConfirm={onToggleStatus}
        onClose={() => {
          setStatusDialog(false);
          setStatusError(null);
        }}
      />
      <DeleteSupervisorDialog
        user={deleteOpen ? user : null}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => router.push('/users')}
      />
      <ConfirmDialog
        open={resetDialog}
        title="تأكيد إعادة تعيين كلمة المرور"
        description={`ستتغير كلمة مرور «${user.displayName}» وتُنهى جميع جلساته الحالية.`}
        confirmLabel="إعادة التعيين"
        tone="danger"
        loading={resetBusy}
        error={resetError}
        onConfirm={onResetConfirm}
        onClose={() => {
          setResetDialog(false);
          setResetError(null);
        }}
      />
    </>
  );
}

export default function UserDetailsPage() {
  return (
    <RequirePermission adminOnly>
      <Suspense fallback={<LoadingState />}>
        <UserDetails />
      </Suspense>
    </RequirePermission>
  );
}
