'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { FilePreview } from '@/components/file-preview';
import { FlowmaxPanel } from '@/components/flowmax-panel';
import { ResponseEditor } from '@/components/response-editor';
import { Forbidden, RequirePermission } from '@/components/guards';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LinkButton,
  LoadingState,
  PageHeader,
  SelectInput,
  TextArea,
} from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { formatBytes } from '@/lib/uploads';
import { can } from '@/lib/permissions';
import {
  REJECTION_REASON_MAX,
  REJECTION_REASON_MIN,
  RESPONSE_STATUSES,
  RESPONSE_STATUS_LABELS,
  RESPONSE_STATUS_TONES,
  editValueText,
  type AnswerView,
  type ResponseDetail,
  type ResponseStatus,
} from '@/lib/responses';
import { useApi } from '@/lib/use-api';

function StatusBadge({ status }: { status: ResponseStatus }) {
  return <Badge tone={RESPONSE_STATUS_TONES[status]}>{RESPONSE_STATUS_LABELS[status]}</Badge>;
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="text-sm text-ink">{value}</dd>
    </div>
  );
}

/** يعرض الإجابة حسب نوع السؤال كنص عادي (React يهرب أي HTML). */
function AnswerValue({
  answer,
  downloadBase,
}: {
  answer: AnswerView;
  /** مسار الملفات المحمي (للمعاينة والتنزيل) إن كان المستخدم يملك صلاحية ملفات الردود. */
  downloadBase: string | null;
}) {
  switch (answer.kind) {
    case 'empty':
      return (
        <p className="text-sm italic text-muted">
          {answer.hidden
            ? 'غير ظاهر حسب إجابات هذا الرد (سؤال شرطي)، فلا إجابة له.'
            : answer.required
              ? 'لا توجد إجابة.'
              : 'لم تُقدَّم إجابة (سؤال اختياري).'}
        </p>
      );
    case 'files':
      return (
        <ul className="flex flex-col gap-2">
          {(answer.files ?? []).map((f) => (
            <li
              key={f.id}
              className="flex flex-col gap-2 rounded-lg border border-smoke-200 bg-white/70 px-3 py-2 text-sm"
            >
              {downloadBase && (
                <FilePreview
                  file={f}
                  src={`${downloadBase}/${f.id}?disposition=inline`}
                  downloadHref={`${downloadBase}/${f.id}`}
                />
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  <span dir="auto" className="break-all font-semibold text-ink">
                    {f.name}
                  </span>
                  <span className="ms-2 text-xs text-muted">{formatBytes(f.size)}</span>
                  {f.malwareScanned === false && (
                    <span
                      className="ms-2 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900"
                      title="قُبل بعد التحقق من النوع والحجم فقط؛ افتحه بحذر."
                    >
                      غير مفحوص ضد البرمجيات الخبيثة
                    </span>
                  )}
                </span>
                {downloadBase && (
                  <a
                    href={`${downloadBase}/${f.id}`}
                    download
                    rel="noopener"
                    className="min-h-9 rounded-lg px-3 py-1.5 text-xs font-semibold text-velvet-700 underline hover:bg-velvet-50"
                    aria-label={`تنزيل ${f.name}`}
                  >
                    تنزيل
                  </a>
                )}
              </div>
            </li>
          ))}
          {!downloadBase && (
            <li className="text-xs text-muted">
              معاينة الملفات وتنزيلها يحتاجان صلاحية «تنزيل ملفات الردود».
            </li>
          )}
        </ul>
      );
    case 'number':
    case 'date':
      return (
        <p dir="ltr" className="text-start text-base font-semibold text-ink">
          {answer.value}
        </p>
      );
    case 'choice':
      return (
        <ul className="flex flex-col gap-1.5">
          {(answer.options ?? []).map((o, i) => (
            <li
              key={i}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                o.selected
                  ? 'border border-velvet-300 bg-velvet-50 font-semibold text-velvet-900'
                  : 'text-muted'
              }`}
            >
              <span aria-hidden="true">{o.selected ? '✓' : '○'}</span>
              {o.label}
              {o.selected && <span className="sr-only"> (مختار)</span>}
            </li>
          ))}
        </ul>
      );
    default:
      return (
        <p dir="auto" className="whitespace-pre-wrap break-words text-base text-ink">
          {answer.value}
        </p>
      );
  }
}

function ResponseDetailView() {
  const { id, responseId } = useParams<{ id: string; responseId: string }>();
  const params = useSearchParams();
  const { me, refresh } = useAuth();
  const { data, error, errorText, loading, reload, setData } = useApi<ResponseDetail>(
    `/forms/${id}/responses/${responseId}`,
  );
  // '' تعني «بلا تغيير»؛ القيمة المعروضة مشتقة من الحالة الحالية مباشرة دون effect.
  const [nextStatus, setNextStatus] = useState<ResponseStatus | ''>('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareMessage, setShareMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const canReview = can(me, 'RESPONSES_REVIEW');
  const canDownload = can(me, 'RESPONSES_FILES_DOWNLOAD');

  // يحافظ على فلاتر القائمة عند الرجوع إليها.
  const list = params.get('list') ?? '';
  const listHref = `/forms/${id}/responses${/^[\w=&%.\-+]*$/.test(list) && list ? `?${list}` : ''}`;

  async function saveStatus() {
    if (!data || !nextStatus || nextStatus === data.status) return;
    const rejecting = nextStatus === 'REJECTED';
    if (rejecting && reason.trim().length < REJECTION_REASON_MIN) {
      setReasonError(`سبب الرفض إجباري (${REJECTION_REASON_MIN} أحرف على الأقل).`);
      return;
    }
    setSaving(true);
    setMessage(null);
    setReasonError(null);
    try {
      const result = await api<{ changed: boolean; response: ResponseDetail }>(
        `/forms/${id}/responses/${responseId}/status`,
        {
          method: 'PATCH',
          body: rejecting ? { status: nextStatus, reason: reason.trim() } : { status: nextStatus },
        },
      );
      setData(result.response);
      setNextStatus('');
      setReason('');
      setShareMessage(null);
      setMessage({
        ok: true,
        text: result.changed
          ? `تم تغيير الحالة إلى «${RESPONSE_STATUS_LABELS[result.response.status]}».`
          : 'الحالة كما هي؛ لم يُسجَّل تغيير.',
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) void refresh();
      if (e instanceof ApiError && e.fieldMap().reason) setReasonError(e.fieldMap().reason!);
      setMessage({ ok: false, text: `لم تتغير الحالة. ${errorMessage(e)}` });
    } finally {
      setSaving(false);
    }
  }

  /**
   * يفتح واتساب برسالة سبب الرفض الجاهزة (لا يُرسل شيئًا تلقائيًا). النافذة تُفتح فورًا عند النقر
   * حتى لا يحجبها المتصفح، ثم يُوجَّه إليها الرابط بعد أن يجهزه الخادم ويسجّل فتح المشاركة.
   */
  async function shareRejection() {
    setShareMessage(null);
    setSharing(true);
    const win = window.open('about:blank', '_blank');
    try {
      const { url } = await api<{ url: string }>(
        `/forms/${id}/responses/${responseId}/rejection-share`,
        { method: 'POST' },
      );
      if (win) {
        win.opener = null;
        win.location.href = url;
      } else {
        window.location.assign(url);
      }
      setShareMessage({
        ok: true,
        text: 'فُتح واتساب برسالة جاهزة. راجعها ثم أرسلها بنفسك؛ لا يُرسل شيء تلقائيًا.',
      });
    } catch (e) {
      win?.close();
      setShareMessage({ ok: false, text: errorMessage(e) });
    } finally {
      setSharing(false);
    }
  }

  if (loading && !data) return <LoadingState label="جارٍ تحميل الرد…" />;
  if (error?.status === 403) return <Forbidden />;
  if (error?.status === 404) {
    return (
      <Card>
        <EmptyState
          title="الرد غير موجود"
          description="ربما يكون الرابط غير صحيح، أو أن الرد لا يخص هذا النموذج."
          action={
            <LinkButton href={listHref} variant="secondary">
              العودة إلى الردود
            </LinkButton>
          }
        />
      </Card>
    );
  }
  if (!data) return <ErrorState message={errorText ?? 'تعذر تحميل الرد.'} onRetry={reload} />;

  return (
    <>
      <PageHeader title={`الرد ${data.referenceCode}`} back={{ href: listHref, label: 'الردود' }} />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="flex min-w-0 flex-col gap-4 lg:order-1">
          <section className="glass rounded-2xl border-t-4 border-t-velvet-700 p-5 sm:p-6">
            <h2 className="text-lg font-bold text-velvet-900">{data.version.title}</h2>
            {data.version.description && (
              <p className="mt-2 whitespace-pre-line text-sm text-muted">
                {data.version.description}
              </p>
            )}
            <p className="mt-3 text-xs text-muted">
              الأسئلة كما نُشرت في الإصدار {data.version.versionNumber}، حتى لو عُدّلت المسودة بعده.
            </p>
          </section>

          {canReview && !editing && (
            <div className="flex flex-wrap items-center gap-3">
              {data.locked ? (
                <p className="text-sm text-muted">أُرسل هذا الرد إلى Flowmax، فلا يمكن تعديله.</p>
              ) : (
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  تعديل بيانات الرد
                </Button>
              )}
              {data.edits.length > 0 && (
                <Badge tone="warning">
                  عُدّل {data.edits.length === 1 ? 'حقل واحد' : `${data.edits.length} تعديلات`}
                </Badge>
              )}
            </div>
          )}

          {editing ? (
            <ResponseEditor
              formId={id}
              responseId={responseId}
              onSaved={(detail) => {
                setData(detail);
                setEditing(false);
                setMessage({
                  ok: true,
                  text: 'حُفظت التعديلات وسُجّلت باسمك. راجعها قبل الاعتماد.',
                });
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <ol className="flex flex-col gap-3" aria-label="الأسئلة والإجابات">
              {data.answers.map((a, i) => (
                <li key={a.questionId} className="glass rounded-2xl p-5">
                  <h3 className="text-base font-semibold text-ink">
                    {i + 1}. {a.title}
                    {a.required && (
                      <>
                        <span className="text-red-700" aria-hidden="true">
                          {' '}
                          *
                        </span>
                        <span className="sr-only"> (إجباري)</span>
                      </>
                    )}
                  </h3>
                  {a.description && (
                    <p className="mt-1 whitespace-pre-line text-xs text-muted">{a.description}</p>
                  )}
                  <div className="mt-3">
                    <AnswerValue
                      answer={a}
                      downloadBase={
                        canDownload ? `/api/forms/${id}/responses/${responseId}/files` : null
                      }
                    />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="flex flex-col gap-4 lg:order-2">
          <Card className="h-fit p-5">
            <h2 className="mb-4 text-base font-bold text-velvet-900">بيانات الرد</h2>
            <dl className="flex flex-col gap-4">
              <Meta
                label="الرقم المرجعي"
                value={
                  <span dir="ltr" className="font-mono font-semibold">
                    {data.referenceCode}
                  </span>
                }
              />
              <Meta label="النموذج" value={data.formTitle} />
              <Meta label="الإصدار" value={`الإصدار ${data.version.versionNumber}`} />
              <Meta label="وقت الإرسال" value={formatDateTime(data.submittedAt)} />
              <Meta label="الحالة الحالية" value={<StatusBadge status={data.status} />} />
            </dl>
            <p className="mt-4 text-xs text-muted">الأوقات بتوقيت الرياض.</p>
          </Card>

          {canReview && (
            <Card className="h-fit p-5">
              <h2 className="mb-3 text-base font-bold text-velvet-900">تغيير الحالة</h2>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold text-ink">الحالة الجديدة</span>
                <SelectInput
                  value={nextStatus || data.status}
                  onChange={(e) => setNextStatus(e.target.value as ResponseStatus)}
                  disabled={saving}
                >
                  {RESPONSE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {RESPONSE_STATUS_LABELS[s]}
                    </option>
                  ))}
                </SelectInput>
              </label>
              {nextStatus === 'REJECTED' && data.status !== 'REJECTED' && (
                <label className="mt-3 flex flex-col gap-1.5">
                  <span className="text-sm font-semibold text-ink">
                    سبب الرفض <span className="text-red-700">*</span>
                  </span>
                  <TextArea
                    className="min-h-24"
                    value={reason}
                    maxLength={REJECTION_REASON_MAX}
                    aria-invalid={Boolean(reasonError)}
                    aria-required
                    placeholder="مثال: الصور غير واضحة، يرجى إرسال صور أوضح."
                    onChange={(e) => {
                      setReason(e.target.value);
                      setReasonError(null);
                    }}
                  />
                  <span className="text-xs text-muted">
                    {reason.length}/{REJECTION_REASON_MAX} · يُحفظ في سجل الحالات ويمكن مشاركته مع
                    العميل.
                  </span>
                  {reasonError && (
                    <span role="alert" className="text-sm font-medium text-red-800">
                      {reasonError}
                    </span>
                  )}
                </label>
              )}
              <Button
                className="mt-3 w-full"
                onClick={() => void saveStatus()}
                loading={saving}
                disabled={!nextStatus || nextStatus === data.status}
              >
                حفظ الحالة
              </Button>
              <p className="mt-2 text-xs text-muted">
                لا يغيّر الإجابات. يُسجَّل كل تغيير باسمك ووقته.
              </p>
            </Card>
          )}
          {message && <Alert tone={message.ok ? 'success' : 'error'}>{message.text}</Alert>}

          {data.rejection && (
            <Card className="h-fit border border-red-200 p-5">
              <h2 className="mb-2 text-base font-bold text-red-900">سبب الرفض</h2>
              <p dir="auto" className="whitespace-pre-wrap break-words text-sm text-ink">
                {data.rejection.reason}
              </p>
              <p className="mt-2 text-xs text-muted">
                {data.rejection.rejectedBy ?? 'مستخدم محذوف'} ·{' '}
                {formatDateTime(data.rejection.rejectedAt)}
              </p>
              {canReview && (
                <>
                  <Button
                    className="mt-3 w-full"
                    variant="secondary"
                    loading={sharing}
                    onClick={() => void shareRejection()}
                  >
                    مشاركة سبب الرفض مع العميل
                  </Button>
                  <p className="mt-1 text-xs text-muted">
                    يفتح واتساب برسالة جاهزة لرقم الجوال في الرد، ولا يُرسل شيء تلقائيًا.
                  </p>
                </>
              )}
              {shareMessage && (
                <div className="mt-2">
                  <Alert tone={shareMessage.ok ? 'success' : 'error'}>{shareMessage.text}</Alert>
                </div>
              )}
            </Card>
          )}

          {data.edits.length > 0 && (
            <Card className="h-fit p-5">
              <h2 className="mb-3 text-base font-bold text-velvet-900">سجل التعديلات</h2>
              <ol className="flex flex-col gap-3">
                {[...data.edits].reverse().map((e, i) => (
                  <li key={i} className="border-s-2 border-amber-300 ps-3 text-sm">
                    <p className="font-semibold text-ink">{e.questionTitle}</p>
                    <p className="mt-1 text-xs">
                      <span className="text-muted">الأصلية: </span>
                      <span dir="auto" className="break-words line-through decoration-red-400">
                        {editValueText(e.oldValue)}
                      </span>
                    </p>
                    <p className="text-xs">
                      <span className="text-muted">المعدلة: </span>
                      <span dir="auto" className="break-words font-semibold text-velvet-900">
                        {editValueText(e.newValue)}
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {e.editedBy ?? 'مستخدم محذوف'} · {formatDateTime(e.editedAt)}
                    </p>
                  </li>
                ))}
              </ol>
            </Card>
          )}

          <FlowmaxPanel
            key={`${data.editRevision}-${data.status}`}
            formId={id}
            responseId={responseId}
            canReview={canReview}
            fileNames={Object.fromEntries(
              data.answers.flatMap((a) => (a.files ?? []).map((f) => [f.id, f.name])),
            )}
            onApproved={reload}
          />

          <Card className="h-fit p-5">
            <h2 className="mb-3 text-base font-bold text-velvet-900">سجل الحالات</h2>
            {data.statusHistory.length === 0 ? (
              <p className="text-sm text-muted">لم تتغير الحالة منذ الإرسال.</p>
            ) : (
              <ol className="flex flex-col gap-3">
                {[...data.statusHistory].reverse().map((c, i) => (
                  <li key={i} className="border-s-2 border-velvet-200 ps-3 text-sm">
                    <p className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={c.fromStatus} />
                      <span aria-hidden="true">←</span>
                      <span className="sr-only">إلى</span>
                      <StatusBadge status={c.toStatus} />
                    </p>
                    {c.reason && (
                      <p
                        dir="auto"
                        className="mt-1 whitespace-pre-wrap break-words text-xs text-ink"
                      >
                        السبب: {c.reason}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-muted">
                      {c.changedBy ?? 'مستخدم محذوف'} · {formatDateTime(c.changedAt)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

export default function ResponseDetailPage() {
  return (
    <RequirePermission permission="RESPONSES_VIEW">
      <Suspense fallback={<LoadingState />}>
        <ResponseDetailView />
      </Suspense>
    </RequirePermission>
  );
}
