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
  {
    key: 'FORMS_PUBLISH',
    label: 'نشر النماذج',
    hint: 'نشر إصدار ثابت من المسودة وإتاحة الرابط العام.',
  },
  {
    key: 'FORMS_INTAKE',
    label: 'فتح وإغلاق استقبال الردود',
    hint: 'التحكم في قبول الردود على الرابط العام.',
  },
  {
    key: 'RESPONSES_VIEW',
    label: 'عرض الردود',
    hint: 'الاطلاع على قائمة ردود النماذج وتفاصيلها.',
  },
  {
    key: 'RESPONSES_REVIEW',
    label: 'مراجعة الردود وتغيير حالتها',
    hint: 'تغيير حالة الرد: جديد، قيد المراجعة، مقبول، مرفوض.',
  },
  {
    key: 'RESPONSES_EXPORT',
    label: 'تصدير الردود',
    hint: 'تنزيل الردود ملف CSV.',
  },
  {
    key: 'RESPONSES_FILES_DOWNLOAD',
    label: 'تنزيل ملفات الردود',
    hint: 'تنزيل الملفات التي أرفقها المرسلون (بعد فحصها).',
  },
];

export const PERMISSION_LABELS = Object.fromEntries(
  PERMISSION_OPTIONS.map((p) => [p.key, p.label]),
) as Record<Permission, string>;

/** الصلاحية التي تتطلبها كل صلاحية (مطابقة لـ PERMISSION_REQUIRES في الـ Backend). */
const REQUIRES: Partial<Record<Permission, Permission>> = {
  FORMS_CREATE: 'FORMS_VIEW',
  FORMS_EDIT: 'FORMS_VIEW',
  FORMS_ARCHIVE: 'FORMS_VIEW',
  FORMS_PUBLISH: 'FORMS_VIEW',
  FORMS_INTAKE: 'FORMS_VIEW',
  RESPONSES_VIEW: 'FORMS_VIEW',
  RESPONSES_REVIEW: 'RESPONSES_VIEW',
  RESPONSES_EXPORT: 'RESPONSES_VIEW',
  RESPONSES_FILES_DOWNLOAD: 'RESPONSES_VIEW',
};

/**
 * يبدّل صلاحية مع الحفاظ على الاعتماديات المتسلسلة:
 * تفعيل صلاحية يفعّل ما تتطلبه (مثلًا المراجعة ⇒ عرض الردود ⇒ عرض النماذج)،
 * وإلغاء صلاحية يلغي كل ما يعتمد عليها.
 */
export function togglePermission(
  current: Permission[],
  key: Permission,
  checked: boolean,
): Permission[] {
  const set = new Set(current);
  if (checked) {
    for (let p: Permission | undefined = key; p; p = REQUIRES[p]) set.add(p);
  } else {
    set.delete(key);
    let removed = true;
    while (removed) {
      removed = false;
      for (const p of set) {
        const required = REQUIRES[p];
        if (required && !set.has(required)) {
          set.delete(p);
          removed = true;
        }
      }
    }
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
