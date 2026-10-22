const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSshArgs } = require("../electron/ssh.cjs");
const profile = {
  host: "migration.example.org",
  user: "operator",
  port: "22",
  privateKey: "",
};
test("SSH передаёт сервер и пользователя отдельными аргументами", () => {
  const args = buildSshArgs(profile);
  assert.deepEqual(args.slice(-3), ["-l", "operator", "migration.example.org"]);
  assert.ok(args.includes("StrictHostKeyChecking=ask"));
});
test("приватные ключи без расширения и PEM передаются в SSH без shell", () => {
  for (const privateKey of [
    "/Users/operator/.ssh/migration",
    "/Users/operator/SSH keys/server.pem",
  ]) {
    const args = buildSshArgs({ ...profile, privateKey });
    assert.equal(args[args.indexOf("-i") + 1], privateKey);
  }
});
test("отклоняет внедрение SSH-опций и недопустимые порты", () => {
  for (const changes of [
    { host: "-oProxyCommand=evil" },
    { host: "server; touch /tmp/evil" },
    { user: "-root" },
    { port: 0 },
    { port: 65536 },
    { port: "22abc" },
    { privateKey: "/tmp/private.pub" },
    { privateKey: "relative-key" },
    { privateKey: "/tmp/key\nfile" },
  ])
    assert.throws(() => buildSshArgs({ ...profile, ...changes }));
});
