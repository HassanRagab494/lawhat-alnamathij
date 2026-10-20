'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { FormRenderer, type Answers } from '@/components/form-renderer';
import { Alert, Button, ErrorState, LoadingState } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { AnswerValue, RenderQuestion } from '@/lib/answer-validation';
import { visibleKeys } from '@/lib/answer-validation';
import type { QuestionType } from '@/lib/question-limits';
import type { ResponseDetail } from '@/lib/responses';
import { precheckFile, uploadResponseFile, type UploadItem } from '@/lib/uploads';
import { useApi } from '@/lib/use-api';

/** استجابة GET /forms/:id/responses/:responseId/edit. */
export interface EditForm {
  revision: number;
  locked: boolean;
  status: string;
  questions: {
    id: string;
    type: QuestionType;
    title: string;
    description: string | null;
    required: boolean;
    settings: RenderQuestion['settings'];
    options: { id: string; label: string }[];
    showIf: { questionId: string; optionIds: string[] } | null;
  }[];
  values: Record<string, string | string[]>;
  files: Record<string, { id: string; name: string; size: number }[]>;
}

/** أسئلة الإصدار بمفاتيح = معرّفات الإصدار، فتعمل الشروط والتحقق كما في النموذج العام. */
export function toRenderQuestions(edit: EditForm): RenderQuestion[] {
  return edit.questions.map((q) => ({
    key: q.id,
    type: q.type,
    title: q.title,
    description: q.description,
    required: q.required,
    settings: q.settings ?? {},
    options: q.options.map((o) => ({ key: o.id, label: o.label })),
    showIf: q.showIf ? { questionKey: q.showIf.questionId, optionKeys: q.showIf.optionIds } : null,
  }));
}

/** صيغة مقارنة: الفارغ والمصفوفة الفارغة سواء، والمصفوفات مرتبة، والنص بعد إزالة المسافات المحيطة. */
function norm(v: AnswerValue): string {
  if (v === undefined) return '';
  if (Array.isArray(v)) return v.length ? JSON.stringify([...v].sort()) : '';
  return v.trim();
}
const same = (a: AnswerValue, b: AnswerValue) => norm(a) === norm(b);

/**
 * التعديلات المرسلة: الأسئلة الظاهرة التي تغيّرت قيمتها فقط (null للمسح). أسئلة الفرع المخفي لا تُرسل،
 * فتبقى قيمها المحفوظة كما هي ولا تُرسل إلى Flowmax.
 */
export function changedAnswers(
  questions: RenderQuestion[],
  initial: Answers,
  current: Answers,
): { questionId: string; value: string | string[] | null }[] {
  const visible = visibleKeys(questions, current);
  return questions
    .filter((q) => visible.has(q.key) && !same(initial[q.key], current[q.key]))
    .map((q) => {
      const v = current[q.key];
      const empty = v === undefined || (Array.isArray(v) ? v.length === 0 : v.trim() === '');
      return { questionId: q.key, value: empty ? null : Array.isArray(v) ? v : v.trim() };
    });
}

let seq = 0;

export function ResponseEditor({
  formId,
  responseId,
  onSaved,
  onCancel,
}: {
  formId: string;
  responseId: string;
  onSaved: (detail: ResponseDetail) => void;
  onCancel: () => void;
}) {
  const { data, errorText, loading, reload, setData } = useApi<EditForm>(
    `/forms/${formId}/responses/${responseId}/edit`,
  );
  if (loading && !data) return <LoadingState label="جارٍ تحميل بيانات التعديل…" />;
  if (!data)
    return <ErrorState message={errorText ?? 'تعذر تحميل بيانات التعديل.'} onRetry={reload} />;
  if (data.locked) {
    return <Alert tone="info">أُرسل هذا الرد إلى Flowmax، فلا يمكن تعديله.</Alert>;
  }
  return (
    <EditorBody
      key={data.revision}
      formId={formId}
      responseId={responseId}
      edit={data}
      onSaved={onSaved}
      onCancel={onCancel}
      onConflict={(current) => setData(current)}
    />
  );
}

function EditorBody({
  formId,
  responseId,
  edit,
  onSaved,
  onCancel,
  onConflict,
}: {
  formId: string;
  responseId: string;
  edit: EditForm;
  onSaved: (detail: ResponseDetail) => void;
  onCancel: () => void;
  onConflict: (current: EditForm) => void;
}) {
  const questions = useMemo(() => toRenderQuestions(edit), [edit]);
  const initial = useMemo<Answers>(() => ({ ...edit.values }), [edit]);
  const [answers, setAnswers] = useState<Answers>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ tone: 'error' | 'warning'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [items, setItems] = useState<Record<string, UploadItem[]>>(() =>
    Object.fromEntries(
      Object.entries(edit.files).map(([key, files]) => [
        key,
        files.map((f) => ({
          localId: `e${++seq}`,
          name: f.name,
          size: f.size,
          status: 'ready' as const,
          progress: 100,
          fileId: f.id,
        })),
      ]),
    ),
  );
  const aborts = useRef(new Map<string, () => void>());

  const patch = useCallback((key: string, localId: string, change: Partial<UploadItem>) => {
    setItems((all) => ({
      ...all,
      [key]: (all[key] ?? []).map((i) => (i.localId === localId ? { ...i, ...change } : i)),
    }));
  }, []);

  function onAdd(key: string, files: File[]) {
    const q = questions.find((x) => x.key === key);
    if (!q) return;
    const current = (items[key] ?? []).filter((i) => i.status !== 'error').length;
    const max = q.settings.maxFiles ?? 1;
    const added = files.map((file, idx) => {
      const pre =
        current + idx >= max
          ? `الحد الأقصى ${max} ${max === 1 ? 'ملف' : 'ملفات'} لهذا السؤال.`
          : precheckFile(file, q.settings);
      const item: UploadItem = {
        localId: `e${++seq}`,
        name: file.name,
        size: file.size,
        status: pre ? 'error' : 'uploading',
        progress: 0,
        error: pre ?? undefined,
      };
      return { file, item };
    });
    setItems((all) => ({ ...all, [key]: [...(all[key] ?? []), ...added.map((a) => a.item)] }));
    for (const { file, item } of added) {
      if (item.status === 'error') continue;
      const { promise, abort } = uploadResponseFile(
        formId,
        responseId,
        key,
        file,
        (progress) => patch(key, item.localId, { progress }),
        () => patch(key, item.localId, { status: 'checking', progress: 100 }),
      );
      aborts.current.set(item.localId, abort);
      promise
        .then((r) => patch(key, item.localId, { status: 'ready', fileId: r.id, name: r.name }))
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.code === 'ABORTED') return;
          patch(key, item.localId, { status: 'error', error: errorMessage(error) });
        })
        .finally(() => aborts.current.delete(item.localId));
    }
  }

  function onRemove(key: string, localId: string) {
    aborts.current.get(localId)?.();
    // لا يُحذف شيء من الخادم: الإزالة تُطبق عند الحفظ وتُسجَّل، والملف الأصلي يبقى محفوظًا
    setItems((all) => ({ ...all, [key]: (all[key] ?? []).filter((i) => i.localId !== localId) }));
  }

  const busy = Object.values(items).some((l) =>
    l.some((i) => i.status === 'uploading' || i.status === 'checking'),
  );
  const withFiles: Answers = { ...answers };
  for (const q of questions) {
    if (q.type === 'FILE_UPLOAD') {
      withFiles[q.key] = (items[q.key] ?? [])
        .filter((i) => i.status === 'ready' && i.fileId)
        .map((i) => i.fileId!);
    }
  }
  const initialWithFiles: Answers = {
    ...initial,
    ...Object.fromEntries(
      questions
        .filter((q) => q.type === 'FILE_UPLOAD')
        .map((q) => [q.key, (edit.files[q.key] ?? []).map((f) => f.id)]),
    ),
  };

  async function save(current: Answers) {
    const changes = changedAnswers(questions, initialWithFiles, current);
    if (!changes.length) {
      setNotice({ tone: 'warning', text: 'لم تغيّر أي قيمة.' });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const detail = await api<ResponseDetail>(`/forms/${formId}/responses/${responseId}/answers`, {
        method: 'PATCH',
        body: { revision: edit.revision, answers: changes },
      });
      onSaved(detail);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'RESPONSE_EDIT_CONFLICT') {
        const latest = (error.details as { current?: EditForm } | undefined)?.current;
        setNotice({
          tone: 'warning',
          text: 'عدّل مستخدم آخر هذا الرد بعد أن فتحته، فلم يُحفظ تعديلك. عُرضت القيم الحالية؛ أعد تطبيق تعديلك.',
        });
        if (latest) onConflict(latest);
      } else if (error instanceof ApiError && error.code === 'VALIDATION_FAILED') {
        const byKey: Record<string, string> = {};
        const general: string[] = [];
        for (const f of error.fields) {
          const m = /^answers\.([0-9a-f-]{36})$/i.exec(f.field);
          if (m && questions.some((q) => q.key === m[1]!.toLowerCase()))
            byKey[m[1]!.toLowerCase()] ??= f.message;
          else general.push(f.message);
        }
        setErrors(byKey);
        setNotice({ tone: 'error', text: general.join(' ') || 'راجع الحقول المظللة.' });
      } else {
        setNotice({ tone: 'error', text: errorMessage(error) });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Alert tone="info" title="تعديل بيانات الرد">
        عدّل ما يلزم ثم احفظ. يُعاد التحقق من الرد كاملًا، وتُسجَّل القيمة الأصلية والمعدلة باسمك
        ووقت التعديل. تغيير «عرض/طلب» يُظهر أسئلة المسار الجديد، وقيم المسار المخفي تبقى محفوظة ولا
        تُرسل.
      </Alert>
      <FormRenderer
        title=""
        description={null}
        questions={questions}
        publicMode={{
          answers: withFiles,
          onAnswersChange: (next) => {
            const plain = { ...next };
            for (const q of questions) if (q.type === 'FILE_UPLOAD') delete plain[q.key];
            setAnswers(plain);
          },
          errors,
          onErrorsChange: setErrors,
          submitting: saving,
          submitDisabled: busy,
          submitLabel: 'حفظ التعديلات',
          hideHeader: true,
          uploads: { items, malwareScanning: true, onAdd, onRemove },
          onSubmit: (current) => void save(current),
          notice: (
            <>
              {busy && <Alert tone="info">انتظر اكتمال رفع الملفات قبل الحفظ.</Alert>}
              {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
            </>
          ),
        }}
      />
      <Button variant="secondary" className="self-start" onClick={onCancel} disabled={saving}>
        إلغاء التعديل
      </Button>
    </div>
  );
}
