'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { FormBasicsFields, validateFormBasics } from '@/components/form-fields';
import { RequirePermission } from '@/components/guards';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LinkButton,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import type { FormItem } from '@/lib/types';
import { useApi } from '@/lib/use-api';

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="text-sm text-ink">{value}</dd>
    </div>
  );
}

function FormDetails() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const { me, refresh } = useAuth();
  const {
    data: form,
    error,
    errorText,
    loading,
    reload,
    setData,
  } = useApi<FormItem>(`/forms/${id}`);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<FormItem | null>(null);
  const [success, setSuccess] = useState<string | null>(
    params.get('created') ? 'تم إنشاء النموذج بنجاح.' : null,
  );
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<'archive' | 'restore' | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);

  // تعبئة الحقول من النسخة المحمّلة (وليس عند كل تحديث حتى لا تُمسح تعديلات المستخدم).
  const [loadedRevision, setLoadedRevision] = useState<number | null>(null);
  useEffect(() => {
    if (form && form.revision !== loadedRevision) {
      setTitle(form.title);
      setDescription(form.description ?? '');
      setLoadedRevision(form.revision);
    }
  }, [form, loadedRevision]);

  if (loading && !form) return <LoadingState />;
  if (error?.status === 404) {
    return (
      <Card>
        <EmptyState
          title="النموذج غير موجود"
          description="ربما يكون الرابط غير صحيح."
          action={
            <LinkButton href="/forms" variant="secondary">
              العودة إلى النماذج
            </LinkButton>
          }
        />
      </Card>
    );
  }
  if (errorText || !form)
    return <ErrorState message={errorText ?? 'تعذر تحميل النموذج.'} onRetry={reload} />;

  const canEdit = can(me, 'FORMS_EDIT') && !form.isArchived;
  const canArchive = can(me, 'FORMS_ARCHIVE');
  const dirty = title !== form.title || description !== (form.description ?? '');

  async function onSave(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    const local = validateFormBasics(title);
    setErrors(local);
    setSaveError(null);
    setSuccess(null);
    if (Object.keys(local).length) return;
    setSaving(true);
    try {
      const updated = await api<FormItem>(`/forms/${form.id}`, {
        method: 'PATCH',
        body: {
          title,
          description: description.trim() ? description : null,
          revision: form.revision,
        },
      });
      setConflict(null);
      setData(updated);
      setSuccess('تم حفظ التغييرات.');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REVISION_CONFLICT') {
        setConflict(e.details.current as FormItem);
      } else {
        if (e instanceof ApiError) {
          setErrors(e.fieldMap());
          if (e.status === 403) void refresh();
        }
        setSaveError(errorMessage(e));
      }
    } finally {
      setSaving(false);
    }
  }

  /** يعتمد النسخة الأحدث من الخادم مع الإبقاء على ما كتبه المستخدم في الحقول ليعيد تطبيقه. */
  function adoptLatest(keepMine: boolean) {
    if (!conflict) return;
    const mine = { title, description };
    setData(conflict);
    setLoadedRevision(conflict.revision);
    if (keepMine) {
      setTitle(mine.title);
      setDescription(mine.description);
    } else {
      setTitle(conflict.title);
      setDescription(conflict.description ?? '');
    }
    setConflict(null);
  }

  async function onArchiveToggle() {
    if (!form || !dialog) return;
    setArchiving(true);
    setDialogError(null);
    try {
      const updated = await api<FormItem>(`/forms/${form.id}/${dialog}`, { method: 'POST' });
      setData(updated);
      setLoadedRevision(null);
      setSuccess(dialog === 'archive' ? 'تمت أرشفة النموذج.' : 'تمت استعادة النموذج.');
      setDialog(null);
    } catch (e) {
      setDialogError(errorMessage(e));
      if (e instanceof ApiError && e.status === 409) reload();
    } finally {
      setArchiving(false);
    }
  }

  return (
    <>
      <PageHeader
        title={form.title}
        back={{ href: form.isArchived ? '/forms?status=archived' : '/forms', label: 'النماذج' }}
        actions={
          canArchive &&
          (form.isArchived ? (
            <Button variant="secondary" onClick={() => setDialog('restore')}>
              استعادة النموذج
            </Button>
          ) : (
            <Button variant="danger" onClick={() => setDialog('archive')}>
              أرشفة النموذج
            </Button>
          ))
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-4">
          {success && <Alert tone="success">{success}</Alert>}
          {form.isArchived && (
            <Alert tone="warning" title="هذا النموذج مؤرشف">
              لا يمكن تعديل بياناته حتى تتم استعادته.
            </Alert>
          )}

          <Card className="p-5 sm:p-6">
            <h2 className="mb-4 text-lg font-bold text-velvet-900">البيانات الأساسية</h2>
            {canEdit ? (
              <form onSubmit={onSave} noValidate className="flex flex-col gap-5">
                {saveError && <Alert tone="error">{saveError}</Alert>}
                {conflict && (
                  <Alert tone="warning" title="عدّل شخص آخر هذا النموذج بعد أن فتحته">
                    <p className="mb-2">
                      لم تُحفظ تغييراتك حتى لا تُكتب فوق النسخة الأحدث. العنوان الحالي في النظام: «
                      {conflict.title}» (آخر تعديل {formatDateTime(conflict.updatedAt)}).
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => adoptLatest(true)}
                        className="min-h-9 py-1"
                      >
                        الإبقاء على تعديلاتي ومراجعتها
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => adoptLatest(false)}
                        className="min-h-9 py-1"
                      >
                        تحميل النسخة الحالية
                      </Button>
                    </div>
                  </Alert>
                )}
                <FormBasicsFields
                  title={title}
                  description={description}
                  errors={errors}
                  onTitle={(v) => {
                    setTitle(v);
                    setSuccess(null);
                  }}
                  onDescription={(v) => {
                    setDescription(v);
                    setSuccess(null);
                  }}
                />
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" loading={saving} disabled={!dirty || Boolean(conflict)}>
                    حفظ التغييرات
                  </Button>
                  {dirty && !conflict && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setTitle(form.title);
                        setDescription(form.description ?? '');
                        setErrors({});
                      }}
                    >
                      تراجع
                    </Button>
                  )}
                </div>
              </form>
            ) : (
              <dl className="flex flex-col gap-4">
                <Meta label="العنوان" value={form.title} />
                <Meta
                  label="الوصف"
                  value={
                    form.description ? (
                      <span className="whitespace-pre-line">{form.description}</span>
                    ) : (
                      '—'
                    )
                  }
                />
              </dl>
            )}
          </Card>
        </div>

        <Card className="h-fit p-5">
          <h2 className="mb-4 text-base font-bold text-velvet-900">معلومات النموذج</h2>
          <dl className="flex flex-col gap-4">
            <Meta
              label="الحالة"
              value={
                <span className="flex flex-wrap gap-1.5">
                  <Badge tone="velvet">مسودة غير منشورة</Badge>
                  {form.isArchived && <Badge tone="muted">مؤرشف</Badge>}
                </span>
              }
            />
            <Meta label="رقم مراجعة المسودة" value={form.revision} />
            <Meta label="أنشأه" value={form.createdBy.displayName} />
            <Meta label="تاريخ الإنشاء" value={formatDateTime(form.createdAt)} />
            <Meta label="آخر تعديل" value={formatDateTime(form.updatedAt)} />
            {form.archivedAt && (
              <Meta label="تاريخ الأرشفة" value={formatDateTime(form.archivedAt)} />
            )}
          </dl>
          <p className="mt-4 text-xs text-muted">الأوقات بتوقيت الرياض.</p>
        </Card>
      </div>

      <ConfirmDialog
        open={dialog !== null}
        title={dialog === 'archive' ? 'أرشفة النموذج' : 'استعادة النموذج'}
        description={
          dialog === 'archive'
            ? `سيُنقل «${form.title}» إلى الأرشيف ولن يمكن تعديله حتى تستعيده. لا يُحذف أي شيء.`
            : `سيعود «${form.title}» إلى قائمة النماذج النشطة.`
        }
        confirmLabel={dialog === 'archive' ? 'أرشفة' : 'استعادة'}
        tone={dialog === 'archive' ? 'danger' : 'primary'}
        loading={archiving}
        error={dialogError}
        onConfirm={onArchiveToggle}
        onClose={() => {
          setDialog(null);
          setDialogError(null);
        }}
      />
    </>
  );
}

export default function FormDetailsPage() {
  return (
    <RequirePermission permission="FORMS_VIEW">
      <Suspense fallback={<LoadingState />}>
        <FormDetails />
      </Suspense>
    </RequirePermission>
  );
}
