'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import {
  OPERATION_LABELS,
  SYNC_STATUS_LABELS,
  SYNC_STATUS_TONES,
  shareText,
  whatsappShareUrl,
  type FlowmaxShare,
  type FlowmaxState,
} from '@/lib/flowmax';
import { Alert, Badge, Button, Card } from './ui';

const POLL_MS = 2000;

/** أزرار المشاركة بعد نجاح الإرسال فقط. النص لا يحتوي بيانات المالك. */
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

/**
 * لوحة Flowmax في تفاصيل الرد: الحالة والرابط لمن يعرض الردود، وأزرار الاعتماد وإعادة المحاولة
 * لمن يملك مراجعة الردود فقط (الخادم يفرض الصلاحية نفسها).
 */
export function FlowmaxPanel({
  formId,
  responseId,
  canReview,
  onApproved,
}: {
  formId: string;
  responseId: string;
  canReview: boolean;
  onApproved?: () => void;
}) {
  const base = `/forms/${formId}/responses/${responseId}/flowmax`;
  const [state, setState] = useState<FlowmaxState | null>(null);
  const [busy, setBusy] = useState(false);
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
  useEffect(() => {
    if (status !== 'PENDING' && status !== 'SENDING') return;
    const t = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(t);
  }, [status, state, load]);

  async function act(action: 'approve' | 'retry') {
    setBusy(true);
    setError(null);
    try {
      setState(await api<FlowmaxState>(`${base}/${action}`, { method: 'POST', body: {} }));
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
  const { sync } = state;
  if (!sync && (!state.integrationEnabled || !state.mappingEnabled)) return null;

  return (
    <Card className="h-fit p-5">
      <h2 className="mb-3 text-base font-bold text-velvet-900">Flowmax</h2>
      {!sync ? (
        canReview ? (
          <>
            <p className="mb-3 text-sm text-muted">
              الاعتماد يغيّر حالة الرد إلى «مقبول» ويرسل بياناته إلى Flowmax. لا يُرسل شيء قبل ذلك.
            </p>
            <Button className="w-full" onClick={() => void act('approve')} loading={busy}>
              اعتماد وإرسال إلى Flowmax
            </Button>
          </>
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
          {sync.status === 'SENT' && sync.url && (
            <>
              <p className="text-sm">
                <a
                  href={sync.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  dir="ltr"
                  className="break-all font-semibold text-velvet-700 underline"
                >
                  {sync.url}
                </a>
              </p>
              {!sync.published && sync.operation === 'OFFER' && (
                <p className="text-xs text-muted">
                  أُنشئ العقار مسودة في Flowmax؛ يظهر الرابط للزوار بعد نشره هناك.
                </p>
              )}
              {sync.mediaSkipped > 0 && (
                <p className="text-xs text-muted">
                  لم تُرسل {sync.mediaSkipped} من الوسائط لتجاوزها حدود Flowmax.
                </p>
              )}
              {sync.sentAt && (
                <p className="text-xs text-muted">وقت الإرسال: {formatDateTime(sync.sentAt)}</p>
              )}
              {sync.share && <ShareActions share={sync.share} url={sync.url} />}
            </>
          )}
          {(sync.status === 'PENDING' || sync.status === 'SENDING') && (
            <p role="status" className="text-sm text-muted">
              يُرسل الآن؛ تتحدث الحالة تلقائيًا.
            </p>
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
