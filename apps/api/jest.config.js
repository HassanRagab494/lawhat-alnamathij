/** اختبارات الوحدة: لا تحتاج قاعدة بيانات. */
module.exports = {
  cacheDirectory: '<rootDir>/.jest-cache',
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.js'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
