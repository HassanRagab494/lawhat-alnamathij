'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FormBasicsFields } from '@/components/form-fields';
import { FormRenderer } from '@/components/form-renderer';
import { PublishPanel } from '@/components/publish-panel';
import { RequirePermission } from '@/components/guards';
import { QuestionEditor, type QuestionErrors } from '@/components/question-editor';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LinkButton,
  LoadingState,
  PageHeader,
  SelectInput,
} from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import {
  changeQuestionType,
  clearConditionsOn,
  dependentsOf,
  fromServer,
  moveItem,
  newQuestion,
  questionsWithErrors,
  rebaseOnServer,
  snapshot,
  toPayload,
  toRenderQuestions,
  validateDraft,
  type DraftErrors,
  type EditorDraft,
  type EditorQuestion,
  type FormDraft,
} from '@/lib/draft';
import { formatDateTime } from '@/lib/format';
import { setNavigationGuard } from '@/lib/history-guard';
import { can } from '@/lib/permissions';
import {
  QUESTION_LIMITS,
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  isChoiceType,
  type QuestionType,
} from '@/lib/question-limits';
import type { FormItem } from '@/lib/types';
import { useApi } from '@/lib/use-api';

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="text-sm text-ink">{value}</dd>
    </div>
  );
}

/** أخطاء سؤال واحد بمسارات نسبية. */
function errorsForQuestion(errors: DraftErrors, index: number): QuestionErrors {
  const prefix = `questions.${index}.`;
  return Object.fromEntries(
    Object.entries(errors)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => [k.slice(prefix.length), v]),
  );
}

/**
 * تحذير المغادرة مع تغييرات غير محفوظة:
 * - إغلاق التبويب أو تحديثه أو مغادرة الموقع: beforeunload.
 * - الروابط الداخلية: اعتراض النقر قبل أن يتعامل معه Next.
 * - زرا الرجوع والتقدم داخل التطبيق: حارس السجل (lib/history-guard.ts) يلغي التنقل دون إضافة مدخلات.
 */
const LEAVE_MESSAGE = 'لديك تغييرات غير محفوظة في النموذج. هل تريد المغادرة دون حفظها؟';

function useLeaveGuard(active: boolean) {
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(
    () => setNavigationGuard(() => !activeRef.current || window.confirm(LEAVE_MESSAGE)),
    [],
  );

  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = LEAVE_MESSAGE;
    };
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement | null)?.closest(
        'a[href]',
      ) as HTMLAnchorElement | null;
      if (!anchor || anchor.target === '_blank' || anchor.href.startsWith('javascript:')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname)
        return;
      if (!window.confirm(LEAVE_MESSAGE)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [active]);
}

type Tab = 'editor' | 'preview';

function FormDetails() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const { me, refresh } = useAuth();
  const {
    data: loaded,
    error,
    errorText,
    loading,
    reload,
  } = useApi<FormDraft>(`/forms/${id}/draft`);

  /** آخر نسخة معروفة من الخادم (أساس revision ومقارنة التغييرات). */
  const [saved, setSaved] = useState<FormDraft | null>(null);
  const [editor, setEditor] = useState<EditorDraft | null>(null);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [tab, setTab] = useState<Tab>('editor');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(
    params.get('created') ? 'تم إنشاء النموذج. أضف الأسئلة ثم احفظ التغييرات.' : null,
  );
  const [conflict, setConflict] = useState<FormDraft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [pendingType, setPendingType] = useState<{ index: number; type: QuestionType } | null>(
    null,
  );
  const [discardOpen, setDiscardOpen] = useState(false);
  const [addType, setAddType] = useState<QuestionType>('SHORT_TEXT');
  const [archiveDialog, setArchiveDialog] = useState<'archive' | 'restore' | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);

  // تحميل أول نسخة فقط في المحرر؛ التحديثات اللاحقة تمر عبر الحفظ أو معالجة التعارض.
  useEffect(() => {
    if (loaded && !saved) {
      setSaved(loaded);
      setEditor(fromServer(loaded));
    }
  }, [loaded, saved]);

  const savedSnapshot = useMemo(() => (saved ? snapshot(fromServer(saved)) : ''), [saved]);
  const dirty = Boolean(editor && saved && snapshot(editor) !== savedSnapshot);
  useLeaveGuard(dirty);

  const updateEditor = useCallback((fn: (d: EditorDraft) => EditorDraft) => {
    setEditor((d) => (d ? fn(d) : d));
    setSuccess(null);
  }, []);

  if (loading && !saved) return <LoadingState />;
  if (error?.status === 404) {
    return (
      <Card>
        <EmptyState
          title="النموذج غير موجود"
          description="ربما يكون الرابط غير صحيح."
          action={
            <LinkButton href="/forms" variant="secondary">
              العودة إلى النماذج
            </LinkButton>
          }
        />
      </Card>
    );
  }
  if (!saved || !editor) {
    return <ErrorState message={errorText ?? 'تعذر تحميل النموذج.'} onRetry={reload} />;
  }

  const form = saved;
  const canEdit = can(me, 'FORMS_EDIT') && !form.isArchived;
  const canArchive = can(me, 'FORMS_ARCHIVE');
  const errorQuestions = questionsWithErrors(errors);

  function setQuestion(index: number, q: EditorQuestion) {
    updateEditor((d) => ({ ...d, questions: d.questions.map((x, i) => (i === index ? q : x)) }));
  }

  function requestTypeChange(index: number, type: QuestionType) {
    const q = editor!.questions[index]!;
    const { question, losesData } = changeQuestionType(q, type);
    // تحويل سؤال تعتمد عليه شروط إلى نوع غير اختياري يلغي تلك الشروط، فيلزم التأكيد.
    const breaksConditions = !isChoiceType(type) && dependentsOf(editor!, q.key).length > 0;
    if (losesData || breaksConditions) setPendingType({ index, type });
    else setQuestion(index, question);
  }

  /** وصف أثر حذف سؤال أو تغيير نوعه على الأسئلة المشروطة به. */
  function dependentsNote(key: string | undefined): string {
    const deps = key ? dependentsOf(editor!, key) : [];
    if (!deps.length) return '';
    const names = deps.map((d) => `«${d.title.trim() || 'سؤال بلا عنوان'}»`).join('، ');
    return ` تعتمد عليه شروط ظهور ${deps.length === 1 ? 'سؤال' : `${deps.length} أسئلة`} (${names})؛ ستُزال هذه الشروط فتصبح ظاهرة دائمًا.`;
  }

  function addQuestion() {
    updateEditor((d) => ({ ...d, questions: [...d.questions, newQuestion(addType)] }));
  }

  async function onSave() {
    if (!editor || !saved) return;
    const local = validateDraft(editor);
    setErrors(local);
    setSaveError(null);
    setSuccess(null);
    if (Object.keys(local).length) {
      const qs = questionsWithErrors(local);
      setSaveError(
        qs.length
          ? `لم يُحفظ شيء. أكمل أو صحّح ${qs.length === 1 ? 'السؤال' : 'الأسئلة'} ${qs.map((i) => i + 1).join('، ')}.`
          : 'لم يُحفظ شيء. صحّح الحقول الموضحة.',
      );
      setTab('editor');
      return;
    }
    setSaving(true);
    try {
      const result = await api<FormDraft>(`/forms/${saved.id}/draft`, {
        method: 'PUT',
        body: toPayload(editor, saved.revision),
      });
      setSaved(result);
      setEditor(fromServer(result));
      setConflict(null);
      setErrors({});
      setSuccess(
        result.revision === saved.revision ? 'لا توجد تغييرات جديدة للحفظ.' : 'تم حفظ التغييرات.',
      );
    } catch (e) {
      // تبقى التعديلات المحلية كما هي في كل حالات الفشل.
      if (e instanceof ApiError && e.code === 'REVISION_CONFLICT') {
        setConflict(e.details.current as FormDraft);
      } else {
        if (e instanceof ApiError) {
          if (e.fields.length) setErrors(e.fieldMap());
          if (e.status === 403) void refresh();
        }
        setSaveError(
          e instanceof ApiError && e.code === 'FORM_ARCHIVED'
            ? 'أُرشف هذا النموذج من مستخدم آخر، فلم يُحفظ شيء. تعديلاتك ما زالت هنا؛ استعد النموذج ثم احفظ.'
            : `لم يُحفظ شيء. ${errorMessage(e)}`,
        );
      }
    } finally {
      setSaving(false);
    }
  }

  function resolveConflict(keepMine: boolean) {
    if (!conflict || !editor) return;
    setSaved(conflict);
    setEditor(keepMine ? rebaseOnServer(editor, conflict) : fromServer(conflict));
    setConflict(null);
    setErrors({});
    setSuccess(
      keepMine
        ? 'أصبحت تعديلاتك مبنية على النسخة الأحدث. راجعها ثم احفظ التغييرات؛ الحفظ سيستبدل محتوى الخادم بما تراه الآن.'
        : 'حُمّلت النسخة الحالية من الخادم.',
    );
  }

  async function onArchiveToggle() {
    if (!archiveDialog) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      const updated = await api<FormItem>(`/forms/${form.id}/${archiveDialog}`, { method: 'POST' });
      // تحديث بيانات الحالة فقط؛ تبقى أي تعديلات محلية في المحرر.
      setSaved((s) => (s ? { ...s, ...updated, questions: s.questions } : s));
      setSuccess(archiveDialog === 'archive' ? 'تمت أرشفة النموذج.' : 'تمت استعادة النموذج.');
      setArchiveDialog(null);
    } catch (e) {
      setArchiveError(errorMessage(e));
    } finally {
      setArchiving(false);
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'editor', label: canEdit ? 'المحرر' : 'الأسئلة' },
    { key: 'preview', label: 'المعاينة' },
  ];

  return (
    <>
      <PageHeader
        title={form.title}
        back={{ href: form.isArchived ? '/forms?status=archived' : '/forms', label: 'النماذج' }}
        actions={
          canArchive && (
            <div className="flex flex-wrap gap-2">
              {form.isArchived ? (
                <Button variant="secondary" onClick={() => setArchiveDialog('restore')}>
                  استعادة النموذج
                </Button>
              ) : (
                <Button variant="danger" onClick={() => setArchiveDialog('archive')}>
                  أرشفة النموذج
                </Button>
              )}
            </div>
          )
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {success && <Alert tone="success">{success}</Alert>}
          {form.isArchived && (
            <Alert tone="warning" title="هذا النموذج مؤرشف">
              لا يمكن تعديل محتواه حتى تتم استعادته.
            </Alert>
          )}
          {conflict && (
            <ConflictPanel
              conflict={conflict}
              onKeepMine={() => resolveConflict(true)}
              onLoadServer={() => resolveConflict(false)}
            />
          )}
          {saveError && <Alert tone="error">{saveError}</Alert>}

          <div
            role="tablist"
            aria-label="عرض النموذج"
            className="flex gap-1 rounded-xl bg-smoke-200/70 p-1"
          >
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`tab-${t.key}`}
                aria-selected={tab === t.key}
                aria-controls={`panel-${t.key}`}
                onClick={() => setTab(t.key)}
                className={`min-h-10 flex-1 rounded-lg px-4 text-sm font-semibold transition-colors ${
                  tab === t.key
                    ? 'bg-white text-velvet-800 shadow-sm'
                    : 'text-muted hover:text-velvet-800'
                }`}
              >
                {t.label}
                {t.key === 'preview' && dirty && (
                  <span className="ms-1 text-xs">(تشمل غير المحفوظ)</span>
                )}
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
            className="flex flex-col gap-4"
          >
            {tab === 'preview' ? (
              <FormRenderer
                title={editor.title}
                description={editor.description.trim() || null}
                questions={toRenderQuestions(editor)}
              />
            ) : canEdit ? (
              <>
                <Card className="p-5 sm:p-6">
                  <h2 className="mb-4 text-lg font-bold text-velvet-900">البيانات الأساسية</h2>
                  <div className="flex flex-col gap-5">
                    <FormBasicsFields
                      title={editor.title}
                      description={editor.description}
                      errors={errors}
                      onTitle={(v) => updateEditor((d) => ({ ...d, title: v }))}
                      onDescription={(v) => updateEditor((d) => ({ ...d, description: v }))}
                    />
                  </div>
                </Card>

                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-lg font-bold text-velvet-900">
                    الأسئلة{' '}
                    <span className="text-sm font-normal text-muted">
                      ({editor.questions.length})
                    </span>
                  </h2>
                  {errorQuestions.length > 0 && (
                    <Badge tone="warning">
                      أسئلة تحتاج مراجعة: {errorQuestions.map((i) => i + 1).join('، ')}
                    </Badge>
                  )}
                </div>

                {editor.questions.length === 0 && (
                  <Card>
                    <EmptyState
                      title="لا توجد أسئلة بعد"
                      description="اختر نوع السؤال من الأسفل ثم «إضافة سؤال». يمكن حفظ النموذج دون أسئلة لأنه مسودة."
                    />
                  </Card>
                )}

                {editor.questions.map((q, i) => (
                  <QuestionEditor
                    key={q.key}
                    question={q}
                    index={i}
                    total={editor.questions.length}
                    earlier={editor.questions.slice(0, i)}
                    errors={errorsForQuestion(errors, i)}
                    onChange={(next) => setQuestion(i, next)}
                    onTypeChange={(type) => requestTypeChange(i, type)}
                    onMove={(delta) =>
                      updateEditor((d) => ({ ...d, questions: moveItem(d.questions, i, delta) }))
                    }
                    onDelete={() => setPendingDelete(i)}
                  />
                ))}
                {errors.questions && <Alert tone="error">{errors.questions}</Alert>}

                <Card className="p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <label className="flex flex-1 flex-col gap-1.5">
                      <span className="text-sm font-semibold text-ink">نوع السؤال الجديد</span>
                      <SelectInput
                        value={addType}
                        onChange={(e) => setAddType(e.target.value as QuestionType)}
                      >
                        {QUESTION_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {QUESTION_TYPE_LABELS[t]}
                          </option>
                        ))}
                      </SelectInput>
                    </label>
                    <Button
                      variant="secondary"
                      onClick={addQuestion}
                      disabled={editor.questions.length >= QUESTION_LIMITS.maxQuestions}
                    >
                      + إضافة سؤال
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    حتى {QUESTION_LIMITS.maxQuestions} سؤالًا في النموذج.
                  </p>
                </Card>
              </>
            ) : (
              <ReadOnlyQuestions draft={form} />
            )}
          </div>

          {canEdit && (
            <div className="glass sticky bottom-3 z-30 flex flex-wrap items-center justify-between gap-3 rounded-2xl p-3">
              <p className="text-sm font-semibold" role="status" aria-live="polite">
                {conflict ? (
                  <span className="text-amber-900">
                    حُفظت نسخة أحدث من الخادم؛ اختر طريقة المعالجة أعلاه.
                  </span>
                ) : dirty ? (
                  <span className="text-amber-900">● لديك تغييرات غير محفوظة</span>
                ) : (
                  <span className="text-muted">كل التغييرات محفوظة</span>
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                {dirty && !conflict && (
                  <Button variant="ghost" onClick={() => setDiscardOpen(true)}>
                    تراجع عن التغييرات
                  </Button>
                )}
                <Button onClick={onSave} loading={saving} disabled={!dirty || Boolean(conflict)}>
                  حفظ التغييرات
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <PublishPanel
            form={form}
            me={me}
            dirty={dirty}
            onUpdated={(updated, message) => {
              // تحديث بيانات الحالة فقط؛ تبقى أي تعديلات محلية في المحرر.
              setSaved((s) => (s ? { ...s, ...updated, questions: s.questions } : s));
              setSuccess(message);
            }}
            onConflict={(current) => setConflict(current)}
          />
          <Card className="h-fit p-5">
            <h2 className="mb-4 text-base font-bold text-velvet-900">معلومات النموذج</h2>
            <dl className="flex flex-col gap-4">
              <Meta
                label="الحالة"
                value={
                  <span className="flex flex-wrap gap-1.5">
                    {form.publication.latestVersion ? (
                      <Badge tone="success">منشور</Badge>
                    ) : (
                      <Badge tone="velvet">مسودة غير منشورة</Badge>
                    )}
                    {form.isArchived && <Badge tone="muted">مؤرشف</Badge>}
                  </span>
                }
              />
              <Meta label="عدد الأسئلة المحفوظة" value={form.questions.length} />
              <Meta label="رقم مراجعة المسودة" value={form.revision} />
              <Meta label="أنشأه" value={form.createdBy.displayName} />
              <Meta label="تاريخ الإنشاء" value={formatDateTime(form.createdAt)} />
              <Meta label="آخر تعديل" value={formatDateTime(form.updatedAt)} />
              {form.archivedAt && (
                <Meta label="تاريخ الأرشفة" value={formatDateTime(form.archivedAt)} />
              )}
            </dl>
            <p className="mt-4 text-xs text-muted">الأوقات بتوقيت الرياض.</p>
          </Card>
        </div>
      </div>

      {canEdit && (
        <>
          <ConfirmDialog
            open={pendingDelete !== null}
            title="حذف السؤال"
            description={
              pendingDelete !== null &&
              `سيُحذف «${editor.questions[pendingDelete]?.title.trim() || `السؤال ${pendingDelete + 1}`}» مع خياراته وإعداداته.${dependentsNote(editor.questions[pendingDelete]?.key)} يُطبق الحذف عند «حفظ التغييرات».`
            }
            confirmLabel="حذف السؤال"
            tone="danger"
            onConfirm={() => {
              const i = pendingDelete!;
              const key = editor.questions[i]!.key;
              updateEditor((d) => ({
                ...d,
                questions: clearConditionsOn(
                  d.questions.filter((_, idx) => idx !== i),
                  key,
                ),
              }));
              setErrors({});
              setPendingDelete(null);
            }}
            onClose={() => setPendingDelete(null)}
          />
          <ConfirmDialog
            open={pendingType !== null}
            title="تغيير نوع السؤال"
            description={
              pendingType &&
              `سيصبح السؤال ${pendingType.index + 1} «${QUESTION_TYPE_LABELS[pendingType.type]}». سيبقى العنوان والوصف وحالة الإلزام، لكن ستُحذف الخيارات أو الإعدادات التي لا تناسب النوع الجديد.${isChoiceType(pendingType.type) ? '' : dependentsNote(editor.questions[pendingType.index]?.key)}`
            }
            confirmLabel="تغيير النوع"
            tone="danger"
            onConfirm={() => {
              const { index, type } = pendingType!;
              const current = editor.questions[index]!;
              const changed = changeQuestionType(current, type).question;
              updateEditor((d) => {
                const questions = d.questions.map((x, idx) => (idx === index ? changed : x));
                return {
                  ...d,
                  questions: isChoiceType(type)
                    ? questions
                    : clearConditionsOn(questions, current.key),
                };
              });
              setPendingType(null);
            }}
            onClose={() => setPendingType(null)}
          />
          <ConfirmDialog
            open={discardOpen}
            title="التراجع عن التغييرات"
            description="ستُلغى كل التعديلات غير المحفوظة ويعود المحرر إلى آخر نسخة محفوظة."
            confirmLabel="تراجع"
            tone="danger"
            onConfirm={() => {
              setEditor(fromServer(saved));
              setErrors({});
              setSaveError(null);
              setDiscardOpen(false);
            }}
            onClose={() => setDiscardOpen(false)}
          />
        </>
      )}
      {canArchive && (
        <ConfirmDialog
          open={archiveDialog !== null}
          title={archiveDialog === 'archive' ? 'أرشفة النموذج' : 'استعادة النموذج'}
          description={
            archiveDialog === 'archive'
              ? `سيُنقل «${form.title}» إلى الأرشيف ولن يمكن تعديله حتى تستعيده. لا يُحذف أي شيء.${dirty ? ' لديك تغييرات غير محفوظة لن تُحفظ بالأرشفة.' : ''}`
              : `سيعود «${form.title}» إلى قائمة النماذج النشطة.`
          }
          confirmLabel={archiveDialog === 'archive' ? 'أرشفة' : 'استعادة'}
          tone={archiveDialog === 'archive' ? 'danger' : 'primary'}
          loading={archiving}
          error={archiveError}
          onConfirm={onArchiveToggle}
          onClose={() => {
            setArchiveDialog(null);
            setArchiveError(null);
          }}
        />
      )}
    </>
  );
}

function ConflictPanel({
  conflict,
  onKeepMine,
  onLoadServer,
}: {
  conflict: FormDraft;
  onKeepMine: () => void;
  onLoadServer: () => void;
}) {
  return (
    <Alert tone="warning" title="عدّل شخص آخر هذا النموذج بعد أن فتحته">
      <p className="mb-2">
        لم يُحفظ شيء من تعديلاتك، وهي ما زالت في المحرر. النسخة الحالية على الخادم (آخر تعديل{' '}
        {formatDateTime(conflict.updatedAt)}):
      </p>
      <div className="mb-3 rounded-xl bg-white/70 p-3 text-ink">
        <p className="font-semibold">{conflict.title}</p>
        {conflict.questions.length === 0 ? (
          <p className="text-xs text-muted">بلا أسئلة</p>
        ) : (
          <ol className="mt-1 list-inside list-decimal text-xs text-muted">
            {conflict.questions.map((q) => (
              <li key={q.id}>
                {q.title} — {QUESTION_TYPE_LABELS[q.type]}
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onKeepMine} className="min-h-9 py-1">
          الإبقاء على تعديلاتي لمراجعتها
        </Button>
        <Button variant="ghost" onClick={onLoadServer} className="min-h-9 py-1">
          تحميل نسخة الخادم (تُلغى تعديلاتي)
        </Button>
      </div>
    </Alert>
  );
}

function ReadOnlyQuestions({ draft }: { draft: FormDraft }) {
  return (
    <>
      <Card className="p-5 sm:p-6">
        <h2 className="mb-3 text-lg font-bold text-velvet-900">البيانات الأساسية</h2>
        <dl className="flex flex-col gap-4">
          <Meta label="العنوان" value={draft.title} />
          <Meta
            label="الوصف"
            value={
              draft.description ? (
                <span className="whitespace-pre-line">{draft.description}</span>
              ) : (
                '—'
              )
            }
          />
        </dl>
      </Card>
      <Card className="p-5 sm:p-6">
        <h2 className="mb-3 text-lg font-bold text-velvet-900">
          الأسئلة ({draft.questions.length})
        </h2>
        {draft.questions.length === 0 ? (
          <p className="text-sm text-muted">لا توجد أسئلة بعد.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {draft.questions.map((q, i) => (
              <li key={q.id} className="rounded-xl border border-smoke-200 bg-white/70 p-3">
                <p className="font-semibold text-ink">
                  {i + 1}. {q.title}
                  {q.required && <span className="text-red-700"> *</span>}
                </p>
                <p className="mt-1 flex flex-wrap gap-2 text-xs text-muted">
                  <Badge tone="velvet">{QUESTION_TYPE_LABELS[q.type]}</Badge>
                  {q.required ? (
                    <Badge tone="warning">إجباري</Badge>
                  ) : (
                    <Badge tone="muted">اختياري</Badge>
                  )}
                  {q.options.length > 0 && <span>{q.options.length} خيارات</span>}
                </p>
                {q.description && <p className="mt-1 text-xs text-muted">{q.description}</p>}
              </li>
            ))}
          </ol>
        )}
        <p className="mt-4 text-xs text-muted">
          لا تملك صلاحية تعديل هذا النموذج. افتح «المعاينة» لتجربته.
        </p>
      </Card>
    </>
  );
}

export default function FormDetailsPage() {
  return (
    <RequirePermission permission="FORMS_VIEW">
      <Suspense fallback={<LoadingState />}>
        <FormDetails />
      </Suspense>
    </RequirePermission>
  );
}
