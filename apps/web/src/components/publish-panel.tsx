'use client';

import { useState } from 'react';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { FormDraft } from '@/lib/draft';
import { formatDateTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import type { FormItem, Me } from '@/lib/types';
import { Alert, Badge, Button, Card, ConfirmDialog, LinkButton } from './ui';

interface PublishResult {
  form: FormItem;
  version: { id: string; versionNumber: number };
  replayed: boolean;
}

/** أسباب منع النشر المعروفة محليًا من المسودة المحفوظة (الخادم يعيد التحقق دائمًا). */
export function localPublishBlockers(form: FormDraft): string[] {
  const reasons: string[] = [];
  if (form.isArchived) reasons.push('النموذج مؤرشف؛ استعده أولًا.');
  if (form.questions.length === 0) reasons.push('أضف سؤالًا واحدًا على الأقل واحفظ المسودة.');
  form.questions.forEach((q, i) => {
    if (q.type === 'FILE_UPLOAD') {
      reasons.push(
        `السؤال ${i + 1} «${q.title}» من نوع رفع ملفات، والرفع الفعلي غير متاح بعد؛ احذفه أو غيّر نوعه ثم احفظ.`,
      );
    }
  });
  return reasons;
}

export function publicFormUrl(publicId: string): string {
  return `${window.location.origin}/f/${publicId}`;
}

/**
 * حالة النشر والاستقبال للنموذج: النشر يأخذ المسودة المحفوظة فقط، والاستقبال منفصل عنه.
 * رابط الردود يظهر لمن يملك عرض الردود بعد أول نشر.
 */
export function PublishPanel({
  form,
  me,
  dirty,
  onUpdated,
  onConflict,
}: {
  form: FormDraft;
  me: Me | null;
  dirty: boolean;
  onUpdated: (form: FormItem, message: string) => void;
  onConflict: (current: FormDraft) => void;
}) {
  const pub = form.publication;
  const latest = pub.latestVersion;
  const canPublish = can(me, 'FORMS_PUBLISH');
  const canIntake = can(me, 'FORMS_INTAKE');
  const blockers = localPublishBlockers(form);

  const [publishOpen, setPublishOpen] = useState(false);
  const [publishKey, setPublishKey] = useState('');
  const [openNow, setOpenNow] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [intakeDialog, setIntakeDialog] = useState<'open' | 'close' | null>(null);
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function startPublish() {
    // مفتاح جديد لكل فتح للنافذة؛ تكرار النقر أو إعادة المحاولة داخلها يعيد الإصدار نفسه.
    setPublishKey(crypto.randomUUID());
    setOpenNow(false);
    setPublishError(null);
    setPublishOpen(true);
  }

  async function confirmPublish() {
    setPublishing(true);
    setPublishError(null);
    try {
      const result = await api<PublishResult>(`/forms/${form.id}/publish`, {
        method: 'POST',
        body: {
          revision: form.revision,
          publishKey,
          ...(latest ? {} : { openResponses: openNow && canIntake }),
        },
      });
      setPublishOpen(false);
      onUpdated(
        result.form,
        `تم نشر الإصدار ${result.version.versionNumber}.${
          result.form.publication.acceptingResponses
            ? ' الاستقبال مفتوح على الرابط العام.'
            : ' الاستقبال مغلق؛ افتحه عندما تكون جاهزًا.'
        }`,
      );
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REVISION_CONFLICT') {
        setPublishOpen(false);
        onConflict(e.details.current as FormDraft);
        return;
      }
      if (e instanceof ApiError && e.code === 'PUBLISH_BLOCKED') {
        const reasons = (e.details.reasons as string[] | undefined) ?? [];
        setPublishError([e.message, ...reasons].join(' '));
        return;
      }
      setPublishError(errorMessage(e));
    } finally {
      setPublishing(false);
    }
  }

  async function confirmIntake() {
    if (!intakeDialog) return;
    setIntakeBusy(true);
    setIntakeError(null);
    try {
      const updated = await api<FormItem>(`/forms/${form.id}/responses/${intakeDialog}`, {
        method: 'POST',
      });
      setIntakeDialog(null);
      onUpdated(
        updated,
        intakeDialog === 'open' ? 'تم فتح استقبال الردود.' : 'تم إغلاق استقبال الردود.',
      );
    } catch (e) {
      setIntakeError(errorMessage(e));
    } finally {
      setIntakeBusy(false);
    }
  }

  async function copyLink() {
    if (!pub.publicId) return;
    try {
      await navigator.clipboard.writeText(publicFormUrl(pub.publicId));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  const publishDisabledReason = dirty
    ? 'احفظ التغييرات أولًا؛ النشر يستخدم المسودة المحفوظة فقط.'
    : blockers[0];

  return (
    <Card className="h-fit p-5">
      <h2 className="mb-4 text-base font-bold text-velvet-900">النشر والاستقبال</h2>
      <dl className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-semibold text-muted">حالة النشر</dt>
          <dd className="flex flex-wrap gap-1.5 text-sm">
            {latest ? (
              <Badge tone="success">منشور — الإصدار {latest.versionNumber}</Badge>
            ) : (
              <Badge tone="velvet">مسودة غير منشورة</Badge>
            )}
            {latest && pub.hasUnpublishedChanges && (
              <Badge tone="warning">تغييرات محفوظة غير منشورة</Badge>
            )}
          </dd>
        </div>
        {latest && (
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-semibold text-muted">آخر نشر</dt>
            <dd className="text-sm text-ink">
              {formatDateTime(latest.publishedAt)}
              {latest.publishedBy && ` — ${latest.publishedBy.displayName}`}
            </dd>
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-semibold text-muted">استقبال الردود</dt>
          <dd className="text-sm">
            {pub.acceptingResponses ? (
              <Badge tone="success">مفتوح</Badge>
            ) : (
              <Badge tone="muted">مغلق</Badge>
            )}
          </dd>
        </div>
        {pub.publicId && (
          <div className="flex flex-col gap-1.5">
            <dt className="text-xs font-semibold text-muted">الرابط العام</dt>
            <dd className="flex flex-col gap-2">
              <a
                href={`/f/${pub.publicId}`}
                target="_blank"
                rel="noopener noreferrer"
                dir="ltr"
                className="break-all text-start text-sm text-velvet-700 underline"
              >
                {publicFormUrl(pub.publicId)}
              </a>
              <Button variant="secondary" onClick={() => void copyLink()} className="min-h-9 py-1">
                {copied ? 'تم نسخ الرابط' : 'نسخ الرابط'}
              </Button>
              <span role="status" className="sr-only">
                {copied ? 'تم نسخ الرابط' : ''}
              </span>
            </dd>
          </div>
        )}
      </dl>

      {canPublish && !form.isArchived && (
        <div className="mt-5 flex flex-col gap-2">
          <Button onClick={startPublish} disabled={Boolean(publishDisabledReason)}>
            {latest ? 'نشر التحديث' : 'نشر النموذج'}
          </Button>
          {publishDisabledReason && (
            <ul className="flex flex-col gap-1 text-xs text-amber-900">
              {(dirty ? [publishDisabledReason] : blockers).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {latest && can(me, 'RESPONSES_VIEW') && (
        <LinkButton
          href={`/forms/${form.id}/responses`}
          variant="secondary"
          className="mt-3 w-full"
        >
          عرض الردود
        </LinkButton>
      )}

      {canIntake && latest && (
        <div className="mt-3">
          {pub.acceptingResponses ? (
            <Button variant="secondary" className="w-full" onClick={() => setIntakeDialog('close')}>
              إغلاق استقبال الردود
            </Button>
          ) : (
            !form.isArchived && (
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => setIntakeDialog('open')}
              >
                فتح استقبال الردود
              </Button>
            )
          )}
        </div>
      )}
      {form.isArchived && latest && (
        <p className="mt-3 text-xs text-muted">
          الأرشفة أغلقت الاستقبال. الاستعادة لا تعيد فتحه تلقائيًا.
        </p>
      )}

      <ConfirmDialog
        open={publishOpen}
        title={latest ? `نشر الإصدار ${latest.versionNumber + 1}` : 'نشر النموذج'}
        description={
          <span className="flex flex-col gap-2">
            <span>
              سيُنشر «{form.title}» بـ {form.questions.length}{' '}
              {form.questions.length === 1 ? 'سؤال' : 'أسئلة'} من المسودة المحفوظة (المراجعة{' '}
              {form.revision}). الإصدار المنشور ثابت لا يتغير بتعديل المسودة لاحقًا، ولا يمكن إلغاء
              النشر.
            </span>
            {latest ? (
              <span>
                يبقى الاستقبال {pub.acceptingResponses ? 'مفتوحًا' : 'مغلقًا'} كما هو. من فتح
                النموذج قبل التحديث سيُطلب منه تحديث الصفحة قبل الإرسال، وتبقى إجاباته.
              </span>
            ) : (
              <span>سيُنشأ رابط عام يمكن مشاركته.</span>
            )}
          </span>
        }
        confirmLabel="نشر"
        loading={publishing}
        error={publishError}
        onConfirm={() => void confirmPublish()}
        onClose={() => setPublishOpen(false)}
      >
        {!latest &&
          (canIntake ? (
            <label className="mt-3 flex items-start gap-3 rounded-xl border border-smoke-300 bg-white/70 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-5 accent-velvet-700"
                checked={openNow}
                onChange={(e) => setOpenNow(e.target.checked)}
              />
              <span>
                <span className="font-semibold text-ink">فتح استقبال الردود فور النشر</span>
                <span className="block text-xs text-muted">
                  إن لم تحدده يبقى الاستقبال مغلقًا حتى تفتحه لاحقًا.
                </span>
              </span>
            </label>
          ) : (
            <p className="mt-3 text-xs text-muted">
              سيبقى الاستقبال مغلقًا؛ فتحه يحتاج صلاحية «فتح وإغلاق استقبال الردود».
            </p>
          ))}
      </ConfirmDialog>

      <ConfirmDialog
        open={intakeDialog !== null}
        title={intakeDialog === 'open' ? 'فتح استقبال الردود' : 'إغلاق استقبال الردود'}
        description={
          intakeDialog === 'open'
            ? `سيتمكن أي شخص لديه الرابط من إرسال رد على الإصدار ${latest?.versionNumber ?? ''}.`
            : 'لن يُقبل أي رد جديد، بما فيه من يعبّئ النموذج الآن. الردود المحفوظة تبقى كما هي.'
        }
        confirmLabel={intakeDialog === 'open' ? 'فتح الاستقبال' : 'إغلاق الاستقبال'}
        tone={intakeDialog === 'close' ? 'danger' : 'primary'}
        loading={intakeBusy}
        error={intakeError}
        onConfirm={() => void confirmIntake()}
        onClose={() => {
          setIntakeDialog(null);
          setIntakeError(null);
        }}
      />
    </Card>
  );
}
