const { execSync } = require('node:child_process');
const path = require('node:path');
const { assertSafeReset } = require('./database-safety');

/** يمسح قاعدة الاختبار ويطبق كل migrations من الصفر عبر Prisma (لا تعديل يدوي للقاعدة). */
module.exports = async () => {
  const url = process.env.TEST_DATABASE_URL;
  await assertSafeReset(process.env);
  execSync('npx prisma migrate reset --force --skip-seed --skip-generate', {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
};
