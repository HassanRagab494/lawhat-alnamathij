'use client';

import { Field, TextInput } from './ui';

export const PASSWORD_MIN = 10;

/** حقل كلمة مرور جديدة مع التأكيد، يُستخدم في إنشاء المشرف وإعادة التعيين وتغيير كلمة المرور. */
export function NewPasswordFields({
  password,
  confirm,
  errors,
  onPassword,
  onConfirm,
  label = 'كلمة المرور',
  passwordField = 'password',
}: {
  password: string;
  confirm: string;
  errors: Record<string, string>;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
  label?: string;
  passwordField?: string;
}) {
  return (
    <>
      <Field
        label={label}
        error={errors[passwordField]}
        required
        hint={`${PASSWORD_MIN} أحرف على الأقل، ولا تحتوي على اسم المستخدم.`}
      >
        {({ id, describedBy, invalid }) => (
          <TextInput
            id={id}
            type="password"
            dir="ltr"
            className="text-start"
            autoComplete="new-password"
            value={password}
            onChange={(e) => onPassword(e.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            required
          />
        )}
      </Field>
      <Field label="تأكيد كلمة المرور" error={errors.confirm} required>
        {({ id, describedBy, invalid }) => (
          <TextInput
            id={id}
            type="password"
            dir="ltr"
            className="text-start"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => onConfirm(e.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            required
          />
        )}
      </Field>
    </>
  );
}

export function validateNewPassword(
  password: string,
  confirm: string,
  passwordField = 'password',
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!password) errors[passwordField] = 'كلمة المرور مطلوبة.';
  else if (password.length < PASSWORD_MIN) {
    errors[passwordField] = `كلمة المرور يجب ألا تقل عن ${PASSWORD_MIN} أحرف.`;
  }
  if (password && confirm !== password) errors.confirm = 'كلمتا المرور غير متطابقتين.';
  return errors;
}
