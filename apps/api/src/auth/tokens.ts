import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'lp_session';
export const CSRF_COOKIE = 'lp_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** يقارن رمز CSRF المرسل في الترويسة مع التجزئة المخزنة للجلسة بزمن ثابت. */
export function csrfMatches(provided: string | undefined, storedHash: string): boolean {
  if (!provided || provided.length > 256) return false;
  const a = Buffer.from(sha256(provided), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
