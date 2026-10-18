'use client';

import { useId } from 'react';
import {
  maxFileSizeFor,
  moveItem,
  newKey,
  type EditorQuestion,
  type EditorSettings,
} from '@/lib/draft';
import {
  FILE_TYPE_KEYS,
  FILE_TYPE_LABELS,
  QUESTION_LIMITS as L,
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  isChoiceType,
  type QuestionType,
} from '@/lib/question-limits';
import { Field, IconButton, SelectInput, TextArea, TextInput } from './ui';

/** أخطاء هذا السؤال فقط بمسارات نسبية (title، settings.maxLength، options.0.label ...). */
export type QuestionErrors = Record<string, string>;

export function QuestionEditor({
  question: q,
  index,
  total,
  earlier,
  errors,
  onChange,
  onTypeChange,
  onMove,
  onDelete,
}: {
  question: EditorQuestion;
  index: number;
  total: number;
  /** الأسئلة التي قبل هذا السؤال (للشرط: أسئلة الاختيار منها فقط). */
  earlier: EditorQuestion[];
  errors: QuestionErrors;
  onChange: (q: EditorQuestion) => void;
  onTypeChange: (type: QuestionType) => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}) {
  const number = index + 1;
  const headingId = useId();
  const hasErrors = Object.keys(errors).length > 0;
  const setSettings = (patch: Partial<EditorSettings>) =>
    onChange({ ...q, settings: { ...q.settings, ...patch } });

  return (
    <section
      aria-labelledby={headingId}
      className={`glass rounded-2xl p-4 sm:p-5 ${hasErrors ? 'ring-2 ring-red-300' : ''}`}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 id={headingId} className="text-base font-bold text-velvet-900">
          السؤال {number}
          {q.title.trim() && <span className="sr-only">: {q.title}</span>}
          {!q.id && (
            <span className="ms-2 rounded-full bg-velvet-100 px-2 py-0.5 text-xs font-semibold text-velvet-800">
              جديد
            </span>
          )}
          {q.showIf && (
            <span className="ms-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
              مشروط
            </span>
          )}
          {q.semanticKey && (
            <span
              className="ms-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900"
              title={`الهوية الدلالية: ${q.semanticKey}`}
            >
              مربوط بـ Flowmax
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          <IconButton
            icon="up"
            label={`نقل السؤال ${number} لأعلى`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          />
          <IconButton
            icon="down"
            label={`نقل السؤال ${number} لأسفل`}
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          />
          <IconButton
            icon="delete"
            tone="danger"
            label={`حذف السؤال ${number}`}
            onClick={onDelete}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[1fr_14rem]">
        <Field label="عنوان السؤال" required error={errors.title}>
          {({ id, describedBy, invalid }) => (
            <TextInput
              id={id}
              value={q.title}
              maxLength={L.questionTitleMax}
              placeholder="اكتب السؤال"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(e) => onChange({ ...q, title: e.target.value })}
            />
          )}
        </Field>
        <Field label="نوع السؤال" error={errors.type}>
          {({ id, describedBy }) => (
            <SelectInput
              id={id}
              value={q.type}
              aria-describedby={describedBy}
              onChange={(e) => onTypeChange(e.target.value as QuestionType)}
            >
              {QUESTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {QUESTION_TYPE_LABELS[t]}
                </option>
              ))}
            </SelectInput>
          )}
        </Field>
      </div>

      <div className="mt-4">
        <Field label="وصف مساعد (اختياري)" error={errors.description}>
          {({ id, describedBy, invalid }) => (
            <TextArea
              id={id}
              className="min-h-20"
              value={q.description}
              maxLength={L.questionDescriptionMax}
              placeholder="توضيح يظهر تحت السؤال"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(e) => onChange({ ...q, description: e.target.value })}
            />
          )}
        </Field>
      </div>

      <TypeSettings question={q} errors={errors} setSettings={setSettings} />

      {isChoiceType(q.type) && <OptionsEditor question={q} errors={errors} onChange={onChange} />}

      <ConditionEditor
        question={q}
        number={number}
        earlier={earlier}
        error={errors.showIf}
        onChange={onChange}
      />

      {q.semanticKey && (
        <p className="mt-3 text-xs text-muted">
          هذا السؤال من القالب العقاري ومربوط بحقل في Flowmax بهوية ثابتة؛ تغيير صياغته لا يؤثر على
          الربط، أما حذفه فيجعل الحقل ناقصًا عند الاعتماد إن كان مطلوبًا.
        </p>
      )}

      <label className="mt-4 flex w-fit cursor-pointer items-center gap-3 rounded-xl px-1 py-2">
        <input
          type="checkbox"
          className="size-5 accent-velvet-700"
          aria-label={`سؤال إجباري (السؤال ${number})`}
          checked={q.required}
          onChange={(e) => onChange({ ...q, required: e.target.checked })}
        />
        <span className="text-sm font-semibold text-ink">سؤال إجباري</span>
      </label>
    </section>
  );
}

/** شرط الظهور: سؤال اختيار سابق وخيارات تُظهر هذا السؤال. */
function ConditionEditor({
  question: q,
  number,
  earlier,
  error,
  onChange,
}: {
  question: EditorQuestion;
  number: number;
  earlier: EditorQuestion[];
  error?: string;
  onChange: (q: EditorQuestion) => void;
}) {
  const selectId = useId();
  const candidates = earlier
    .map((x, i) => ({ q: x, number: i + 1 }))
    .filter((x) => isChoiceType(x.q.type));
  const target = q.showIf ? earlier.find((x) => x.key === q.showIf!.questionKey) : undefined;
  const enabled = Boolean(q.showIf);

  function enable(on: boolean) {
    if (!on) return onChange({ ...q, showIf: null });
    const first = candidates[0]?.q;
    if (first) onChange({ ...q, showIf: { questionKey: first.key, optionKeys: [] } });
  }

  return (
    <fieldset className="mt-4 rounded-xl border border-smoke-200 bg-white/50 p-4">
      <legend className="px-1 text-sm font-bold text-velvet-900">شرط الظهور</legend>
      <label className="flex w-fit cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          className="size-5 accent-velvet-700"
          aria-label={`إظهار السؤال ${number} حسب إجابة سؤال سابق`}
          checked={enabled}
          disabled={!enabled && candidates.length === 0}
          onChange={(e) => enable(e.target.checked)}
        />
        <span className="text-sm text-ink">إظهار هذا السؤال فقط حسب إجابة سؤال اختيار سابق</span>
      </label>
      {!enabled && candidates.length === 0 && (
        <p className="mt-1 text-xs text-muted">لا يوجد سؤال اختيار قبل هذا السؤال.</p>
      )}
      {enabled && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={selectId} className="text-sm font-semibold text-ink">
              يعتمد على السؤال
            </label>
            <SelectInput
              id={selectId}
              value={target?.key ?? ''}
              onChange={(e) =>
                onChange({ ...q, showIf: { questionKey: e.target.value, optionKeys: [] } })
              }
            >
              {!target && <option value="">اختر سؤالًا…</option>}
              {candidates.map((c) => (
                <option key={c.q.key} value={c.q.key}>
                  {c.number}. {c.q.title.trim() || 'سؤال بلا عنوان'}
                </option>
              ))}
            </SelectInput>
          </div>
          {target && isChoiceType(target.type) && (
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-ink">
                يظهر عند اختيار أي من:
              </legend>
              <div className="flex flex-wrap gap-2">
                {target.options.map((o) => {
                  const on = q.showIf!.optionKeys.includes(o.key);
                  return (
                    <label
                      key={o.key}
                      className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                        on ? 'border-velvet-500 bg-velvet-50' : 'border-smoke-300 bg-white/70'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="size-4 accent-velvet-700"
                        aria-label={o.label || 'خيار بلا نص'}
                        checked={on}
                        onChange={(e) =>
                          onChange({
                            ...q,
                            showIf: {
                              questionKey: target.key,
                              optionKeys: e.target.checked
                                ? [...q.showIf!.optionKeys, o.key]
                                : q.showIf!.optionKeys.filter((k) => k !== o.key),
                            },
                          })
                        }
                      />
                      {o.label || 'خيار بلا نص'}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
          <p className="text-xs text-muted">
            السؤال المخفي لا يكون إجباريًا، ولا تُقبل له إجابة أو ملفات عند الإرسال.
          </p>
        </div>
      )}
      {error && <p className="mt-2 text-sm font-medium text-red-800">{error}</p>}
    </fieldset>
  );
}

function NumberField({
  label,
  value,
  error,
  hint,
  onChange,
  decimals = false,
}: {
  label: string;
  value: string;
  error?: string;
  hint?: string;
  onChange: (v: string) => void;
  decimals?: boolean;
}) {
  return (
    <Field label={label} error={error} hint={hint}>
      {({ id, describedBy, invalid }) => (
        <TextInput
          id={id}
          dir="ltr"
          className="text-start"
          inputMode={decimals ? 'decimal' : 'numeric'}
          value={value}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

function TypeSettings({
  question: q,
  errors,
  setSettings,
}: {
  question: EditorQuestion;
  errors: QuestionErrors;
  setSettings: (patch: Partial<EditorSettings>) => void;
}) {
  const s = q.settings;
  const e = (k: string) => errors[`settings.${k}`];
  let body: React.ReactNode = null;

  switch (q.type) {
    case 'SHORT_TEXT':
    case 'PARAGRAPH': {
      const limit = q.type === 'SHORT_TEXT' ? L.shortTextMaxLength : L.paragraphMaxLength;
      body = (
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="أقل عدد أحرف (اختياري)"
            value={s.minLength}
            error={e('minLength')}
            hint={`من 0 إلى ${limit}`}
            onChange={(v) => setSettings({ minLength: v })}
          />
          <NumberField
            label="أقصى عدد أحرف (اختياري)"
            value={s.maxLength}
            error={e('maxLength')}
            hint={`حتى ${limit}`}
            onChange={(v) => setSettings({ maxLength: v })}
          />
        </div>
      );
      break;
    }
    case 'MULTIPLE_CHOICE':
      body = (
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="أقل عدد اختيارات (اختياري)"
            value={s.minSelections}
            error={e('minSelections')}
            hint={`لا يتجاوز عدد الخيارات (${q.options.length})`}
            onChange={(v) => setSettings({ minSelections: v })}
          />
          <NumberField
            label="أقصى عدد اختيارات (اختياري)"
            value={s.maxSelections}
            error={e('maxSelections')}
            onChange={(v) => setSettings({ maxSelections: v })}
          />
        </div>
      );
      break;
    case 'NUMBER':
      body = (
        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold text-ink">نوع الأرقام المقبولة</legend>
            <div className="flex flex-wrap gap-2">
              {[
                { v: false, label: 'أعداد صحيحة فقط' },
                { v: true, label: 'يُسمح بالكسور' },
              ].map((opt) => (
                <label
                  key={String(opt.v)}
                  className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                    s.allowDecimals === opt.v
                      ? 'border-velvet-500 bg-velvet-50'
                      : 'border-smoke-300 bg-white/70'
                  }`}
                >
                  <input
                    type="radio"
                    name={`decimals-${q.key}`}
                    className="size-4 accent-velvet-700"
                    aria-label={opt.label}
                    checked={s.allowDecimals === opt.v}
                    onChange={() => setSettings({ allowDecimals: opt.v })}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
            {e('allowDecimals') && (
              <p className="text-sm font-medium text-red-800">{e('allowDecimals')}</p>
            )}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              label="أصغر قيمة (اختياري)"
              value={s.min}
              decimals={s.allowDecimals}
              error={e('min')}
              onChange={(v) => setSettings({ min: v })}
            />
            <NumberField
              label="أكبر قيمة (اختياري)"
              value={s.max}
              decimals={s.allowDecimals}
              error={e('max')}
              onChange={(v) => setSettings({ max: v })}
            />
          </div>
        </div>
      );
      break;
    case 'DATE':
      body = (
        <div className="grid gap-4 sm:grid-cols-2">
          {(['minDate', 'maxDate'] as const).map((k) => (
            <Field
              key={k}
              label={k === 'minDate' ? 'أقدم تاريخ مسموح (اختياري)' : 'أحدث تاريخ مسموح (اختياري)'}
              error={e(k)}
            >
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  type="date"
                  min={L.dateMin}
                  max={L.dateMax}
                  value={s[k]}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(ev) => setSettings({ [k]: ev.target.value })}
                />
              )}
            </Field>
          ))}
        </div>
      );
      break;
    case 'FILE_UPLOAD':
      body = (
        <div className="flex flex-col gap-4">
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
            إعداد ومعاينة فقط؛ الرفع الفعلي للملفات غير متاح في هذه المرحلة.
          </p>
          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-ink">الأنواع المسموحة</legend>
            <div className="flex flex-wrap gap-2">
              {FILE_TYPE_KEYS.map((t) => {
                const on = s.allowedTypes.includes(t);
                return (
                  <label
                    key={t}
                    className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                      on ? 'border-velvet-500 bg-velvet-50' : 'border-smoke-300 bg-white/70'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-velvet-700"
                      aria-label={FILE_TYPE_LABELS[t]}
                      checked={on}
                      onChange={(ev) =>
                        setSettings({
                          allowedTypes: ev.target.checked
                            ? FILE_TYPE_KEYS.filter((k) => k === t || s.allowedTypes.includes(k))
                            : s.allowedTypes.filter((k) => k !== t),
                        })
                      }
                    />
                    {FILE_TYPE_LABELS[t]}
                  </label>
                );
              })}
            </div>
            {e('allowedTypes') && (
              <p className="mt-1 text-sm font-medium text-red-800">{e('allowedTypes')}</p>
            )}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              label="الحجم الأقصى لكل ملف (ميغابايت)"
              value={s.maxFileSizeMb}
              error={e('maxFileSizeMb')}
              hint={`من 1 إلى ${maxFileSizeFor(s.allowedTypes)}`}
              onChange={(v) => setSettings({ maxFileSizeMb: v })}
            />
            <NumberField
              label="العدد الأقصى للملفات"
              value={s.maxFiles}
              error={e('maxFiles')}
              hint={`من 1 إلى ${L.fileMaxCount}`}
              onChange={(v) => setSettings({ maxFiles: v })}
            />
          </div>
        </div>
      );
      break;
    default:
      body = null;
  }

  if (!body) return null;
  return (
    <div className="mt-4 rounded-xl border border-smoke-200 bg-white/50 p-4">
      <p className="mb-3 text-sm font-bold text-velvet-900">
        إعدادات {QUESTION_TYPE_LABELS[q.type]}
      </p>
      {body}
    </div>
  );
}

function OptionsEditor({
  question: q,
  errors,
  onChange,
}: {
  question: EditorQuestion;
  errors: QuestionErrors;
  onChange: (q: EditorQuestion) => void;
}) {
  const setOptions = (options: EditorQuestion['options']) => onChange({ ...q, options });
  return (
    <fieldset className="mt-4 rounded-xl border border-smoke-200 bg-white/50 p-4">
      <legend className="px-1 text-sm font-bold text-velvet-900">الخيارات</legend>
      <ol className="flex flex-col gap-2">
        {q.options.map((o, i) => {
          const err = errors[`options.${i}.label`] ?? errors[`options.${i}.id`];
          return (
            <li key={o.key} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="w-6 shrink-0 text-center text-sm text-muted" aria-hidden="true">
                  {i + 1}
                </span>
                <TextInput
                  aria-label={`نص الخيار ${i + 1}`}
                  aria-invalid={Boolean(err)}
                  value={o.label}
                  maxLength={L.optionLabelMax}
                  onChange={(e) =>
                    setOptions(
                      q.options.map((x) => (x.key === o.key ? { ...x, label: e.target.value } : x)),
                    )
                  }
                />
                <IconButton
                  icon="up"
                  label={`نقل الخيار ${i + 1} لأعلى`}
                  disabled={i === 0}
                  onClick={() => setOptions(moveItem(q.options, i, -1))}
                />
                <IconButton
                  icon="down"
                  label={`نقل الخيار ${i + 1} لأسفل`}
                  disabled={i === q.options.length - 1}
                  onClick={() => setOptions(moveItem(q.options, i, 1))}
                />
                <IconButton
                  icon="delete"
                  tone="danger"
                  label={`حذف الخيار ${i + 1}`}
                  onClick={() => setOptions(q.options.filter((x) => x.key !== o.key))}
                />
              </div>
              {err && <p className="ms-8 text-sm font-medium text-red-800">{err}</p>}
            </li>
          );
        })}
      </ol>
      {errors.options && <p className="mt-2 text-sm font-medium text-red-800">{errors.options}</p>}
      <button
        type="button"
        disabled={q.options.length >= L.maxOptions}
        onClick={() =>
          setOptions([...q.options, { key: newKey(), label: `الخيار ${q.options.length + 1}` }])
        }
        className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-velvet-700 hover:bg-velvet-50 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span aria-hidden="true">+</span> إضافة خيار
      </button>
      <p className="mt-1 text-xs text-muted">
        من {L.minOptions} إلى {L.maxOptions} خيارًا، دون تكرار.
      </p>
    </fieldset>
  );
}
