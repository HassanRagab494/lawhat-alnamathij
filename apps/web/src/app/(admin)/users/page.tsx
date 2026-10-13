'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { DeleteSupervisorDialog } from '@/components/delete-supervisor-dialog';
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
  TextInput,
} from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { PERMISSION_LABELS, ROLE_LABELS } from '@/lib/permissions';
import type { Paged, UserItem } from '@/lib/types';
import { useApi } from '@/lib/use-api';

function permissionSummary(user: UserItem): string {
  if (user.role === 'ADMIN') return 'جميع الصلاحيات';
  if (!user.permissions.length) return 'بلا صلاحيات';
  return user.permissions.map((p) => PERMISSION_LABELS[p]).join('، ');
}

function UsersList() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const query = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (search) query.set('search', search);
  const { data, errorText, loading, reload } = useApi<Paged<UserItem>>(`/users?${query}`);
  const [toDelete, setToDelete] = useState<UserItem | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function rowActions(user: UserItem) {
    if (user.role !== 'SUPERVISOR') return <span className="text-xs text-muted">—</span>;
    return (
      <div className="flex flex-wrap gap-2">
        <LinkButton href={`/users/${user.id}`} variant="secondary" className="min-h-9 px-3 py-1">
          تعديل
          <span className="sr-only"> {user.displayName}</span>
        </LinkButton>
        <Button
          variant="danger"
          className="min-h-9 px-3 py-1"
          onClick={() => {
            setSuccess(null);
            setToDelete(user);
          }}
        >
          حذف
          <span className="sr-only"> {user.displayName}</span>
        </Button>
      </div>
    );
  }

  function onSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  return (
    <>
      <PageHeader
        title="المستخدمون"
        description="إدارة حسابات المشرفين وصلاحياتهم. مدير النظام يملك جميع الصلاحيات."
        actions={<LinkButton href="/users/new">إنشاء مشرف</LinkButton>}
      />
      {success && (
        <div className="mb-4">
          <Alert tone="success">{success}</Alert>
        </div>
      )}
      <Card className="p-4 sm:p-5">
        <form role="search" onSubmit={onSearch} className="mb-4 flex gap-2">
          <label htmlFor="users-search" className="sr-only">
            البحث بالاسم أو اسم المستخدم
          </label>
          <TextInput
            id="users-search"
            type="search"
            placeholder="ابحث بالاسم أو اسم المستخدم"
            value={searchInput}
            maxLength={100}
            onChange={(e) => setSearchInput(e.target.value)}
            className="sm:w-80"
          />
          <Button type="submit" variant="secondary">
            بحث
          </Button>
        </form>

        {loading && <LoadingState />}
        {errorText && <ErrorState message={errorText} onRetry={reload} />}
        {data && !loading && data.items.length === 0 && (
          <EmptyState
            title={search ? 'لا توجد نتائج مطابقة' : 'لا يوجد مستخدمون'}
            action={
              search && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('');
                    setSearchInput('');
                  }}
                >
                  مسح البحث
                </Button>
              )
            }
          />
        )}
        {data && !loading && data.items.length > 0 && (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <caption className="sr-only">قائمة المستخدمين</caption>
                <thead>
                  <tr className="border-b border-smoke-200 text-muted">
                    <th scope="col" className="px-3 py-3 text-start font-semibold">
                      الاسم
                    </th>
                    <th scope="col" className="px-3 py-3 text-start font-semibold">
                      النوع
                    </th>
                    <th scope="col" className="px-3 py-3 text-start font-semibold">
                      الحالة
                    </th>
                    <th scope="col" className="px-3 py-3 text-start font-semibold">
                      الصلاحيات
                    </th>
                    <th scope="col" className="px-3 py-3 text-start font-semibold">
                      آخر دخول
                    </th>
                    <th scope="col" className="px-3 py-3 text-start font-semibold">
                      الإجراءات
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((user) => (
                    <tr
                      key={user.id}
                      className="border-b border-smoke-200/70 align-top last:border-0 hover:bg-white/60"
                    >
                      <td className="px-3 py-3">
                        <Link
                          href={`/users/${user.id}`}
                          className="font-semibold text-velvet-800 hover:underline"
                        >
                          {user.displayName}
                        </Link>
                        <div dir="ltr" className="text-end text-xs text-muted">
                          {user.username}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <Badge tone={user.role === 'ADMIN' ? 'velvet' : 'neutral'}>
                          {ROLE_LABELS[user.role]}
                        </Badge>
                      </td>
                      <td className="px-3 py-3">
                        {user.isActive ? (
                          <Badge tone="success">مفعّل</Badge>
                        ) : (
                          <Badge tone="warning">معطّل</Badge>
                        )}
                      </td>
                      <td className="max-w-xs px-3 py-3 text-muted">{permissionSummary(user)}</td>
                      <td className="px-3 py-3 text-muted">{formatDateTime(user.lastLoginAt)}</td>
                      <td className="px-3 py-3">{rowActions(user)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="flex flex-col gap-3 md:hidden">
              {data.items.map((user) => (
                <li
                  key={user.id}
                  className="flex flex-col gap-2 rounded-xl border border-smoke-200 bg-white/70 p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      href={`/users/${user.id}`}
                      className="font-semibold text-velvet-800 hover:underline"
                    >
                      {user.displayName}
                    </Link>
                    {user.isActive ? (
                      <Badge tone="success">مفعّل</Badge>
                    ) : (
                      <Badge tone="warning">معطّل</Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted">
                    {ROLE_LABELS[user.role]} · <span dir="ltr">{user.username}</span>
                  </span>
                  <span className="text-xs text-muted">{permissionSummary(user)}</span>
                  {user.role === 'SUPERVISOR' && rowActions(user)}
                </li>
              ))}
            </ul>
            <Pagination
              page={data.meta.page}
              totalPages={data.meta.totalPages}
              total={data.meta.total}
              onChange={setPage}
            />
          </>
        )}
      </Card>
      <DeleteSupervisorDialog
        user={toDelete}
        onClose={() => setToDelete(null)}
        onDeleted={(user) => {
          setToDelete(null);
          setSuccess(`تم حذف المشرف «${user.displayName}» وإنهاء جلساته.`);
          reload();
        }}
      />
    </>
  );
}

export default function UsersPage() {
  return (
    <RequirePermission adminOnly>
      <UsersList />
    </RequirePermission>
  );
}
