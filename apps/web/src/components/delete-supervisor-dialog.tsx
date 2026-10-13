'use client';

import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import type { UserItem } from '@/lib/types';
import { ConfirmDialog } from './ui';

/** نافذة تأكيد حذف مشرف (حذف ناعم في الـ API). */
export function DeleteSupervisorDialog({
  user,
  onClose,
  onDeleted,
}: {
  user: Pick<UserItem, 'id' | 'displayName' | 'username'> | null;
  onClose: () => void;
  onDeleted: (user: Pick<UserItem, 'id' | 'displayName'>) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      await api(`/users/${user.id}`, { method: 'DELETE' });
      onDeleted(user);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <ConfirmDialog
      open={user !== null}
      title="حذف المشرف"
      description={
        user && (
          <>
            <p>
              سيُحذف حساب «{user.displayName}» ولن يظهر في قائمة المستخدمين، ولن يتمكن من الدخول،
              وستُنهى جميع جلساته فورًا.
            </p>
            <p className="mt-2">
              تبقى النماذج التي أنشأها وسجل العمليات كما هي. اسم المستخدم «
              <span dir="ltr">{user.username}</span>» يبقى محجوزًا ولا يمكن استخدامه لحساب جديد.
            </p>
          </>
        )
      }
      confirmLabel="حذف المشرف"
      tone="danger"
      loading={loading}
      error={error}
      onConfirm={onConfirm}
      onClose={() => {
        setError(null);
        onClose();
      }}
    />
  );
}
