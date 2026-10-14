'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Forbidden, RequirePermission } from '@/components/guards';
import {
  Alert,
  Button,
  Card,
  ErrorState,
  Field,
  LoadingState,
  PageHeader,
  SelectInput,
  TextArea,
  TextInput,
} from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import {
  formatValueTable,
  parseValueTable,
  type FieldSource,
  type FlowmaxFieldDef,
  type MappingView,
} from '@/lib/flowmax';
import { useApi } from '@/lib/use-api';

type Mode = 'none' | 'question' | 'constant';

interface Row {
  mode: Mode;
  questionId: string;
  constant: string;
  values: string;
}

const OPS: Record<string, string> = { OFFER: 'العرض', REQUEST: 'الطلب' };

function toRows(view: MappingView): Record<string, Row> {
  return Object.fromEntries(
    view.fields.map((f) => {
      const s: FieldSource | undefined = view.config.fields[f.key];
      return [
        f.key,
        {
          mode: s?.questionId ? 'question' : s?.constant ? 'constant' : 'none',
          questionId: s?.questionId ?? '',
          constant: s?.constant ?? '',
          values: formatValueTable(s?.values),
        },
      ];
    }),
  );
}

function toConfig(fields: FlowmaxFieldDef[], rows: Record<string, Row>) {
  const out: Record<string, FieldSource> = {};
  for (const f of fields) {
    const r = rows[f.key];
    if (!r || r.mode === 'none') continue;
    const values = f.type === 'enum' ? parseValueTable(r.values) : undefined;
    if (r.mode === 'question' && r.questionId) out[f.key] = { questionId: r.questionId, values };
    if (r.mode === 'constant' && r.constant.trim()) out[f.key] = { constant: r.constant.trim() };
  }
  return { fields: out };
}

function FieldRow({
  field,
  row,
  questions,
  error,
  onChange,
}: {
  field: FlowmaxFieldDef;
  row: Row;
  questions: MappingView['questions'];
  error?: string;
  onChange: (row: Row) => void;
}) {
  const fileField = field.type === 'files';
  const choices = questions.filter((q) =>
    fileField ? q.type === 'FILE_UPLOAD' : q.type !== 'FILE_UPLOAD',
  );
  const required = field.requiredFor.map((o) => OPS[o]).join(' و');
  const canConstant = field.type !== 'files' && field.type !== 'consent';
  return (
    <li className="glass flex flex-col gap-3 rounded-2xl p-4">
      <div>
        <h3 className="text-sm font-bold text-ink">
          {field.label}
          {field.private && (
            <span className="ms-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
              خاص
            </span>
          )}
        </h3>
        <p className="mt-1 text-xs text-muted">
          {required ? `مطلوب لإنشاء ${required}.` : 'اختياري.'} {field.hint}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <Field label="المصدر">
          {({ id }) => (
            <SelectInput
              id={id}
              value={row.mode}
              onChange={(e) => onChange({ ...row, mode: e.target.value as Mode })}
            >
              <option value="none">غير مربوط</option>
              <option value="question">سؤال</option>
              {canConstant && <option value="constant">قيمة ثابتة</option>}
            </SelectInput>
          )}
        </Field>
        {row.mode === 'question' && (
          <Field label="السؤال" error={error}>
            {({ id, describedBy, invalid }) => (
              <SelectInput
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={row.questionId}
                onChange={(e) => onChange({ ...row, questionId: e.target.value })}
              >
                <option value="">اختر سؤالًا</option>
                {choices.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.title}
                  </option>
                ))}
              </SelectInput>
            )}
          </Field>
        )}
        {row.mode === 'constant' && (
          <Field
            label="القيمة"
            error={error}
            hint={
              field.values ? `القيم المقبولة: ${Object.keys(field.values).join('، ')}` : undefined
            }
          >
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                dir="auto"
                value={row.constant}
                onChange={(e) => onChange({ ...row, constant: e.target.value })}
              />
            )}
          </Field>
        )}
      </div>
      {row.mode === 'question' && field.type === 'enum' && field.values && (
        <Field
          label="تحويل الإجابات (اختياري)"
          hint={`سطر لكل تحويل بصيغة «نص الإجابة = قيمة Flowmax». القيم: ${Object.entries(
            field.values,
          )
            .map(([k, v]) => `${k} (${v})`)
            .join('، ')}. الأسماء العربية الشائعة تُطابق تلقائيًا.`}
        >
          {({ id, describedBy }) => (
            <TextArea
              id={id}
              aria-describedby={describedBy}
              dir="auto"
              className="min-h-20"
              value={row.values}
              onChange={(e) => onChange({ ...row, values: e.target.value })}
            />
          )}
        </Field>
      )}
    </li>
  );
}

function MappingEditor() {
  const { id } = useParams<{ id: string }>();
  const { data, error, errorText, loading, reload, setData } = useApi<MappingView>(
    `/forms/${id}/flowmax-mapping`,
  );
  const [rows, setRows] = useState<Record<string, Row> | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!data) return;
    setRows(toRows(data));
    setEnabled(data.enabled);
  }, [data]);

  if (loading && !data) return <LoadingState label="جارٍ تحميل إعداد الربط…" />;
  if (error?.status === 403) return <Forbidden />;
  if (!data || !rows) {
    return <ErrorState message={errorText ?? 'تعذر تحميل إعداد الربط.'} onRetry={reload} />;
  }
  const view = data;

  async function save() {
    setSaving(true);
    setMessage(null);
    setFieldErrors({});
    try {
      const result = await api<MappingView>(`/forms/${id}/flowmax-mapping`, {
        method: 'PUT',
        body: { enabled, config: toConfig(view.fields, rows!) },
      });
      setData(result);
      setMessage({ ok: true, text: 'حُفظ إعداد الربط.' });
    } catch (e) {
      if (e instanceof ApiError && e.fields.length) {
        setFieldErrors(
          Object.fromEntries(
            e.fields.map((f) => [
              f.field.replace(/^config\.fields\./, '').split('.')[0]!,
              f.message,
            ]),
          ),
        );
      }
      setMessage({ ok: false, text: `لم يُحفظ. ${errorMessage(e)}` });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="ربط Flowmax"
        description="اختر لكل حقل في Flowmax السؤال الذي يغذيه أو قيمة ثابتة. لا يُرسل أي رد إلا بعد اعتماده من صفحة الرد."
        back={{ href: `/forms/${id}`, label: 'النموذج' }}
      />
      {!view.integrationEnabled && (
        <div className="mb-4">
          <Alert tone="warning">
            ربط Flowmax غير مفعّل على هذا الخادم حاليًا؛ يمكنك حفظ الإعداد، ولن يظهر زر الاعتماد حتى
            يُفعَّل.
          </Alert>
        </div>
      )}
      {view.questions.length === 0 && (
        <div className="mb-4">
          <Alert tone="info">انشر النموذج أولًا؛ الربط يعتمد على أسئلة آخر إصدار منشور.</Alert>
        </div>
      )}
      <Card className="mb-4 p-4">
        <label className="flex items-center gap-3 text-sm font-semibold text-ink">
          <input
            type="checkbox"
            className="h-5 w-5 accent-velvet-700"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          تفعيل الاعتماد والإرسال إلى Flowmax لهذا النموذج
        </label>
      </Card>
      <ul className="flex flex-col gap-3">
        {view.fields.map((f) => (
          <FieldRow
            key={f.key}
            field={f}
            row={rows[f.key]!}
            questions={view.questions}
            error={fieldErrors[f.key]}
            onChange={(row) => setRows({ ...rows, [f.key]: row })}
          />
        ))}
      </ul>
      <div className="sticky bottom-0 mt-4 flex flex-col gap-2 bg-gradient-to-t from-white/90 py-3">
        {message && <Alert tone={message.ok ? 'success' : 'error'}>{message.text}</Alert>}
        <Button onClick={() => void save()} loading={saving}>
          حفظ الربط
        </Button>
      </div>
    </>
  );
}

export default function FlowmaxMappingPage() {
  return (
    <RequirePermission permission="FORMS_EDIT">
      <MappingEditor />
    </RequirePermission>
  );
}
