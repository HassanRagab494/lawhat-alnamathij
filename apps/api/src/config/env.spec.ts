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
    expect(loadEnv({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'true' }).COOKIE_SECURE).toBe(
      true,
    );
  });
});
