'use client';

import { PERMISSION_OPTIONS, togglePermission } from '@/lib/permissions';
import type { Permission } from '@/lib/types';

export function PermissionPicker({
  value,
  onChange,
  error,
  disabled,
}: {
  value: Permission[];
  onChange: (value: Permission[]) => void;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <fieldset
      className="flex flex-col gap-2"
      aria-describedby={error ? 'permissions-error' : 'permissions-hint'}
    >
      <legend className="mb-1 text-sm font-semibold text-ink">الصلاحيات</legend>
      <p id="permissions-hint" className="text-xs text-muted">
        صلاحيات الإنشاء والتعديل والأرشفة تتطلب صلاحية العرض، وتُفعَّل معها تلقائيًا.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {PERMISSION_OPTIONS.map((option) => {
          const checked = value.includes(option.key);
          return (
            <label
              key={option.key}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
                checked
                  ? 'border-velvet-500 bg-velvet-50'
                  : 'border-smoke-300 bg-white/70 hover:border-velvet-300'
              } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <input
                type="checkbox"
                className="mt-0.5 size-5 accent-velvet-700"
                checked={checked}
                disabled={disabled}
                name="permissions"
                value={option.key}
                aria-label={option.label}
                aria-describedby={`permission-hint-${option.key}`}
                onChange={(e) => onChange(togglePermission(value, option.key, e.target.checked))}
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-ink">{option.label}</span>
                <span id={`permission-hint-${option.key}`} className="text-xs text-muted">
                  {option.hint}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {error && (
        <p id="permissions-error" className="text-sm font-medium text-red-800">
          {error}
        </p>
      )}
    </fieldset>
  );
}
