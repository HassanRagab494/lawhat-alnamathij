import { EnvValidationError, loadEnv } from './env';

const base = {
  DATABASE_URL: 'mysql://u:p@localhost:3306/db',
  WEB_ORIGIN: 'http://localhost:3000',
};

describe('loadEnv', () => {
  it('يطبق القيم الافتراضية', () => {
    const env = loadEnv({ ...base });
    expect(env.API_PORT).toBe(4000);
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.APP_NAME).toBe('لوحة النماذج');
  });

  it('يرفض غياب المتغيرات المطلوبة ويذكر أسماءها دون قيم', () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);
    try {
      loadEnv({ WEB_ORIGIN: 'http://localhost:3000' });
    } catch (error) {
      expect((error as Error).message).toContain('DATABASE_URL');
    }
  });

  it('يرفض قاعدة غير MySQL', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: 'file:./dev.db' })).toThrow(/mysql/);
  });

  it('يشترط COOKIE_SECURE=true في الإنتاج', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/COOKIE_SECURE/);
    expect(loadEnv({ ...prod }).COOKIE_SECURE).toBe(true);
  });
});

const prod = {
  ...base,
  NODE_ENV: 'production',
  COOKIE_SECURE: 'true',
  TRUST_PROXY: '172.20.0.0/16',
};

describe('TRUST_PROXY (حدود الثقة لعنوان IP)', () => {
  it('يقبل loopback وعناوين وشبكات محددة', () => {
    expect(loadEnv({ ...base }).TRUST_PROXY).toBe('loopback');
    for (const value of [
      'loopback',
      '10.0.1.5',
      '172.20.0.0/16, 10.0.0.2',
      'uniquelocal',
      'fd00::/8',
    ]) {
      expect(loadEnv({ ...prod, TRUST_PROXY: value }).TRUST_PROXY).toBe(value);
    }
  });

  it.each([
    'true',
    'TRUE',
    '*',
    '0.0.0.0/0',
    '::/0',
    'false',
    '10.0.0.0/4',
    'not-an-ip',
    '10.0.0.1/40',
    'a,,b',
  ])('يرفض %s في كل البيئات', (value) => {
    expect(() => loadEnv({ ...base, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
    expect(() => loadEnv({ ...prod, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
  });

  it('يشترط ضبطه صراحة في الإنتاج ويرفض عدد القفزات فيه', () => {
    const { TRUST_PROXY: _omit, ...withoutTrust } = prod;
    expect(() => loadEnv(withoutTrust)).toThrow(/TRUST_PROXY: مطلوب صراحة/);
    expect(() => loadEnv({ ...prod, TRUST_PROXY: '1' })).toThrow(/عدد القفزات/);
    expect(loadEnv({ ...base, TRUST_PROXY: '1' }).TRUST_PROXY).toBe('1');
  });

  it('يذكر كل المشكلات معًا دون قيم الأسرار', () => {
    try {
      loadEnv({ ...base, NODE_ENV: 'production', DATABASE_URL: 'mysql://u:secret@h/db' });
      throw new Error('expected failure');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('COOKIE_SECURE');
      expect(message).toContain('TRUST_PROXY');
      expect(message).not.toContain('secret');
    }
  });
});

describe('API_DOCS_ENABLED', () => {
  it('مفعّل افتراضيًا في التطوير ومعطّل افتراضيًا في الإنتاج، ويمكن تجاوزه صراحة', () => {
    expect(loadEnv({ ...base }).API_DOCS_ENABLED).toBe(true);
    expect(loadEnv({ ...prod }).API_DOCS_ENABLED).toBe(false);
    expect(loadEnv({ ...prod, API_DOCS_ENABLED: 'true' }).API_DOCS_ENABLED).toBe(true);
    expect(loadEnv({ ...base, API_DOCS_ENABLED: 'false' }).API_DOCS_ENABLED).toBe(false);
    expect(() => loadEnv({ ...base, API_DOCS_ENABLED: 'yes' })).toThrow(/API_DOCS_ENABLED/);
  });
});
