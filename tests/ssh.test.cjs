const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSshArgs } = require("../electron/ssh.cjs");
const profile = {
  host: "migration.example.org",
  user: "operator",
  port: "22",
  publicKey: "",
};
test("SSH передаёт сервер и пользователя отдельными аргументами", () => {
  const args = buildSshArgs(profile);
  assert.deepEqual(args.slice(-3), ["-l", "operator", "migration.example.org"]);
  assert.ok(args.includes("StrictHostKeyChecking=ask"));
});
test("публичный ключ используется как identity для SSH-agent", () => {
  const args = buildSshArgs({
    ...profile,
    publicKey: "/Users/operator/.ssh/migration.pub",
  });
  assert.equal(
    args[args.indexOf("-i") + 1],
    "/Users/operator/.ssh/migration.pub",
  );
});
test("отклоняет внедрение SSH-опций и недопустимые порты", () => {
  for (const changes of [
    { host: "-oProxyCommand=evil" },
    { host: "server; touch /tmp/evil" },
    { user: "-root" },
    { port: 0 },
    { port: 65536 },
    { port: "22abc" },
    { publicKey: "/tmp/private" },
  ])
    assert.throws(() => buildSshArgs({ ...profile, ...changes }));
});
