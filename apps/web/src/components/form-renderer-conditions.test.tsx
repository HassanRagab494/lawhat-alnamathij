import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RenderQuestion } from '@/lib/answer-validation';
import { FormRenderer } from './form-renderer';

afterEach(cleanup);

const questions: RenderQuestion[] = [
  {
    key: 'kind',
    type: 'SINGLE_CHOICE',
    title: 'وش ترغب تسجّل؟',
    description: null,
    required: true,
    settings: {},
    options: [
      { key: 'offer', label: 'عرض عقار' },
      { key: 'request', label: 'طلب عقار' },
    ],
  },
  {
    key: 'price',
    type: 'NUMBER',
    title: 'السعر المطلوب',
    description: null,
    required: true,
    settings: { allowDecimals: false },
    options: [],
    showIf: { questionKey: 'kind', optionKeys: ['offer'] },
  },
  {
    key: 'budget',
    type: 'NUMBER',
    title: 'الحد الأعلى للميزانية',
    description: null,
    required: true,
    settings: { allowDecimals: false },
    options: [],
    showIf: { questionKey: 'kind', optionKeys: ['request'] },
  },
];

describe('الأسئلة الشرطية في المعاينة', () => {
  it('تظهر أسئلة المسار المختار فقط، وتغيير المسار ينبّه دون فقد الإجابات', () => {
    render(<FormRenderer title="نموذج عقاري" description={null} questions={questions} />);
    expect(screen.queryByLabelText(/السعر المطلوب/)).toBeNull();
    expect(screen.queryByLabelText(/الحد الأعلى للميزانية/)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'عرض عقار' }));
    const price = screen.getByLabelText(/السعر المطلوب/);
    fireEvent.change(price, { target: { value: '950000' } });
    expect(screen.queryByLabelText(/الحد الأعلى للميزانية/)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'طلب عقار' }));
    expect(screen.queryByLabelText(/السعر المطلوب/)).toBeNull();
    expect(screen.getByLabelText(/الحد الأعلى للميزانية/)).toBeTruthy();
    expect(
      screen.getByText(
        /بهذا الاختيار أُخفي سؤال أجبت عنه: «السعر المطلوب». إجاباتها محفوظة في الصفحة لكنها لن تُرسل/,
      ),
    ).toBeTruthy();

    // الرجوع للمسار السابق يعيد الإجابة كما هي
    fireEvent.click(screen.getByRole('radio', { name: 'عرض عقار' }));
    expect((screen.getByLabelText(/السعر المطلوب/) as HTMLInputElement).value).toBe('950000');

    // التحقق يتجاهل الفرع المخفي
    fireEvent.click(screen.getByRole('button', { name: 'تجربة التحقق من الإجابات' }));
    expect(screen.getByText(/الإجابات صالحة/)).toBeTruthy();
  });
});
