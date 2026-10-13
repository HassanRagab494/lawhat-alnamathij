import type { Me, Permission } from './types';

export const PERMISSION_OPTIONS: { key: Permission; label: string; hint: string }[] = [
  { key: 'FORMS_VIEW', label: 'عرض النماذج', hint: 'الاطلاع على قائمة النماذج وتفاصيلها.' },
  { key: 'FORMS_CREATE', label: 'إنشاء النماذج', hint: 'إنشاء نماذج جديدة كمسودات.' },
  { key: 'FORMS_EDIT', label: 'تعديل النماذج', hint: 'تعديل عنوان النموذج ووصفه.' },
  {
    key: 'FORMS_ARCHIVE',
    label: 'أرشفة النماذج واستعادتها',
    hint: 'نقل النماذج إلى الأرشيف وإعادتها.',
  },
];

export const PERMISSION_LABELS = Object.fromEntries(
  PERMISSION_OPTIONS.map((p) => [p.key, p.label]),
) as Record<Permission, string>;

/** الصلاحيات التي تتطلب صلاحية العرض (مطابقة لقواعد الـ Backend). */
const REQUIRES_VIEW: Permission[] = ['FORMS_CREATE', 'FORMS_EDIT', 'FORMS_ARCHIVE'];

/** يبدّل صلاحية مع الحفاظ على الاعتماديات: تفعيل صلاحية تابعة يفعّل العرض، وإلغاء العرض يلغي التوابع. */
export function togglePermission(
  current: Permission[],
  key: Permission,
  checked: boolean,
): Permission[] {
  const set = new Set(current);
  if (checked) {
    set.add(key);
    if (REQUIRES_VIEW.includes(key)) set.add('FORMS_VIEW');
  } else {
    set.delete(key);
    if (key === 'FORMS_VIEW') REQUIRES_VIEW.forEach((p) => set.delete(p));
  }
  return PERMISSION_OPTIONS.map((p) => p.key).filter((p) => set.has(p));
}

export function can(me: Me | null, permission: Permission): boolean {
  if (!me) return false;
  return me.role === 'ADMIN' || me.permissions.includes(permission);
}

export function isAdmin(me: Me | null): boolean {
  return me?.role === 'ADMIN';
}

export const ROLE_LABELS = { ADMIN: 'مدير النظام', SUPERVISOR: 'مشرف' } as const;
