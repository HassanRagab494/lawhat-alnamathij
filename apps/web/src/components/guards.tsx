'use client';

import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';
import { can, isAdmin } from '@/lib/permissions';
import type { Permission } from '@/lib/types';
import { Card, LinkButton } from './ui';

export function Forbidden() {
  return (
    <Card className="mx-auto max-w-lg p-8 text-center">
      <h1 className="mb-2 text-xl font-bold text-velvet-900">لا تملك صلاحية الوصول</h1>
      <p className="mb-6 text-sm text-muted">
        هذه الصفحة غير متاحة لحسابك. إذا كنت تحتاج إليها فتواصل مع مدير النظام.
      </p>
      <LinkButton href="/" variant="secondary">
        العودة إلى الرئيسية
      </LinkButton>
    </Card>
  );
}

/** يخفي محتوى الصفحة عمّن لا يملك الصلاحية. الحماية الفعلية في الـ Backend. */
export function RequirePermission({
  permission,
  adminOnly,
  children,
}: {
  permission?: Permission;
  adminOnly?: boolean;
  children: ReactNode;
}) {
  const { me } = useAuth();
  if (adminOnly && !isAdmin(me)) return <Forbidden />;
  if (permission && !can(me, permission)) return <Forbidden />;
  return <>{children}</>;
}
