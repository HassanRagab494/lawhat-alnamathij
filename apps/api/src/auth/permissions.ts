import { Permission, UserRole } from '@prisma/client';

/**
 * فهرس الصلاحيات المركزي. لإضافة صلاحية مستقبلية (مثل مراجعة الردود أو التصدير):
 * 1) أضف القيمة إلى enum Permission في schema.prisma وأنشئ migration،
 * 2) أضف وصفها هنا وفي واجهة المستخدم، 3) اربطها بالمسارات عبر @RequirePermissions.
 */
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

export const PERMISSION_LABELS: Record<Permission, string> = {
  FORMS_VIEW: 'عرض النماذج',
  FORMS_CREATE: 'إنشاء النماذج',
  FORMS_EDIT: 'تعديل النماذج',
  FORMS_ARCHIVE: 'أرشفة النماذج واستعادتها',
};

/** صلاحيات لا معنى لها دون صلاحية أخرى (مثلًا: لا تعديل دون عرض). */
export const PERMISSION_REQUIRES: Partial<Record<Permission, Permission>> = {
  FORMS_CREATE: 'FORMS_VIEW',
  FORMS_EDIT: 'FORMS_VIEW',
  FORMS_ARCHIVE: 'FORMS_VIEW',
};

/** مدير النظام يملك كل الصلاحيات دائمًا؛ المشرف يملك ما مُنح له فقط. */
export function effectivePermissions(role: UserRole, granted: readonly Permission[]): Permission[] {
  if (role === UserRole.ADMIN) return [...ALL_PERMISSIONS];
  return ALL_PERMISSIONS.filter((p) => granted.includes(p));
}

/** يعيد الصلاحيات الناقصة التي تتطلبها مجموعة صلاحيات معطاة. */
export function missingPrerequisites(permissions: readonly Permission[]): Permission[] {
  const missing = new Set<Permission>();
  for (const p of permissions) {
    const required = PERMISSION_REQUIRES[p];
    if (required && !permissions.includes(required)) missing.add(required);
  }
  return [...missing];
}

export interface Requirement {
  adminOnly?: boolean;
  permissions?: readonly Permission[];
}

export function isAuthorized(
  auth: { role: UserRole; permissions: readonly Permission[] },
  requirement: Requirement,
): boolean {
  if (auth.role === UserRole.ADMIN) return true;
  if (requirement.adminOnly) return false;
  return (requirement.permissions ?? []).every((p) => auth.permissions.includes(p));
}
