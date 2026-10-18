'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import {
  MEDIA_STATUS_LABELS,
  OPERATION_LABELS,
  SYNC_STATUS_LABELS,
  SYNC_STATUS_TONES,
  formatPriceSar,
  shareText,
  whatsappShareUrl,
  type FlowmaxShare,
  type FlowmaxState,
  type FlowmaxSync,
} from '@/lib/flowmax';
import { Alert, Badge, Button, Card } from './ui';

const POLL_MS = 2000;

/** أزرار المشاركة: تظهر فقط بعد تأكيد النشر. النص من حقول عامة مسموحة دون بيانات المالك. */
export function ShareActions({ share, url }: { share: FlowmaxShare; url: string }) {
  const [note, setNote] = useState<string | null>(null);
  const text = shareText(share, url);

  async function copy(value: string, done: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNote(done);
    } catch {
      setNote('تعذر النسخ تلقائيًا؛ انسخ الرابط يدويًا.');
    }
  }

  async function nativeShare() {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: share.title, text, url });
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    await copy(text, 'نُسخ نص المشاركة؛ الصقه حيث تريد.');
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1">
        <Button onClick={() => void nativeShare()}>مشاركة العقار</Button>
        <Button variant="secondary" onClick={() => void copy(url, 'نُسخ الرابط.')}>
          نسخ الرابط
        </Button>
        <a
          href={whatsappShareUrl(text)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-emerald-700 bg-white/60 px-4 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50"
        >
          مشاركة واتساب
        </a>
      </div>
      <p role="status" aria-live="polite" className="min-h-5 text-xs text-muted">
        {note}
      </p>
    </div>
  );
}

/** ملخص السجل المنشور للإدارة: من الحقول العامة نفسها التي تُشارك (لا بيانات المالك). */
function PublishedSummary({ share, reference }: { share: FlowmaxShare; reference: string | null }) {
  const rows: [string, string | null][] = [
    [
      'النوع',
      [OPERATION_LABELS[share.operation], share.purpose, share.category]
        .filter(Boolean)
        .join(' — '),
    ],
    ['المدينة والحي', [share.city, share.district].filter(Boolean).join(' — ') || null],
    ['المساحة', share.areaSqm != null ? `${share.areaSqm} م²` : null],
    [
      share.operation === 'REQUEST' ? 'الميزانية' : 'السعر',
      share.priceSar ? formatPriceSar(share.priceSar) : null,
    ],
    ['الغرف', share.bedrooms != null ? String(share.bedrooms) : null],
    ['دورات المياه', share.bathrooms != null ? String(share.bathrooms) : null],
    ['الرقم في Flowmax', reference],
  ];
  return (
    <section aria-label="ملخص السجل المنشور" className="rounded-xl bg-white/70 p-3 text-sm">
      <p dir="auto" className="mb-2 font-bold text-ink">
        {share.title}
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
        {rows
          .filter(([, v]) => v)
          .map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-xs text-muted">{label}</dt>
              <dd dir="auto" className="font-semibold text-ink">
                {value}
              </dd>
            </div>
          ))}
      </dl>
    </section>
  );
}

function MediaResults({ sync, names }: { sync: FlowmaxSync; names: Record<string, string> }) {
  if (!sync.media.length) return null;
  return (
    <ul className="flex flex-col gap-1 text-xs" aria-label="نتيجة نقل المرفقات">
      {sync.media.map((m) => (
        <li key={m.fileId} className="flex flex-wrap justify-between gap-1">
          <span dir="auto" className="break-all text-ink">
            {names[m.fileId] ?? m.fileId}
          </span>
          <span
            className={
              m.status === 'FAILED'
                ? 'font-semibold text-red-800'
                : m.status === 'SENT'
                  ? 'text-emerald-800'
                  : 'text-muted'
            }
          >
            {MEDIA_STATUS_LABELS[m.status]}
            {m.error && ` — ${m.error}`}
            {m.excludedReason && ` — ${m.excludedReason}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * لوحة Flowmax في تفاصيل الرد. ثلاث مراحل منفصلة: الاعتماد، ثم إرسال البيانات والمرفقات، ثم النشر.
 * الحالة والرابط لمن يعرض الردود؛ الاعتماد والنشر وإعادة المحاولة لمن يملك مراجعة الردود (والخادم يفرضها).
 */
export function FlowmaxPanel({
  formId,
  responseId,
  canReview,
  fileNames = {},
  onApproved,
}: {
  formId: string;
  responseId: string;
  canReview: boolean;
  fileNames?: Record<string, string>;
  onApproved?: () => void;
}) {
  const base = `/forms/${formId}/responses/${responseId}/flowmax`;
  const [state, setState] = useState<FlowmaxState | null>(null);
  const [busy, setBusy] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [error, setError] = useState<{ text: string; items: string[] } | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api<FlowmaxState>(base));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 403)) {
        setError({ text: errorMessage(e), items: [] });
      }
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const status = state?.sync?.status;
  const publishing = state?.sync?.publishState === 'REQUESTED';
  useEffect(() => {
    // الإرسال ثم النشر يتمان في الخلفية: تتحدث الحالة حتى يكتملا
    if (status !== 'PENDING' && status !== 'SENDING' && !publishing) return;
    const t = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(t);
  }, [status, publishing, state, load]);

  async function act(action: 'approve' | 'retry' | 'publish' | 'refresh') {
    setBusy(true);
    setError(null);
    try {
      const body = action === 'approve' ? { excludeFileIds: excluded } : {};
      setState(await api<FlowmaxState>(`${base}/${action}`, { method: 'POST', body }));
      if (action === 'approve') onApproved?.();
    } catch (e) {
      setError({
        text: errorMessage(e),
        items: e instanceof ApiError ? e.fields.map((f) => f.message) : [],
      });
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  const { sync, precheck } = state;
  if (!sync && (!state.integrationEnabled || !state.mappingEnabled)) return null;

  const incompatible = precheck?.incompatibleMedia ?? [];
  const unresolved = incompatible.filter((m) => !excluded.includes(m.fileId));
  const problems = precheck?.problems ?? [];

  return (
    <Card className="h-fit p-5">
      <h2 className="mb-3 text-base font-bold text-velvet-900">Flowmax</h2>
      {!sync ? (
        canReview ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">
              الاعتماد يغيّر حالة الرد إلى «مقبول» ويرسل بياناته ومرفقاته إلى Flowmax، ثم ينشر العرض
              تلقائيًا بعد نجاح الإرسال. الطلب يبقى بانتظار مراجعة Flowmax قبل نشره.
            </p>
            {problems.length > 0 && (
              <Alert tone="warning" title="بيانات ناقصة تمنع الاعتماد">
                <ul className="list-disc ps-5">
                  {problems.map((p) => (
                    <li key={p.field}>{p.message}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {incompatible.length > 0 && (
              <fieldset className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
                <legend className="px-1 font-semibold text-amber-900">
                  مرفقات لا يقبلها Flowmax
                </legend>
                <p className="mb-2 text-xs text-amber-900">
                  عالجها، أو استبعدها صراحة من الإرسال (يُسجَّل الاستبعاد باسمك).
                </p>
                <ul className="flex flex-col gap-2">
                  {incompatible.map((m) => (
                    <li key={m.fileId}>
                      <label className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4 accent-velvet-700"
                          checked={excluded.includes(m.fileId)}
                          onChange={(e) =>
                            setExcluded((list) =>
                              e.target.checked
                                ? [...list, m.fileId]
                                : list.filter((id) => id !== m.fileId),
                            )
                          }
                        />
                        <span>
                          استبعاد <span dir="auto">«{m.name}»</span>: {m.reason}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            )}
            <Button
              className="w-full"
              onClick={() => void act('approve')}
              loading={busy}
              disabled={problems.length > 0 || unresolved.length > 0}
            >
              اعتماد وإرسال إلى Flowmax
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted">لم يُعتمد هذا الرد للإرسال إلى Flowmax.</p>
        )
      ) : (
        <div className="flex flex-col gap-3">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={SYNC_STATUS_TONES[sync.status]}>{SYNC_STATUS_LABELS[sync.status]}</Badge>
            <span className="text-muted">{OPERATION_LABELS[sync.operation]}</span>
            {sync.attempts > 1 && (
              <span className="text-xs text-muted">المحاولات: {sync.attempts}</span>
            )}
          </p>
          {(sync.status === 'PENDING' || sync.status === 'SENDING') && (
            <p role="status" className="text-sm text-muted">
              يُرسل الآن؛ تتحدث الحالة تلقائيًا.
            </p>
          )}
          {sync.status === 'FAILED' && (
            <>
              <Alert tone="error">{sync.lastError ?? 'فشل الإرسال.'}</Alert>
              {canReview && (
                <Button variant="secondary" onClick={() => void act('retry')} loading={busy}>
                  إعادة المحاولة
                </Button>
              )}
            </>
          )}
          <MediaResults sync={sync} names={fileNames} />
          {sync.detailUrl && (
            <p className="text-sm">
              <span className="block text-xs text-muted">
                {sync.isPublic ? 'رابط التفاصيل (منشور):' : 'رابط التفاصيل (غير منشور بعد):'}
              </span>
              <a
                href={sync.detailUrl}
                target="_blank"
                rel="noopener noreferrer"
                dir="ltr"
                className="break-all font-semibold text-velvet-700 underline"
              >
                {sync.detailUrl}
              </a>
            </p>
          )}
          {sync.status === 'SENT' && !sync.isPublic && (
            <>
              {sync.publishError && <Alert tone="error">{sync.publishError}</Alert>}
              {sync.operation === 'OFFER' && sync.publishState === 'REQUESTED' ? (
                <p role="status" className="text-sm text-muted">
                  جارٍ النشر في Flowmax؛ تتحدث الحالة تلقائيًا.
                </p>
              ) : sync.operation === 'OFFER' ? (
                <>
                  <p className="text-xs text-muted">
                    أُرسل العقار ولم يُنشر؛ لا تظهر المشاركة العامة قبل نشره وتأكيد Flowmax.
                  </p>
                  {canReview && (
                    <Button onClick={() => void act('publish')} loading={busy}>
                      {sync.publishState === 'FAILED' ? 'إعادة محاولة النشر' : 'نشر في Flowmax'}
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <Alert tone="info" title="بانتظار مراجعة Flowmax">
                    أُرسل الطلب ولم يُنشر بعد. لا يُعتبر منشورًا ولا تظهر المشاركة العامة حتى يؤكد
                    Flowmax نشره بعد مراجعته.
                  </Alert>
                  {canReview && (
                    <Button variant="secondary" onClick={() => void act('refresh')} loading={busy}>
                      تحديث الحالة من Flowmax
                    </Button>
                  )}
                </>
              )}
            </>
          )}
          {sync.sentAt && (
            <p className="text-xs text-muted">وقت الإرسال: {formatDateTime(sync.sentAt)}</p>
          )}
          {sync.share && sync.detailUrl && (
            <>
              <Alert tone="success">
                {sync.operation === 'OFFER'
                  ? 'تم إنشاء العقار ونشره في Flowmax بنجاح.'
                  : 'نُشر الطلب في Flowmax.'}
              </Alert>
              <PublishedSummary share={sync.share} reference={sync.flowmaxRef} />
              <ShareActions share={sync.share} url={sync.detailUrl} />
            </>
          )}
        </div>
      )}
      {error && (
        <div className="mt-3">
          <Alert tone="error">
            {error.text}
            {error.items.length > 0 && (
              <ul className="mt-2 list-disc ps-5">
                {error.items.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
          </Alert>
        </div>
      )}
    </Card>
  );
}
