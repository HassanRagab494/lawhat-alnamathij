import { Permission, UserRole } from '@prisma/client';
import {
  ALL_PERMISSIONS,
  effectivePermissions,
  isAuthorized,
  missingPrerequisites,
} from './permissions';

describe('permissions', () => {
  it('مدير النظام يملك كل الصلاحيات حتى دون منح صريح', () => {
    expect(effectivePermissions(UserRole.ADMIN, [])).toEqual([...ALL_PERMISSIONS]);
  });

  it('المشرف يملك الممنوح فقط', () => {
    expect(effectivePermissions(UserRole.SUPERVISOR, [Permission.FORMS_VIEW])).toEqual([
      Permission.FORMS_VIEW,
    ]);
  });

  it('isAuthorized: المشرف لا يصل إلى مسارات المدير', () => {
    const supervisor = { role: UserRole.SUPERVISOR, permissions: [...ALL_PERMISSIONS] };
    expect(isAuthorized(supervisor, { adminOnly: true })).toBe(false);
  });

  it('isAuthorized: يشترط كل الصلاحيات المطلوبة', () => {
    const supervisor = { role: UserRole.SUPERVISOR, permissions: [Permission.FORMS_VIEW] };
    expect(isAuthorized(supervisor, { permissions: [Permission.FORMS_VIEW] })).toBe(true);
    expect(isAuthorized(supervisor, { permissions: [Permission.FORMS_EDIT] })).toBe(false);
    expect(isAuthorized(supervisor, {})).toBe(true);
  });

  it('isAuthorized: المدير يتجاوز كل شيء', () => {
    const admin = { role: UserRole.ADMIN, permissions: [] };
    expect(isAuthorized(admin, { adminOnly: true, permissions: [Permission.FORMS_EDIT] })).toBe(
      true,
    );
  });

  it('missingPrerequisites: الإنشاء والتعديل والأرشفة تتطلب العرض', () => {
    expect(missingPrerequisites([Permission.FORMS_EDIT])).toEqual([Permission.FORMS_VIEW]);
    expect(missingPrerequisites([Permission.FORMS_VIEW, Permission.FORMS_EDIT])).toEqual([]);
    expect(missingPrerequisites([])).toEqual([]);
  });
});
