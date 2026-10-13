import { Transform } from 'class-transformer';

/** يقص المسافات من النصوص ويترك غيرها كما هو ليرفضه التحقق برسالة مناسبة. */
export const Trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** يقص المسافات ويحوّل النص الفارغ إلى null (للحقول الاختيارية القابلة للمسح). */
export const TrimToNull = () =>
  Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  });
