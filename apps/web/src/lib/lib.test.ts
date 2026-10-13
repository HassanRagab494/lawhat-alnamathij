import { describe, expect, it } from 'vitest';
import { ApiError, readCookie, toApiError } from './api';
import { formatDateTime } from './format';
import { can, togglePermission } from './permissions';
import type { Me } from './types';

describe('formatDateTime', () => {
  it('يعرض وقت UTC بتوقيت الرياض (UTC+3) وبالتقويم الميلادي', () => {
    const text = formatDateTime('2026-10-12T21:30:00.000Z');
    // 21:30 UTC = 00:30 صباح 13 أكتوبر بتوقيت الرياض
    expect(text).toContain('13');
    expect(text).toContain('أكتوبر');
    expect(text).toContain('2026');
    expect(text).toMatch(/12:30|0:30/);
  });
  it('يعرض شرطة للقيمة الفارغة', () => {
    expect(formatDateTime(null)).toBe('—');
  });
});

describe('togglePermission', () => {
  it('تفعيل التعديل يفعّل العرض تلقائيًا', () => {
    expect(togglePermission([], 'FORMS_EDIT', true)).toEqual(['FORMS_VIEW', 'FORMS_EDIT']);
  });
  it('إلغاء العرض يلغي الصلاحيات التابعة', () => {
    expect(
      togglePermission(['FORMS_VIEW', 'FORMS_CREATE', 'FORMS_EDIT'], 'FORMS_VIEW', false),
    ).toEqual([]);
  });
});

describe('can', () => {
  const sup: Me = {
    id: '1',
    username: 's',
    displayName: 'س',
    role: 'SUPERVISOR',
    permissions: ['FORMS_VIEW'],
  };
  it('المشرف يملك الممنوح فقط والمدير يملك الكل', () => {
    expect(can(sup, 'FORMS_VIEW')).toBe(true);
    expect(can(sup, 'FORMS_EDIT')).toBe(false);
    expect(can({ ...sup, role: 'ADMIN', permissions: [] }, 'FORMS_EDIT')).toBe(true);
    expect(can(null, 'FORMS_VIEW')).toBe(false);
  });
});

describe('api helpers', () => {
  it('readCookie', () => {
    expect(readCookie('lp_csrf', 'a=1; lp_csrf=abc%3D; b=2')).toBe('abc=');
    expect(readCookie('lp_csrf', 'a=1')).toBeNull();
  });
  it('toApiError يحافظ على أخطاء الحقول', () => {
    const err = toApiError(400, {
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      message: 'بعض البيانات المدخلة غير صحيحة.',
      fields: [{ field: 'title', message: 'عنوان النموذج مطلوب.' }],
    });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.fieldMap()).toEqual({ title: 'عنوان النموذج مطلوب.' });
  });
  it('toApiError لاستجابة غير JSON من الوكيل', () => {
    expect(toApiError(502, null).message).toMatch(/غير متاحة/);
  });
});
