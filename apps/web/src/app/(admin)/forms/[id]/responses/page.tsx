'use client';

import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/guards';
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
  Pagination,
  SelectInput,
  TextInput,
} from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime, formatNumber } from '@/lib/format';
import { can } from '@/lib/permissions';
import {
  EMPTY_FILTERS,
  PAGE_SIZE,
  RESPONSE_STATUSES,
  RESPONSE_STATUS_LABELS,
  RESPONSE_STATUS_TONES,
  downloadResponsesCsv,
  filterErrors,
  filtersFromParams,
  filtersToQuery,
  hasActiveFilters,
  responsesCount,
  type ResponseFilters,
  type ResponseList,
  type ResponseStatus,
} from '@/lib/responses';
import type { FormItem } from '@/lib/types';
import { useApi } from '@/lib/use-api';

function StatusBadge({ status }: { status: ResponseStatus }) {
  return <Badge tone={RESPONSE_STATUS_TONES[status]}>{RESPONSE_STATUS_LABELS[status]}</Badge>;
}

function ResponsesList() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { me } = useAuth();
  const filters = filtersFromParams(params);
  const listQuery = filtersToQuery(filters);
  const [draft, setDraft] = useState<ResponseFilters>(filters);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [deleted] = useState(params.get('deleted') === '1');

  // عند تغيّر الرابط (رجوع/تقدم أو تطبيق) تُزامَن حقول الفلاتر معه.
  const paramsKey = params.toString();
  useEffect(() => setDraft(filtersFromParams(new URLSearchParams(paramsKey))), [paramsKey]);

  const form = useApi<FormItem>(`/forms/${id}`);
  const apiQuery = new URLSearchParams(filtersToQuery(filters));
  apiQuery.set('pageSize', String(PAGE_SIZE));
  const { data, error, errorText, loading, reload } = useApi<ResponseList>(
    `/forms/${id}/responses?${apiQuery}`,
  );
  const errors = filterErrors(draft);
  const latestVersion = form.data?.publication.latestVersion?.versionNumber ?? 0;

  function navigate(next: ResponseFilters) {
    const q = filtersToQuery(next);
    router.replace(q ? `${pathname}?${q}` : pathname);
  }

  function onApply(e: FormEvent) {
    e.preventDefault();
    if (Object.keys(errors).length) return;
    navigate({ ...draft, search: draft.search.trim(), page: 1 });
  }

  async function onExport() {
    setExporting(true);
    setExportMessage(null);
    try {
      const rows = await downloadResponsesCsv(id, filters);
      setExportMessage({
        ok: true,
        text: `تم تنزيل ملف CSV (${responsesCount(rows, formatNumber)}).`,
      });
    } catch (e) {
      setExportMessage({ ok: false, text: errorMessage(e) });
    } finally {
      setExporting(false);
    }
  }

  if (error?.status === 404 || form.error?.status === 404) {
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

  const detailHref = (responseId: string) =>
    `/forms/${id}/responses/${responseId}${listQuery ? `?list=${encodeURIComponent(listQuery)}` : ''}`;

  return (
    <>
      <PageHeader
        title={form.data ? `ردود «${form.data.title}»` : 'الردود'}
        back={{ href: `/forms/${id}`, label: 'النموذج' }}
        actions={
          can(me, 'RESPONSES_EXPORT') && (
            <Button
              variant="secondary"
              onClick={() => void onExport()}
              loading={exporting}
              disabled={!data || data.meta.total === 0}
            >
              تصدير CSV
            </Button>
          )
        }
      />

      {deleted && (
        <div className="mb-4">
          <Alert tone="success">تم حذف الرد من اللوحة.</Alert>
        </div>
      )}

      {exportMessage && (
        <div className="mb-4">
          <Alert tone={exportMessage.ok ? 'success' : 'error'}>{exportMessage.text}</Alert>
        </div>
      )}

      <Card className="p-4 sm:p-5">
        <form
          role="search"
          aria-label="فلترة الردود"
          onSubmit={onApply}
          noValidate
          className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end"
        >
          <label className="flex flex-col gap-1.5 lg:col-span-2">
            <span className="text-sm font-semibold text-ink">الرقم المرجعي</span>
            <TextInput
              type="search"
              dir="ltr"
              className="text-start font-mono"
              placeholder="K7Q2-M9XD-4TPB"
              maxLength={20}
              value={draft.search}
              aria-invalid={Boolean(errors.search)}
              aria-describedby={errors.search ? 'search-error' : undefined}
              onChange={(e) => setDraft({ ...draft, search: e.target.value })}
            />
            {errors.search && (
              <span id="search-error" className="text-xs text-red-800">
                {errors.search}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink">الحالة</span>
            <SelectInput
              value={draft.status}
              onChange={(e) =>
                setDraft({ ...draft, status: e.target.value as ResponseStatus | '' })
              }
            >
              <option value="">كل الحالات</option>
              {RESPONSE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {RESPONSE_STATUS_LABELS[s]}
                </option>
              ))}
            </SelectInput>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink">من تاريخ</span>
            <TextInput
              type="date"
              value={draft.from}
              max={draft.to || undefined}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink">إلى تاريخ</span>
            <TextInput
              type="date"
              value={draft.to}
              min={draft.from || undefined}
              aria-invalid={Boolean(errors.to)}
              aria-describedby={errors.to ? 'to-error' : undefined}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
            {errors.to && (
              <span id="to-error" className="text-xs text-red-800">
                {errors.to}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink">الإصدار</span>
            <SelectInput
              value={draft.version}
              onChange={(e) => setDraft({ ...draft, version: e.target.value })}
            >
              <option value="">كل الإصدارات</option>
              {Array.from(
                { length: Math.max(latestVersion, Number(draft.version) || 0) },
                (_, i) => (
                  <option key={i + 1} value={String(i + 1)}>
                    الإصدار {i + 1}
                  </option>
                ),
              )}
            </SelectInput>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink">الترتيب</span>
            <SelectInput
              value={draft.sort}
              onChange={(e) => setDraft({ ...draft, sort: e.target.value as 'newest' | 'oldest' })}
            >
              <option value="newest">الأحدث أولًا</option>
              <option value="oldest">الأقدم أولًا</option>
            </SelectInput>
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-5 lg:justify-start">
            <Button type="submit" disabled={Object.keys(errors).length > 0}>
              تطبيق
            </Button>
            {(hasActiveFilters(filters) || filters.sort !== 'newest') && (
              <Button variant="ghost" onClick={() => navigate(EMPTY_FILTERS)}>
                مسح الفلاتر
              </Button>
            )}
          </div>
        </form>
        <p className="mb-4 text-xs text-muted">التواريخ والأوقات بتوقيت الرياض.</p>

        {loading && <LoadingState label="جارٍ تحميل الردود…" />}
        {errorText && !loading && <ErrorState message={errorText} onRetry={reload} />}

        {data &&
          !loading &&
          data.items.length === 0 &&
          (hasActiveFilters(filters) ? (
            <EmptyState
              title="لا توجد ردود مطابقة"
              description="غيّر الفلاتر أو امسحها لعرض كل الردود."
              action={
                <Button variant="secondary" onClick={() => navigate(EMPTY_FILTERS)}>
                  مسح الفلاتر
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="لا توجد ردود بعد"
              description={
                form.data?.publication.acceptingResponses
                  ? 'ستظهر هنا الردود المرسلة من الرابط العام.'
                  : 'استقبال الردود مغلق حاليًا. ستظهر هنا الردود عند فتحه وإرسالها.'
              }
            />
          ))}

        {data && !loading && data.items.length > 0 && (
          <>
            <p className="mb-3 text-sm text-muted" role="status">
              {responsesCount(data.meta.total, formatNumber)}
            </p>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-start text-sm">
                <caption className="sr-only">ردود النموذج</caption>
                <thead>
                  <tr className="border-b border-smoke-200 text-muted">
                    <th scope="col" className="px-3 py-3 text-start font-semibold">
                      الرقم المرجعي
                    </th>
                    <th scope="col" className="px-3 py-3 text-start font-semibold">
                      تاريخ الإرسال
                    </th>
                    <th scope="col" className="px-3 py-3 text-start font-semibold">
                      الإصدار
                    </th>
                    <th scope="col" className="px-3 py-3 text-start font-semibold">
                      الحالة
                    </th>
                    <th scope="col" className="px-3 py-3">
                      <span className="sr-only">التفاصيل</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-smoke-200/70 last:border-0 hover:bg-white/60"
                    >
                      <td className="px-3 py-3">
                        <span dir="ltr" className="font-mono font-semibold text-velvet-900">
                          {r.referenceCode}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-muted">{formatDateTime(r.submittedAt)}</td>
                      <td className="px-3 py-3 text-muted">{r.versionNumber}</td>
                      <td className="px-3 py-3">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-3 py-3 text-end">
                        <Link
                          href={detailHref(r.id)}
                          className="font-semibold text-velvet-700 hover:underline"
                          aria-label={`تفاصيل الرد ${r.referenceCode}`}
                        >
                          التفاصيل
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="flex flex-col gap-3 md:hidden">
              {data.items.map((r) => (
                <li key={r.id}>
                  <Link
                    href={detailHref(r.id)}
                    aria-label={`تفاصيل الرد ${r.referenceCode}`}
                    className="flex flex-col gap-2 rounded-xl border border-smoke-200 bg-white/70 p-4"
                  >
                    <span className="flex items-start justify-between gap-3">
                      <span dir="ltr" className="font-mono font-semibold text-velvet-900">
                        {r.referenceCode}
                      </span>
                      <StatusBadge status={r.status} />
                    </span>
                    <span className="text-xs text-muted">
                      {formatDateTime(r.submittedAt)} · الإصدار {r.versionNumber}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>

            <Pagination
              page={data.meta.page}
              totalPages={data.meta.totalPages}
              total={data.meta.total}
              onChange={(p) => navigate({ ...filters, page: p })}
            />
          </>
        )}
      </Card>
    </>
  );
}

export default function ResponsesPage() {
  return (
    <RequirePermission permission="RESPONSES_VIEW">
      <Suspense fallback={<LoadingState />}>
        <ResponsesList />
      </Suspense>
    </RequirePermission>
  );
}
