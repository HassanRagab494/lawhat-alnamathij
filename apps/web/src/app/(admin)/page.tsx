'use client';

import Link from 'next/link';
import {
  Card,
  EmptyState,
  ErrorState,
  LinkButton,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { formatNumber } from '@/lib/format';
import { can, isAdmin } from '@/lib/permissions';
import type { DashboardSummary } from '@/lib/types';
import { useApi } from '@/lib/use-api';

function Stat({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link
      href={href}
      className="glass group flex flex-col gap-2 rounded-2xl p-5 transition-shadow hover:shadow-lg"
    >
      <span className="text-sm font-semibold text-muted">{label}</span>
      <span className="text-3xl font-bold text-velvet-900">{formatNumber(value)}</span>
      <span className="text-xs font-semibold text-velvet-700 group-hover:underline">
        عرض التفاصيل
      </span>
    </Link>
  );
}

export default function DashboardPage() {
  const { me } = useAuth();
  const { data, errorText, loading, reload } = useApi<DashboardSummary>('/dashboard/summary');

  const actions = (
    <>
      {can(me, 'FORMS_CREATE') && <LinkButton href="/forms/new">إنشاء نموذج</LinkButton>}
      {isAdmin(me) && (
        <LinkButton href="/users/new" variant="secondary">
          إنشاء مشرف
        </LinkButton>
      )}
    </>
  );

  return (
    <>
      <PageHeader
        title={`مرحبًا، ${me?.displayName ?? ''}`}
        description="ملخص سريع حسب صلاحيات حسابك."
        actions={actions}
      />
      {loading && <LoadingState />}
      {errorText && <ErrorState message={errorText} onRetry={reload} />}
      {data && !data.forms && !data.users && (
        <Card>
          <EmptyState
            title="لا توجد أقسام متاحة لحسابك حاليًا"
            description="لم تُمنح لحسابك أي صلاحيات بعد. تواصل مع مدير النظام لمنحك الصلاحيات المناسبة."
          />
        </Card>
      )}
      {data && (data.forms || data.users) && (
        <div className="flex flex-col gap-8">
          {data.forms && (
            <section aria-labelledby="forms-summary" className="flex flex-col gap-3">
              <h2 id="forms-summary" className="text-lg font-bold text-velvet-900">
                النماذج
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Stat label="النماذج النشطة" value={data.forms.active} href="/forms" />
                <Stat
                  label="النماذج المؤرشفة"
                  value={data.forms.archived}
                  href="/forms?status=archived"
                />
              </div>
            </section>
          )}
          {data.users && (
            <section aria-labelledby="users-summary" className="flex flex-col gap-3">
              <h2 id="users-summary" className="text-lg font-bold text-velvet-900">
                المشرفون
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Stat label="إجمالي المشرفين" value={data.users.supervisors} href="/users" />
                <Stat
                  label="المشرفون المفعّلون"
                  value={data.users.activeSupervisors}
                  href="/users"
                />
                <Stat
                  label="المشرفون المعطّلون"
                  value={data.users.inactiveSupervisors}
                  href="/users"
                />
              </div>
            </section>
          )}
        </div>
      )}
    </>
  );
}
