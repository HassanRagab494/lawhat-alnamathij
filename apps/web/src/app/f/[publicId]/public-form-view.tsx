'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FormRenderer } from '@/components/form-renderer';
import { Alert, Button, LoadingState } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import {
  buildPayload,
  carryOverAnswers,
  hasAnyAnswer,
  mapServerErrors,
  newIdempotencyKey,
  toRenderQuestions,
  type PublicAnswers,
  type PublicForm,
  type SubmitResult,
} from '@/lib/public-form';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'notFound' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; form: PublicForm }
  | { kind: 'success'; result: SubmitResult; title: string };

type Notice =
  | { kind: 'network'; message: string }
  | { kind: 'closed'; message: string }
  | { kind: 'outdated'; message: string }
  | { kind: 'general'; message: string };

/**
 * صفحة التعبئة العامة: بلا جلسة ولا أدوات إدارة. الإجابات في ذاكرة الصفحة فقط
 * (لا localStorage ولا تحليلات)، وتبقى عند فشل الشبكة أو التحقق أو تحديث الإصدار.
 */
export function PublicFormView({ publicId }: { publicId: string }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [answers, setAnswers] = useState<PublicAnswers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);
  // مفتاح الإرسال يُعاد استخدامه ما دام المحتوى نفسه (إعادة محاولة بعد انقطاع تعيد الرقم الأصلي).
  const attempt = useRef<{ key: string; fingerprint: string } | null>(null);
  const answersRef = useRef(answers);
  answersRef.current = answers;

  const fetchForm = useCallback(
    (signal?: AbortSignal) =>
      api<PublicForm>(`/public/forms/${encodeURIComponent(publicId)}`, { signal }),
    [publicId],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setState({ kind: 'loading' });
      try {
        const form = await fetchForm(signal);
        setState({ kind: 'ready', form });
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof ApiError && error.status === 404) setState({ kind: 'notFound' });
        else setState({ kind: 'error', message: errorMessage(error) });
      }
    },
    [fetchForm],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // تنبيه المتصفح قبل مغادرة الصفحة وفيها إجابات لم تُرسل.
  const hasUnsent = state.kind === 'ready' && hasAnyAnswer(answers);
  useEffect(() => {
    if (!hasUnsent) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsent]);

  async function submit(form: PublicForm, current: PublicAnswers) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setNotice(null);

    const fingerprint = JSON.stringify(buildPayload(form, current, ''));
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) {
      attempt.current = { key: newIdempotencyKey(), fingerprint };
    }
    const payload = buildPayload(form, current, attempt.current.key);

    try {
      const result = await api<SubmitResult>(
        `/public/forms/${encodeURIComponent(publicId)}/responses`,
        { method: 'POST', body: payload },
      );
      attempt.current = null;
      setAnswers({});
      setErrors({});
      setState({ kind: 'success', result, title: form.title });
      window.scrollTo({ top: 0 });
    } catch (error) {
      handleSubmitError(form, error);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  function handleSubmitError(form: PublicForm, error: unknown) {
    if (!(error instanceof ApiError)) {
      setNotice({ kind: 'general', message: errorMessage(error) });
      return;
    }
    switch (error.code) {
      case 'VALIDATION_FAILED': {
        const { byQuestion, general } = mapServerErrors(form, error.fields);
        setErrors(byQuestion);
        if (general.length) setNotice({ kind: 'general', message: general.join(' ') });
        return;
      }
      case 'VERSION_OUTDATED':
        setNotice({ kind: 'outdated', message: error.message });
        return;
      case 'RESPONSES_CLOSED':
        setNotice({ kind: 'closed', message: error.message });
        return;
      case 'IDEMPOTENCY_KEY_REUSED':
        attempt.current = null;
        setNotice({ kind: 'general', message: error.message });
        return;
      default:
        if (error.status === 0 || error.status >= 500) {
          setNotice({
            kind: 'network',
            message: `${error.message} إجاباتك ما زالت في الصفحة ولم يُرسل شيء بعد.`,
          });
        } else {
          setNotice({ kind: 'general', message: error.message });
        }
    }
  }

  /** يجلب الإصدار الأحدث وينقل الإجابات إليه بمفاتيحها المنطقية، دون أي إرسال تلقائي. */
  async function refreshVersion() {
    setRefreshing(true);
    try {
      const form = await fetchForm();
      if (!form.acceptingResponses) {
        // الإغلاق لا يعيد أسئلة؛ نبقي الأسئلة والإجابات الحالية معروضة مع التنبيه.
        setNotice({ kind: 'closed', message: 'استقبال الردود على هذا النموذج مغلق حاليًا.' });
        return;
      }
      setAnswers(carryOverAnswers(form, answersRef.current));
      setErrors({});
      attempt.current = null;
      setState({ kind: 'ready', form });
      setNotice(null);
    } catch (error) {
      setNotice({
        kind: 'outdated',
        message: `تعذر تحديث النموذج: ${errorMessage(error)} إجاباتك ما زالت في الصفحة.`,
      });
    } finally {
      setRefreshing(false);
    }
  }

  if (state.kind === 'loading') return <LoadingState label="جارٍ تحميل النموذج…" />;

  if (state.kind === 'notFound') {
    return (
      <StatusCard
        title="النموذج غير متاح"
        body="الرابط غير صحيح أو أن النموذج لم يُنشر بعد. تأكد من الرابط مع الجهة التي أرسلته."
      />
    );
  }

  if (state.kind === 'error') {
    return (
      <StatusCard title="تعذر تحميل النموذج" body={state.message}>
        <Button onClick={() => void load()}>إعادة المحاولة</Button>
      </StatusCard>
    );
  }

  if (state.kind === 'success') {
    return <SuccessCard title={state.title} result={state.result} />;
  }

  const { form } = state;

  if (!form.acceptingResponses && !hasAnyAnswer(answers)) {
    return (
      <StatusCard
        title={form.title}
        body="استقبال الردود على هذا النموذج مغلق حاليًا. يمكنك المحاولة لاحقًا إذا أعادت الجهة فتحه."
      />
    );
  }

  return (
    <FormRenderer
      title={form.title}
      description={form.description}
      questions={toRenderQuestions(form)}
      publicMode={{
        answers,
        onAnswersChange: setAnswers,
        errors,
        onErrorsChange: setErrors,
        submitting,
        submitDisabled: notice?.kind === 'outdated' || !form.versionId,
        onSubmit: (current) => void submit(form, current),
        notice: notice && (
          <NoticeAlert
            notice={notice}
            refreshing={refreshing}
            onRefresh={() => void refreshVersion()}
          />
        ),
      }}
    />
  );
}

function NoticeAlert({
  notice,
  refreshing,
  onRefresh,
}: {
  notice: Notice;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  if (notice.kind === 'outdated') {
    return (
      <Alert
        tone="warning"
        title="يلزم تحديث النموذج"
        action={
          <Button variant="secondary" loading={refreshing} onClick={onRefresh}>
            تحديث النموذج
          </Button>
        }
      >
        {notice.message} عند التحديث تُنقل إجاباتك للأسئلة التي ما زالت موجودة، ولن يُرسل شيء
        تلقائيًا.
      </Alert>
    );
  }
  if (notice.kind === 'closed') {
    return (
      <Alert tone="warning" title="الاستقبال مغلق">
        {notice.message} إجاباتك ما زالت في الصفحة.
      </Alert>
    );
  }
  return (
    <Alert tone="error" title={notice.kind === 'network' ? 'لم يُرسل الرد' : undefined}>
      {notice.message}
    </Alert>
  );
}

function StatusCard({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="glass flex flex-col items-center gap-3 rounded-2xl border-t-4 border-t-velvet-700 px-6 py-12 text-center">
      <h1 className="text-xl font-bold text-velvet-900">{title}</h1>
      <p className="max-w-md text-sm leading-relaxed text-muted">{body}</p>
      {children}
    </section>
  );
}

function SuccessCard({ title, result }: { title: string; result: SubmitResult }) {
  const [copied, setCopied] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(result.referenceCode);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="glass flex flex-col items-center gap-4 rounded-2xl border-t-4 border-t-emerald-600 px-6 py-12 text-center">
      <span
        aria-hidden="true"
        className="grid size-14 place-items-center rounded-full bg-emerald-100 text-2xl text-emerald-700"
      >
        ✓
      </span>
      <h1 ref={headingRef} tabIndex={-1} className="text-xl font-bold text-velvet-900 outline-none">
        تم إرسال ردك بنجاح
      </h1>
      <p className="text-sm text-muted">{title}</p>
      <div className="flex flex-col items-center gap-2">
        <p className="text-sm text-ink">الرقم المرجعي لردك:</p>
        <p
          dir="ltr"
          className="rounded-xl border border-velvet-200 bg-white px-4 py-2 font-mono text-lg font-bold tracking-wider text-velvet-900"
        >
          {result.referenceCode}
        </p>
        <Button variant="secondary" onClick={() => void copy()} className="min-h-9 py-1">
          {copied ? 'تم النسخ' : 'نسخ الرقم المرجعي'}
        </Button>
        <span role="status" className="sr-only">
          {copied ? 'تم نسخ الرقم المرجعي' : ''}
        </span>
      </div>
      <p className="max-w-md text-xs leading-relaxed text-muted">
        احتفظ بهذا الرقم إذا احتجت التواصل مع الجهة بخصوص ردك. الرقم لا يتيح عرض الإجابات أو
        تعديلها.
      </p>
    </section>
  );
}
