const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  SQL,
  validateDatabase,
  buildDatabaseSshArgs,
  testDatabaseConnection,
} = require("../electron/database.cjs");
const ssh = {
  host: "migration.invalid",
  port: "22",
  user: "operator",
  privateKey: "",
};
const database = {
  host: "postgres.internal",
  port: "5432",
  name: "abis",
  user: "migration",
  ssl: "disable",
};
const { fixture } = require("./support/postgres.cjs");
function check(state, changes = {}, options = {}) {
  return testDatabaseConnection(
    {
      ssh,
      database,
      password: "test-only-secret",
      controlPath: "/tmp/fixture/socket",
      ...changes,
    },
    { spawnProcess: state.spawnProcess, timeoutMs: 1500, ...options },
  );
}
test("валидирует БД и не позволяет подставить параметры в SSH forwarding", () => {
  for (const change of [
    { host: "-oProxyCommand=evil" },
    { host: "db\nother" },
    { port: "5432x" },
    { port: 0 },
    { port: 65536 },
    { name: "" },
    { ssl: "unknown" },
  ])
    assert.throws(() => validateDatabase({ ...database, ...change }, ""));
  const args = buildDatabaseSshArgs(
    ssh,
    { ...database, host: "::1" },
    "/tmp/private socket/s",
  );
  assert.equal(args[args.indexOf("-W") + 1], "[::1]:5432");
  assert.ok(args.includes("ProxyCommand=false"));
  assert.ok(args.includes("BatchMode=yes"));
});
test("pg выполняет один read-only SELECT через Duplex, пароль отсутствует в argv", async (t) => {
  const state = await fixture(t);
  const result = await check(state);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.database, "abis");
  assert.equal(result.details.ssl, false);
  assert.deepEqual(state.queries, [SQL]);
  assert.deepEqual(state.passwords, ["test-only-secret"]);
  assert.match(state.startup[0], /default_transaction_read_only=on/);
  assert.ok(!JSON.stringify(state.args).includes("test-only-secret"));
});
test("пустой пароль не заменяется локальным PGPASSWORD", async (t) => {
  const state = await fixture(t);
  const previous = process.env.PGPASSWORD;
  process.env.PGPASSWORD = "ambient-password";
  try {
    const result = await check(state, { password: "" });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(state.passwords, [""]);
  } finally {
    if (previous === undefined) delete process.env.PGPASSWORD;
    else process.env.PGPASSWORD = previous;
  }
});
test("ошибка аутентификации возвращается без пароля и без повторного входа", async (t) => {
  const state = await fixture(t, {
    reject: true,
    errorMessage: "Denied test-only-secret",
  });
  const result = await check(state);
  assert.equal(result.ok, false);
  assert.ok(!result.message.includes("test-only-secret"));
  assert.match(result.message, /\[скрыто\]/);
  assert.equal(state.connections, 1);
  assert.equal(state.queries.length, 0);
});
test("prefer повторяет без TLS только после явного отказа сервера от SSL", async (t) => {
  const state = await fixture(t);
  const result = await check(state, {
    database: { ...database, ssl: "prefer" },
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(state.connections, 2);
  assert.equal(state.queries.length, 1);
});
for (const ssl of ["require", "verify-full"])
  test(`${ssl} не понижается до незашифрованного подключения`, async (t) => {
    const state = await fixture(t);
    const result = await check(state, { database: { ...database, ssl } });
    assert.equal(result.ok, false);
    assert.match(result.message, /does not support SSL/);
    assert.equal(state.connections, 1);
    assert.equal(state.passwords.length, 0);
  });
test("таймаут закрывает зависший канал", async (t) => {
  const state = await fixture(t, { stall: true });
  const result = await check(state, {}, { timeoutMs: 200 });
  assert.equal(result.ok, false);
  assert.match(result.message, /истекло|timeout/i);
  assert.ok(result.durationMs < 1500);
});
test("закрытие SSH отменяет проверку и не запускает повторное соединение", async (t) => {
  const state = await fixture(t, { stall: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const result = await check(state, { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.match(result.message, /отменена/);
  } finally {
    clearTimeout(timer);
  }
});

// Настоящий TLS поверх бинарного SSH-потока, сертификат и ключ одноразовые.
test("TLS require шифрует канал, verify-full отклоняет недоверенный сертификат", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const tls = require("node:tls");
  const { execFileSync } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-db-tls-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync(
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(root, "key"),
      "-out",
      path.join(root, "cert"),
      "-days",
      "1",
      "-subj",
      "/CN=postgres.internal",
    ],
    { stdio: "ignore" },
  );
  const secureContext = tls.createSecureContext({
    key: fs.readFileSync(path.join(root, "key")),
    cert: fs.readFileSync(path.join(root, "cert")),
  });
  const state = await fixture(t, { secureContext });
  const required = await check(state, {
    database: { ...database, ssl: "require" },
  });
  assert.equal(required.ok, true, required.message);
  assert.equal(required.details.ssl, true);
  const verified = await check(state, {
    database: { ...database, ssl: "verify-full" },
  });
  assert.equal(verified.ok, false);
  assert.match(verified.message, /self.signed|certificate/i);
  assert.equal(state.connections, 2);
  assert.equal(state.passwords.length, 1);
});

test("синхронная ошибка запуска SSH возвращается без зависания очистки", async () => {
  const result = await testDatabaseConnection(
    { ssh, database, password: "", controlPath: "/tmp/fake" },
    {
      spawnProcess: () => {
        throw new Error("fixture spawn failure");
      },
      timeoutMs: 200,
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /fixture spawn failure/);
});
