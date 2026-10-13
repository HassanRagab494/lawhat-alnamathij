const { lookup } = require('node:dns').promises;
function identity(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid database URL');
  }
  if (
    url.protocol !== 'mysql:' ||
    !url.hostname ||
    url.hash ||
    !/^\/[a-zA-Z0-9_]+$/.test(url.pathname)
  )
    throw new Error('Unsafe database URL');
  if (
    [...url.searchParams.keys()].some(
      (k) =>
        ![
          'connection_limit',
          'pool_timeout',
          'connect_timeout',
          'socket_timeout',
          'sslaccept',
          'sslcert',
          'sslidentity',
          'sslpassword',
        ].includes(k),
    )
  )
    throw new Error('Unsupported connection parameter');
  const port = Number(url.port || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  return {
    host: url.hostname.toLowerCase().replace(/\.$/, ''),
    port,
    database: url.pathname.slice(1).toLowerCase(),
  };
}
async function assertSafeReset(env, resolve = (host) => lookup(host, { all: true })) {
  const test = identity(env.TEST_DATABASE_URL);
  const main = identity(env.DATABASE_URL);
  if (!/^[a-z0-9_]+_test$/.test(test.database)) throw new Error('Test database must end in _test');
  if (env.ALLOW_TEST_DATABASE_RESET !== test.database)
    throw new Error('Explicit reset approval must equal test database name');
  if (env.SHADOW_DATABASE_URL && identity(env.SHADOW_DATABASE_URL).database === test.database)
    throw new Error('Test and shadow database may overlap');
  const addresses = await Promise.all([resolve(test.host), resolve(main.host)]);
  if (addresses.some((a) => !a.length)) throw new Error('Cannot establish server identity');
  const sameServer =
    test.host === main.host ||
    addresses[0].some((a) => addresses[1].some((b) => a.address === b.address));
  if (sameServer && test.port === main.port && test.database === main.database)
    throw new Error('Same database identity');
  // Fail closed even when DNS/ports differ: aliases and tunnels cannot establish independence.
  if (test.database === main.database) throw new Error('Database identity may overlap');
  return test;
}
module.exports = { identity, assertSafeReset };
