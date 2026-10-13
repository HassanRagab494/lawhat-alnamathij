import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * التجزئة عبر scrypt المدمج في Node.js (بلا مكتبات أصلية) وفق الحد الأدنى في توصيات OWASP:
 * N=2^17، r=8، p=1، ملح عشوائي 16 بايت، مخرج 64 بايت.
 * الصيغة المخزنة: scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
 * تُحفظ المعاملات مع كل تجزئة، فيمكن رفعها لاحقًا دون كسر الحسابات القائمة.
 */
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keyLength: 64, saltLength: 16 } as const;

function deriveKey(
  password: string,
  salt: Buffer,
  params: { N: number; r: number; p: number },
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password.normalize('NFKC'),
      salt,
      keyLength,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltLength);
  const key = await deriveKey(password, salt, SCRYPT, SCRYPT.keyLength);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  const parts = passwordHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (![params.N, params.r, params.p].every((v) => Number.isInteger(v) && v > 0)) return false;
  const expected = Buffer.from(keyB64, 'base64');
  if (expected.length === 0) return false;
  try {
    const actual = await deriveKey(
      password,
      Buffer.from(saltB64, 'base64'),
      params,
      expected.length,
    );
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** يستهلك وقتًا مماثلًا للتحقق الحقيقي عند عدم وجود المستخدم لتقليل كشف الحسابات بالتوقيت. */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing-only');
  await verifyPassword(await dummyHash, password);
}

/** يعيد رسالة خطأ عربية أو null إن كانت كلمة المرور مقبولة. */
export function passwordPolicyError(password: string, username?: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `كلمة المرور يجب ألا تقل عن ${PASSWORD_MIN_LENGTH} أحرف.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `كلمة المرور يجب ألا تزيد عن ${PASSWORD_MAX_LENGTH} حرفًا.`;
  }
  if (password.trim().length === 0) {
    return 'كلمة المرور لا يمكن أن تكون مسافات فقط.';
  }
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    return 'كلمة المرور يجب ألا تحتوي على اسم المستخدم.';
  }
  return null;
}

export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{2,30})[a-z0-9]$/;

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}
