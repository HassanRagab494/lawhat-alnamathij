'use client';

import { Field, TextArea, TextInput } from './ui';

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 2000;

/** حقلا العنوان والوصف المشتركان بين إنشاء النموذج وتعديله. */
export function FormBasicsFields({
  title,
  description,
  errors,
  disabled,
  onTitle,
  onDescription,
}: {
  title: string;
  description: string;
  errors: Record<string, string>;
  disabled?: boolean;
  onTitle: (value: string) => void;
  onDescription: (value: string) => void;
}) {
  return (
    <>
      <Field label="عنوان النموذج" error={errors.title} required hint={`حتى ${TITLE_MAX} حرف.`}>
        {({ id, describedBy, invalid }) => (
          <TextInput
            id={id}
            name="title"
            value={title}
            maxLength={TITLE_MAX}
            disabled={disabled}
            onChange={(e) => onTitle(e.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            required
          />
        )}
      </Field>
      <Field
        label="الوصف (اختياري)"
        error={errors.description}
        hint={`${description.length} / ${DESCRIPTION_MAX} حرف`}
      >
        {({ id, describedBy, invalid }) => (
          <TextArea
            id={id}
            name="description"
            value={description}
            maxLength={DESCRIPTION_MAX}
            disabled={disabled}
            onChange={(e) => onDescription(e.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        )}
      </Field>
    </>
  );
}

export function validateFormBasics(title: string): Record<string, string> {
  return title.trim() ? {} : { title: 'عنوان النموذج مطلوب.' };
}
