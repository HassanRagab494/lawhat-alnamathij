'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { FilePreview } from '@/components/file-preview';
import { FlowmaxPanel } from '@/components/flowmax-panel';
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
} from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { formatBytes } from '@/lib/uploads';
import { can } from '@/lib/permissions';
import {
  RESPONSE_STATUSES,
  RESPONSE_STATUS_LABELS,
  RESPONSE_STATUS_TONES,
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
          {answer.required ? 'لا توجد إجابة.' : 'لم تُقدَّم إجابة (سؤال اختياري).'}
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
  const canReview = can(me, 'RESPONSES_REVIEW');
  const canDownload = can(me, 'RESPONSES_FILES_DOWNLOAD');

  // يحافظ على فلاتر القائمة عند الرجوع إليها.
  const list = params.get('list') ?? '';
  const listHref = `/forms/${id}/responses${/^[\w=&%.\-+]*$/.test(list) && list ? `?${list}` : ''}`;

  async function saveStatus() {
    if (!data || !nextStatus || nextStatus === data.status) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await api<{ changed: boolean; response: ResponseDetail }>(
        `/forms/${id}/responses/${responseId}/status`,
        { method: 'PATCH', body: { status: nextStatus } },
      );
      setData(result.response);
      setNextStatus('');
      setMessage({
        ok: true,
        text: result.changed
          ? `تم تغيير الحالة إلى «${RESPONSE_STATUS_LABELS[result.response.status]}».`
          : 'الحالة كما هي؛ لم يُسجَّل تغيير.',
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) void refresh();
      setMessage({ ok: false, text: `لم تتغير الحالة. ${errorMessage(e)}` });
    } finally {
      setSaving(false);
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

          <FlowmaxPanel
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
