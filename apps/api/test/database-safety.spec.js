const { assertSafeReset, identity } = require('./database-safety');
const resolve = jest.fn(async () => [{ address: '127.0.0.1' }]);
const safe = {
  DATABASE_URL: 'mysql://dev:pw@localhost/app',
  TEST_DATABASE_URL: 'mysql://test:pw@localhost/app_test',
  ALLOW_TEST_DATABASE_RESET: 'app_test',
};
test('accepts dedicated approved database', async () => {
  await expect(assertSafeReset(safe, resolve)).resolves.toMatchObject({
    database: 'app_test',
    port: 3306,
  });
});
test.each([
  'mysql://other:pw@localhost/app_test?connection_limit=2',
  'mysql://u:p@127.0.0.1:3306/app_test',
])('rejects same database despite credentials or alias', async (main) => {
  await expect(assertSafeReset({ ...safe, DATABASE_URL: main }, resolve)).rejects.toThrow();
});
test.each([
  'bad',
  'postgres://u:p@localhost/app_test',
  'mysql://localhost/',
  'mysql://localhost/app_test?socket=x',
  'mysql://localhost/app%5ftest',
])('rejects invalid or ambiguous URLs: %s', (raw) => {
  expect(() => identity(raw)).toThrow();
});
test('requires approval and test name', async () => {
  await expect(
    assertSafeReset({ ...safe, ALLOW_TEST_DATABASE_RESET: '' }, resolve),
  ).rejects.toThrow();
  await expect(
    assertSafeReset({ ...safe, TEST_DATABASE_URL: 'mysql://localhost/production' }, resolve),
  ).rejects.toThrow();
});
test('fails closed on DNS error or missing development URL', async () => {
  await expect(
    assertSafeReset(safe, async () => {
      throw new Error('DNS');
    }),
  ).rejects.toThrow();
  await expect(assertSafeReset({ ...safe, DATABASE_URL: undefined }, resolve)).rejects.toThrow();
});

test('global setup refuses reset before invoking any destructive command', async () => {
  const child = require('node:child_process');
  const exec = jest.spyOn(child, 'execSync').mockImplementation(() => {
    throw new Error('Must never execute');
  });
  const saved = { ...process.env };
  try {
    Object.assign(process.env, safe, { DATABASE_URL: safe.TEST_DATABASE_URL });
    await expect(require('./global-setup')()).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  } finally {
    process.env = saved;
    exec.mockRestore();
  }
});
