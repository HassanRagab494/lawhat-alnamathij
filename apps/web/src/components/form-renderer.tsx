'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import {
  validateAnswers,
  visibleKeys,
  type AnswerValue,
  type RenderQuestion,
} from '@/lib/answer-validation';
import { FILE_TYPE_LABELS } from '@/lib/question-limits';
import { Alert, Button, EmptyState, SelectInput, TextArea, TextInput } from './ui';
import { FileUploadControl, type UploadsController } from './file-upload-control';

export type Answers = Record<string, AnswerValue>;

/** أسئلة أُخفيت بتغيير إجابة سؤال اختيار وكانت لها إجابات (تبقى في الصفحة ولا تُرسل). */
interface BranchNotice {
  key: string;
  titles: string[];
  files: boolean;
}

function hasValue(v: AnswerValue): boolean {
  return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim() !== '';
}

/** وضع التعبئة العامة: الإجابات والأخطاء تديرها الصفحة، والإرسال الفعلي عبر onSubmit. */
export interface PublicModeProps {
  answers: Answers;
  onAnswersChange: (next: Answers) => void;
  /** أخطاء لكل سؤال (بمفتاح السؤال)، من التحقق المحلي أو من الخادم. */
  errors: Record<string, string>;
  onErrorsChange: (next: Record<string, string>) => void;
  /** يُستدعى فقط بعد نجاح التحقق المحلي. */
  onSubmit: (answers: Answers) => void;
  submitting: boolean;
  /** رسالة عامة فوق زر الإرسال (فشل الشبكة، تحديث الإصدار...). */
  notice?: ReactNode;
  /** يعطّل الإرسال (مثلًا حين يلزم تحديث النموذج أولًا). */
  submitDisabled?: boolean;
  /** رفع الملفات الفعلي لأسئلة الملفات (الصفحة العامة فقط). */
  uploads?: UploadsController;
}

/**
 * يعرض النموذج كما سيراه من يعبّئه، بوضعين:
 * - المعاينة (الافتراضي): لا يرسل ولا يحفظ أي إجابة.
 * - العام (publicMode): تعبئة حقيقية بزر «إرسال»؛ الإجابات تبقى في الذاكرة فقط (لا localStorage).
 */
export function FormRenderer({
  title,
  description,
  questions,
  publicMode,
}: {
  title: string;
  description: string | null;
  questions: RenderQuestion[];
  publicMode?: PublicModeProps;
}) {
  const [localAnswers, setLocalAnswers] = useState<Answers>({});
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<'valid' | 'invalid' | null>(null);
  const [branchNotice, setBranchNotice] = useState<BranchNotice | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const answers = publicMode ? publicMode.answers : localAnswers;
  const errors = publicMode ? publicMode.errors : localErrors;
  const setAnswers = publicMode ? publicMode.onAnswersChange : setLocalAnswers;
  const setErrors = publicMode ? publicMode.onErrorsChange : setLocalErrors;

  const visible = visibleKeys(questions, answers);

  function setAnswer(key: string, value: AnswerValue) {
    const next = { ...answers, [key]: value };
    const after = visibleKeys(questions, next);
    // لا تُفقد البيانات بصمت: أسئلة الفرع السابق تبقى إجاباتها في الصفحة، مع تنبيه بأنها لن تُرسل.
    const hidden = questions.filter(
      (q) => visible.has(q.key) && !after.has(q.key) && hasValue(next[q.key]),
    );
    if (hidden.length) {
      setBranchNotice({
        key,
        titles: hidden.map((q) => q.title),
        files: hidden.some((q) => q.type === 'FILE_UPLOAD'),
      });
    } else if (branchNotice?.key === key) {
      setBranchNotice(null);
    }
    setAnswers(next);
    const kept = Object.entries(errors).filter(([k]) => k !== key && after.has(k));
    if (kept.length !== Object.keys(errors).length) setErrors(Object.fromEntries(kept));
    setChecked(null);
  }

  function focusFirstError() {
    requestAnimationFrame(() => {
      const section = formRef.current?.querySelector('[data-question-error="true"]');
      section?.querySelector<HTMLElement>('input, textarea, select')?.focus();
    });
  }

  function runValidation() {
    const result = validateAnswers(questions, answers);
    setErrors(result);
    setChecked(Object.keys(result).length ? 'invalid' : 'valid');
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!publicMode || publicMode.submitting || publicMode.submitDisabled) return;
    const result = validateAnswers(questions, answers);
    setErrors(result);
    if (Object.keys(result).length) {
      focusFirstError();
      return;
    }
    publicMode.onSubmit(answers);
  }

  const errorCount = Object.keys(errors).length;
  const heading = title.trim() || 'نموذج بلا عنوان';

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={handleSubmit}
      className="flex flex-col gap-4"
      aria-busy={publicMode?.submitting || undefined}
    >
      {!publicMode && (
        <Alert tone="info" title="معاينة — لن تُحفظ الإجابات">
          جرّب تعبئة النموذج والتحقق من الإجابات. لا يُرسل أي شيء ولا يُنشأ أي رد.
        </Alert>
      )}

      <section className="glass rounded-2xl border-t-4 border-t-velvet-700 p-5 sm:p-6">
        {publicMode ? (
          <h1 className="text-xl font-bold text-velvet-900 sm:text-2xl">{heading}</h1>
        ) : (
          <h2 className="text-xl font-bold text-velvet-900">{heading}</h2>
        )}
        {description && (
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted">
            {description}
          </p>
        )}
        {questions.some((q) => q.required) && (
          <p className="mt-3 text-xs text-red-800">* يشير إلى سؤال إجباري</p>
        )}
      </section>

      {questions.length === 0 ? (
        <section className="glass rounded-2xl">
          <EmptyState title="لا توجد أسئلة بعد" description="أضف أسئلة من المحرر لتظهر هنا." />
        </section>
      ) : (
        questions
          .filter((q) => visible.has(q.key))
          .map((q) => (
            <PreviewQuestion
              key={q.key}
              question={q}
              value={answers[q.key]}
              error={errors[q.key]}
              uploads={publicMode?.uploads}
              onChange={(v) => setAnswer(q.key, v)}
              notice={
                branchNotice?.key === q.key ? (
                  <BranchNoticeAlert notice={branchNotice} />
                ) : undefined
              }
            />
          ))
      )}

      {questions.length > 0 && !publicMode && (
        <div className="flex flex-col gap-3">
          {checked === 'valid' && (
            <Alert tone="success">
              الإجابات صالحة حسب إعدادات الأسئلة. لم يُرسل أو يُحفظ أي شيء.
            </Alert>
          )}
          {checked === 'invalid' && (
            <Alert tone="error">
              توجد {errorCount} إجابة غير صالحة. راجع الرسائل بجانب الأسئلة.
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={runValidation}>
              تجربة التحقق من الإجابات
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setLocalAnswers({});
                setLocalErrors({});
                setChecked(null);
              }}
            >
              مسح الإجابات
            </Button>
          </div>
        </div>
      )}

      {questions.length > 0 && publicMode && (
        <div className="flex flex-col gap-3">
          {errorCount > 0 && (
            <Alert tone="error">
              {errorCount === 1
                ? 'توجد إجابة تحتاج مراجعة. راجع الرسالة بجانب السؤال.'
                : `توجد ${errorCount} إجابات تحتاج مراجعة. راجع الرسائل بجانب الأسئلة.`}
            </Alert>
          )}
          {publicMode.notice}
          <Button
            type="submit"
            className="w-full sm:w-auto sm:self-start"
            loading={publicMode.submitting}
            disabled={publicMode.submitDisabled}
          >
            {publicMode.submitting ? 'جارٍ الإرسال…' : 'إرسال'}
          </Button>
        </div>
      )}
    </form>
  );
}

function BranchNoticeAlert({ notice }: { notice: BranchNotice }) {
  const count = notice.titles.length;
  const what = count === 1 ? 'سؤال أجبت عنه' : `${count} أسئلة أجبت عنها`;
  const list = notice.titles.map((t) => `«${t}»`).join('، ');
  const files = notice.files
    ? '، والملفات المرفوعة لها لا تُرفق بالرد وتُحذف تلقائيًا من الخادم لاحقًا'
    : '';
  return (
    <div className="mt-3">
      <Alert tone="warning" title="تغيّرت الأسئلة الظاهرة">
        {`بهذا الاختيار أُخفي ${what}: ${list}. إجاباتها محفوظة في الصفحة لكنها لن تُرسل ما دامت مخفية${files}. ارجع للاختيار السابق لاستعادتها.`}
      </Alert>
    </div>
  );
}

function constraintHint(q: RenderQuestion): string | null {
  const s = q.settings;
  const parts: string[] = [];
  switch (q.type) {
    case 'SHORT_TEXT':
    case 'PARAGRAPH':
      if (s.minLength !== undefined && s.maxLength !== undefined) {
        parts.push(`من ${s.minLength} إلى ${s.maxLength} حرف`);
      } else if (s.minLength !== undefined) parts.push(`${s.minLength} حرف على الأقل`);
      else if (s.maxLength !== undefined) parts.push(`حتى ${s.maxLength} حرف`);
      break;
    case 'NUMBER':
      parts.push(s.allowDecimals ? 'يُسمح بالكسور' : 'أعداد صحيحة فقط');
      if (s.min !== undefined) parts.push(`الحد الأدنى ${s.min}`);
      if (s.max !== undefined) parts.push(`الحد الأقصى ${s.max}`);
      break;
    case 'DATE':
      if (s.minDate) parts.push(`من ${s.minDate}`);
      if (s.maxDate) parts.push(`حتى ${s.maxDate}`);
      break;
    case 'MULTIPLE_CHOICE':
      if (s.minSelections !== undefined) parts.push(`اختر ${s.minSelections} على الأقل`);
      if (s.maxSelections !== undefined) parts.push(`${s.maxSelections} كحد أقصى`);
      break;
    default:
      break;
  }
  return parts.length ? parts.join(' · ') : null;
}

function PreviewQuestion({
  question: q,
  value,
  error,
  uploads,
  onChange,
  notice,
}: {
  question: RenderQuestion;
  uploads?: UploadsController;
  value: AnswerValue;
  error?: string;
  onChange: (v: AnswerValue) => void;
  notice?: ReactNode;
}) {
  const id = useId();
  const hint = constraintHint(q);
  const descId = q.description ? `${id}-desc` : undefined;
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [descId, hintId, errId].filter(Boolean).join(' ') || undefined;
  const isGroup = q.type === 'SINGLE_CHOICE' || q.type === 'MULTIPLE_CHOICE';
  const labelContent = (
    <>
      {q.title}
      {q.required && (
        <>
          <span className="text-red-700" aria-hidden="true">
            {' '}
            *
          </span>
          <span className="sr-only"> (إجباري)</span>
        </>
      )}
    </>
  );

  const common = {
    id,
    'aria-describedby': describedBy,
    'aria-invalid': Boolean(error),
    'aria-required': q.required,
  };

  let control: React.ReactNode;
  switch (q.type) {
    case 'SHORT_TEXT':
      control = (
        <TextInput
          {...common}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case 'PARAGRAPH':
      control = (
        <TextArea
          {...common}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case 'NUMBER':
      control = (
        <TextInput
          {...common}
          inputMode={q.settings.allowDecimals ? 'decimal' : 'numeric'}
          dir="ltr"
          className="text-start"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case 'DATE':
      control = (
        <TextInput
          {...common}
          type="date"
          min={q.settings.minDate}
          max={q.settings.maxDate}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case 'DROPDOWN':
      control = (
        <SelectInput
          {...common}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">اختر…</option>
          {q.options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </SelectInput>
      );
      break;
    case 'SINGLE_CHOICE':
    case 'MULTIPLE_CHOICE': {
      const multi = q.type === 'MULTIPLE_CHOICE';
      const selected = multi ? ((value as string[]) ?? []) : value;
      control = (
        <div className="flex flex-col gap-2">
          {q.options.map((o) => {
            const isOn = multi ? (selected as string[]).includes(o.key) : selected === o.key;
            return (
              <label
                key={o.key}
                className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors ${
                  isOn
                    ? 'border-velvet-500 bg-velvet-50'
                    : 'border-smoke-300 bg-white/70 hover:border-velvet-300'
                }`}
              >
                <input
                  type={multi ? 'checkbox' : 'radio'}
                  name={id}
                  className="size-5 accent-velvet-700"
                  aria-label={o.label}
                  checked={isOn}
                  onChange={(e) => {
                    if (!multi) onChange(o.key);
                    else {
                      const cur = (selected as string[]) ?? [];
                      onChange(e.target.checked ? [...cur, o.key] : cur.filter((k) => k !== o.key));
                    }
                  }}
                />
                <span className="text-sm text-ink">{o.label}</span>
              </label>
            );
          })}
        </div>
      );
      break;
    }
    case 'FILE_UPLOAD': {
      const s = q.settings;
      if (uploads) {
        control = (
          <FileUploadControl
            id={id}
            question={q}
            describedBy={describedBy}
            invalid={Boolean(error)}
            controller={uploads}
          />
        );
        break;
      }
      control = (
        <div className="flex flex-col gap-2">
          <input
            id={id}
            type="file"
            disabled
            aria-describedby={describedBy}
            className="w-full cursor-not-allowed rounded-xl border border-dashed border-smoke-300 bg-smoke-100 p-3 text-sm text-muted"
          />
          <ul className="flex flex-col gap-1 text-xs text-muted">
            <li>
              الأنواع المسموحة:{' '}
              {(s.allowedTypes ?? []).map((t) => FILE_TYPE_LABELS[t]).join('، ') || '—'}
            </li>
            {s.maxFileSizeMb !== undefined && (
              <li>الحجم الأقصى لكل ملف: {s.maxFileSizeMb} ميغابايت</li>
            )}
            {s.maxFiles !== undefined && <li>العدد الأقصى للملفات: {s.maxFiles}</li>}
          </ul>
          <p className="text-xs font-semibold text-amber-900">
            في المعاينة لا يُرفع شيء؛ الرفع متاح على الرابط العام بعد النشر.
          </p>
        </div>
      );
      break;
    }
    default:
      control = null;
  }

  return (
    <section
      className="glass rounded-2xl p-5"
      aria-invalid={Boolean(error) || undefined}
      data-question-error={error ? 'true' : undefined}
    >
      {isGroup ? (
        <fieldset aria-describedby={describedBy}>
          <legend className="mb-2 text-base font-semibold text-ink">{labelContent}</legend>
          {q.description && (
            <p id={descId} className="mb-3 whitespace-pre-line text-sm text-muted">
              {q.description}
            </p>
          )}
          {control}
        </fieldset>
      ) : (
        <div className="flex flex-col gap-2">
          <label htmlFor={id} className="text-base font-semibold text-ink">
            {labelContent}
          </label>
          {q.description && (
            <p id={descId} className="whitespace-pre-line text-sm text-muted">
              {q.description}
            </p>
          )}
          {control}
        </div>
      )}
      {hint && (
        <p id={hintId} className="mt-2 text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} role="alert" className="mt-2 text-sm font-medium text-red-800">
          {error}
        </p>
      )}
      {notice}
    </section>
  );
}
