import {
  USERNAME_PATTERN,
  hashPassword,
  normalizeUsername,
  passwordPolicyError,
  verifyPassword,
} from './password';

describe('password hashing', () => {
  it('يجزئ بـ scrypt مع ملح عشوائي ويتحقق بشكل صحيح', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$131072$8$1$')).toBe(true);
    expect(await hashPassword('correct horse battery')).not.toBe(hash);
    expect(hash).not.toContain('correct horse battery');
    await expect(verifyPassword(hash, 'correct horse battery')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong password!!')).resolves.toBe(false);
  });

  it('يعيد false لتجزئة تالفة بدل رمي استثناء', async () => {
    await expect(verifyPassword('not-a-hash', 'whatever123')).resolves.toBe(false);
  });
});

describe('passwordPolicyError', () => {
  it('يقبل كلمة مرور مناسبة', () => {
    expect(passwordPolicyError('a-long-enough-pass', 'sara')).toBeNull();
  });
  it('يرفض القصيرة برسالة عربية', () => {
    expect(passwordPolicyError('short')).toMatch(/لا تقل عن 10/);
  });
  it('يرفض كلمة مرور تحتوي اسم المستخدم', () => {
    expect(passwordPolicyError('sara.ali-2026!', 'sara.ali')).toMatch(/اسم المستخدم/);
  });
  it('يرفض المسافات فقط', () => {
    expect(passwordPolicyError(' '.repeat(12))).toMatch(/مسافات/);
  });
});

describe('username rules', () => {
  it.each(['admin', 'sara.ali', 'user_01', 'a1-b2'])('يقبل %s', (u) => {
    expect(USERNAME_PATTERN.test(u)).toBe(true);
  });
  it.each(['abc', 'Admin', '.admin', 'admin.', 'سارة', 'a b c d', 'x'.repeat(33)])(
    'يرفض %s',
    (u) => {
      expect(USERNAME_PATTERN.test(u)).toBe(false);
    },
  );
  it('يطبع اسم المستخدم', () => {
    expect(normalizeUsername('  Sara.Ali ')).toBe('sara.ali');
  });
});
