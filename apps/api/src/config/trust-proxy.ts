import { isIP } from 'node:net';

/**
 * حدود الثقة لعنوان IP العميل.
 *
 * مسار الطلب: المتصفح ⇒ الوكيل الأمامي ⇒ Next.js ⇒ الـ API.
 * Next.js 15 يمرر X-Forwarded-For كما وصلته ولا يضيف عنوان من اتصل به إلا إن غابت الترويسة.
 * Express يقرأ الترويسة فقط إن كان من اتصل بالـ API مباشرة ضمن TRUST_PROXY، ثم يأخذ أقرب عنوان غير موثوق
 * من اليمين. لذلك TRUST_PROXY يجب أن يصف Next.js وحده (عنوانه أو شبكته الداخلية)، لا أي مصدر يصل إليه الزائر.
 *
 * القيم المرفوضة دائمًا:
 * - true و* والشبكات الشاملة: تجعل أي متصل موثوقًا، فيحدد الزائر عنوانه بنفسه.
 * - false: كل الزوار يظهرون بعنوان Next.js، فيصبح حد كل IP حدًا مشتركًا للجميع.
 * في الإنتاج يُرفض أيضًا عدد القفزات (رقم)، لأنه يثق بأي متصل مباشر بالـ API دون التحقق من عنوانه.
 */

const NAMED = new Set(['loopback', 'linklocal', 'uniquelocal']);
const CATCH_ALL = new Set(['0.0.0.0/0', '::/0', '0.0.0.0', '::']);

export type TrustProxyValue = number | string;

/** يعيد رسالة خطأ عربية، أو null إن كانت القيمة مقبولة. */
export function trustProxyError(raw: string, production: boolean): string | null {
  const value = raw.trim();
  if (/^(true|\*)$/i.test(value)) {
    return 'لا يُسمح بالثقة بكل المتصلين؛ حدد عنوان الواجهة (Next.js) أو شبكتها';
  }
  if (/^false$/i.test(value)) {
    return 'false يجعل كل الزوار بعنوان الواجهة نفسه؛ حدد عنوان الواجهة أو شبكتها';
  }
  if (/^\d+$/.test(value)) {
    if (production) return 'عدد القفزات غير مسموح في الإنتاج؛ حدد عنوان الواجهة أو شبكتها';
    return Number(value) <= 10 ? null : 'عدد القفزات كبير جدًا';
  }
  for (const part of value.split(',').map((p) => p.trim())) {
    if (!part) return 'قائمة فيها عنصر فارغ';
    if (NAMED.has(part)) continue;
    if (CATCH_ALL.has(part)) return `لا يُسمح بالشبكة الشاملة ${part}`;
    const [address, prefix, ...rest] = part.split('/');
    const family = isIP(address ?? '');
    if (!family || rest.length) return `عنوان أو شبكة غير صالحة: ${part}`;
    if (prefix !== undefined) {
      const bits = Number(prefix);
      const max = family === 4 ? 32 : 128;
      if (!/^\d+$/.test(prefix) || bits > max) return `طول بادئة غير صالح: ${part}`;
      if (bits < 8) return `الشبكة ${part} واسعة جدًا للثقة`;
    }
  }
  return null;
}

/** القيمة كما تقبلها Express (رقم للقفزات، أو نص العناوين). */
export function toExpressTrustProxy(raw: string): TrustProxyValue {
  const value = raw.trim();
  return /^\d+$/.test(value) ? Number(value) : value;
}
