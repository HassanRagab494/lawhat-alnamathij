/**
 * اختبارات التكامل: تعمل على MySQL حقيقية عبر TEST_DATABASE_URL.
 * تُمسح قاعدة الاختبار وتُطبق migrations قبل التشغيل (global-setup).
 */
module.exports = {
  rootDir: '..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  globalSetup: '<rootDir>/test/global-setup.js',
  setupFiles: ['<rootDir>/test/setup-env.js'],
  testTimeout: 60_000,
};
