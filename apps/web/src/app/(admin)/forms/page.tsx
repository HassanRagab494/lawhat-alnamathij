'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/guards';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LinkButton,
  LoadingState,
  PageHeader,
  Pagination,
  TextInput,
} from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { can } from '@/lib/permissions';
import type { FormItem, Paged } from '@/lib/types';
import { useApi } from '@/lib/use-api';

type Status = 'active' | 'archived';

function FormsList() {
  const { me } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const status: Status = params.get('status') === 'archived' ? 'archived' : 'active';
  const search = params.get('search') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [searchInput, setSearchInput] = useState(search);

  useEffect(() => setSearchInput(search), [search]);

  const query = new URLSearchParams({ status, page: String(page), pageSize: '20' });
  if (search) query.set('search', search);
  const { data, errorText, loading, reload } = useApi<Paged<FormItem>>(`/forms?${query}`);

  function navigate(next: { status?: Status; search?: string; page?: number }) {
    const p = new URLSearchParams();
    const s = next.status ?? status;
    const q = next.search ?? search;
    const pg = next.page ?? 1;
    if (s !== 'active') p.set('status', s);
    if (q) p.set('search', q);
    if (pg > 1) p.set('page', String(pg));
    router.replace(p.size ? `${pathname}?${p}` : pathname);
  }

  function onSearch(event: FormEvent) {
    event.preventDefault();
    navigate({ search: searchInput.trim() });
  }

  const tabs: { key: Status; label: string }[] = [
    { key: 'active', label: 'النماذج النشطة' },
    { key: 'archived', label: 'الأرشيف' },
  ];

  return (
    <>
      <PageHeader
        title="النماذج"
        description="كل نموذج جديد يُحفظ كمسودة غير منشورة."
        actions={can(me, 'FORMS_CREATE') && <LinkButton href="/forms/new">إنشاء نموذج</LinkButton>}
      />

      <Card className="p-4 sm:p-5">
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div
            role="group"
            aria-label="تصفية حسب الحالة"
            className="flex gap-1 rounded-xl bg-smoke-200/70 p-1"
          >
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                aria-pressed={status === tab.key}
                onClick={() => navigate({ status: tab.key })}
                className={`min-h-10 flex-1 rounded-lg px-4 text-sm font-semibold transition-colors ${
                  status === tab.key
                    ? 'bg-white text-velvet-800 shadow-sm'
                    : 'text-muted hover:text-velvet-800'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <form role="search" onSubmit={onSearch} className="flex gap-2">
            <label htmlFor="forms-search" className="sr-only">
              البحث بعنوان النموذج
            </label>
            <TextInput
              id="forms-search"
              type="search"
              placeholder="ابحث بعنوان النموذج"
              value={searchInput}
              maxLength={100}
              onChange={(e) => setSearchInput(e.target.value)}
              className="lg:w-72"
            />
            <Button type="submit" variant="secondary">
              بحث
            </Button>
          </form>
        </div>

        {loading && <LoadingState />}
        {errorText && <ErrorState message={errorText} onRetry={reload} />}

        {data &&
          !loading &&
          data.items.length === 0 &&
          (search ? (
            <EmptyState
              title="لا توجد نتائج مطابقة"
              description={`لا توجد نماذج يحتوي عنوانها على «${search}».`}
              action={
                <Button variant="secondary" onClick={() => navigate({ search: '' })}>
                  مسح البحث
                </Button>
              }
            />
          ) : status === 'archived' ? (
            <EmptyState
              title="لا توجد نماذج مؤرشفة"
              description="النماذج التي تؤرشفها ستظهر هنا."
            />
          ) : (
            <EmptyState
              title="لا توجد نماذج بعد"
              description={
                can(me, 'FORMS_CREATE') ? 'ابدأ بإنشاء أول نموذج.' : 'لم يُنشأ أي نموذج حتى الآن.'
              }
              action={
                can(me, 'FORMS_CREATE') && <LinkButton href="/forms/new">إنشاء نموذج</LinkButton>
              }
            />
          ))}

        {data && !loading && data.items.length > 0 && (
          <>
            {/* جدول للشاشات المتوسطة والكبيرة */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-start text-sm">
                <caption className="sr-only">قائمة النماذج</caption>
                <thead>
                  <tr className="border-b border-smoke-200 text-muted">
                    <th scope="col" className="px-3 py-3 text-start font-semibold">
                      العنوان
                    </th>
                    <th scope="col" className="px-3 py-3 text-start font-semibold">
                      الحالة
                    </th>
                    <th scope="col" className="px-3 py-3 text-start font-semibold">
                      أنشأه
                    </th>
                    <th scope="col" className="px-3 py-3 text-start font-semibold">
                      آخر تعديل
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((form) => (
                    <tr
                      key={form.id}
                      className="border-b border-smoke-200/70 last:border-0 hover:bg-white/60"
                    >
                      <td className="px-3 py-3">
                        <Link
                          href={`/forms/${form.id}`}
                          className="font-semibold text-velvet-800 hover:underline"
                        >
                          {form.title}
                        </Link>
                      </td>
                      <td className="px-3 py-3">
                        {form.isArchived ? (
                          <Badge tone="muted">مؤرشف</Badge>
                        ) : (
                          <Badge tone="velvet">مسودة</Badge>
                        )}
                      </td>
                      <td className="px-3 py-3 text-muted">{form.createdBy.displayName}</td>
                      <td className="px-3 py-3 text-muted">{formatDateTime(form.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* بطاقات للشاشات الصغيرة */}
            <ul className="flex flex-col gap-3 md:hidden">
              {data.items.map((form) => (
                <li key={form.id}>
                  <Link
                    href={`/forms/${form.id}`}
                    className="flex flex-col gap-2 rounded-xl border border-smoke-200 bg-white/70 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="font-semibold text-velvet-800">{form.title}</span>
                      {form.isArchived ? (
                        <Badge tone="muted">مؤرشف</Badge>
                      ) : (
                        <Badge tone="velvet">مسودة</Badge>
                      )}
                    </div>
                    <span className="text-xs text-muted">
                      {form.createdBy.displayName} · آخر تعديل {formatDateTime(form.updatedAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>

            <Pagination
              page={data.meta.page}
              totalPages={data.meta.totalPages}
              total={data.meta.total}
              onChange={(p) => navigate({ page: p })}
            />
          </>
        )}
      </Card>
    </>
  );
}

export default function FormsPage() {
  return (
    <RequirePermission permission="FORMS_VIEW">
      <Suspense fallback={<LoadingState />}>
        <FormsList />
      </Suspense>
    </RequirePermission>
  );
}
