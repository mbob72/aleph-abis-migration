const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { _electron } = require("playwright");

// Проверка проходит через настоящее окно, IPC и PTY; рабочие серверы не используются.
test(
  "Electron: профиль без пароля и вывод настоящего SSH",
  { timeout: 45000 },
  async () => {
    const userData = fs.mkdtempSync(
      path.join(os.tmpdir(), "migration-desktop-test-"),
    );
    const application = await _electron.launch({
      args: [path.join(__dirname, ".."), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    });
    let page;
    try {
      page = await application.firstWindow();
      await page.waitForSelector("h1");
      assert.equal(await page.title(), "Светоч · Миграция");
      assert.equal(
        await page.evaluate(() => typeof window.desktop?.connect),
        "function",
      );
      assert.equal(
        await page.evaluate(() => typeof window.require),
        "undefined",
      );
      // Старое поле publicKey не становится приватным ключом при обновлении профиля.
      await page.evaluate(() =>
        localStorage.setItem(
          "svetoch.migration.profile.v1",
          JSON.stringify({
            ssh: { host: "127.0.0.1", publicKey: "/tmp/old.pub" },
          }),
        ),
      );
      await page.reload();
      const identity = page.getByRole("textbox", {
        name: "Приватный SSH-ключ",
        exact: true,
      });
      assert.equal(await identity.inputValue(), "");
      const privateKey = path.join(userData, "test identity");
      execFileSync(
        "/usr/bin/ssh-keygen",
        ["-t", "ed25519", "-N", "", "-f", privateKey],
        { stdio: "ignore" },
      );
      // Подменяется лишь ответ системного диалога; UI, preload и IPC настоящие.
      await application.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async (_window, options) => {
          if (
            !options.filters.some((filter) => filter.extensions.includes("*"))
          )
            throw new Error("Ключ без расширения недоступен");
          return { canceled: false, filePaths: [selected] };
        };
      }, privateKey + ".pub");
      await page
        .getByRole("button", { name: "Выбрать ключ", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Это публичный ключ .pub" })
        .waitFor();
      assert.equal(await identity.inputValue(), "");
      await application.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [selected],
        });
      }, privateKey);
      await page
        .getByRole("button", { name: "Выбрать ключ", exact: true })
        .click();
      await page.waitForFunction(
        (expected) =>
          document.querySelector('[aria-label="Приватный SSH-ключ"]').value ===
          expected,
        privateKey,
      );
      await application.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      });
      await page
        .getByRole("button", { name: "Выбрать ключ", exact: true })
        .click();
      assert.equal(await identity.inputValue(), privateKey);
      await page
        .getByRole("textbox", { name: "Сервер SSH", exact: true })
        .fill("127.0.0.1");
      await page
        .getByRole("spinbutton", { name: "Порт SSH", exact: true })
        .fill("1");
      await page
        .getByRole("textbox", { name: "Пользователь SSH", exact: true })
        .fill("migration-smoke");
      await page
        .getByRole("textbox", { name: "Пароль БД", exact: true })
        .fill("test-only-never-save");
      await page
        .getByRole("button", { name: "Сохранить настройки", exact: true })
        .click();
      const saved = await page.evaluate(() =>
        localStorage.getItem("svetoch.migration.profile.v1"),
      );
      assert.ok(!saved.includes("test-only-never-save"));
      assert.ok(!saved.includes("password"));
      assert.equal(JSON.parse(saved).ssh.privateKey, privateKey);
      assert.ok(!saved.includes("publicKey"));
      await page
        .getByRole("button", { name: "Открыть SSH", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "SSH-сеанс завершён с кодом 255." })
        .waitFor({ timeout: 5000 });
      await page.waitForFunction(() =>
        /Connection refused|connect to host/.test(
          document.querySelector(".terminal-surface").innerText,
        ),
      );
      assert.match(
        await page.locator(".terminal-surface").innerText(),
        /Connection refused|connect to host/,
      );
      assert.ok(
        await page
          .getByRole("button", { name: "Открыть SSH", exact: true })
          .isEnabled(),
      );
      await page.reload();
      await page.waitForSelector("h1");
      assert.equal(
        await page
          .getByRole("textbox", { name: "Пароль БД", exact: true })
          .inputValue(),
        "test-only-never-save",
      );
      assert.equal(
        await page
          .getByRole("textbox", { name: "Сервер SSH", exact: true })
          .inputValue(),
        "127.0.0.1",
      );
      // Удаляем только тестовый профиль перед завершением проверки.
      await page.evaluate(() =>
        localStorage.removeItem("svetoch.migration.profile.v1"),
      );
      await page.reload();
      if (process.env.MIGRATION_SCREENSHOT)
        await page.screenshot({ path: process.env.MIGRATION_SCREENSHOT });
    } catch (error) {
      console.error(
        "Alerts:",
        await page?.getByRole("alert").allTextContents(),
      );
      console.error(
        "Terminal:",
        await page?.locator(".terminal-surface").innerText(),
      );
      await page?.screenshot({
        path: path.join(os.tmpdir(), "migration-desktop-failure.png"),
      });
      throw error;
    } finally {
      await application.close();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  },
);

// Здесь SSH, управляющий сокет, PostgreSQL-драйвер и IPC настоящие;
// локальный сервер БД воспроизводит протокол и не содержит рабочих данных.
test(
  "Electron: test connection через локальный SSH master",
  { timeout: 30000 },
  async (t) => {
    const net = require("node:net");
    const { spawn } = require("node:child_process");
    const { fixture } = require("./support/postgres.cjs");
    const backend = await fixture(t);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-db-e2e-"));
    let application;
    let daemon;
    try {
      const identity = path.join(root, "identity");
      execFileSync("/usr/bin/ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        identity,
      ]);
      const reserve = net.createServer();
      await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
      const port = reserve.address().port;
      await new Promise((resolve) => reserve.close(resolve));
      const config = path.join(root, "sshd_config");
      fs.writeFileSync(
        config,
        `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${identity}\nPidFile ${root}/pid\nAuthorizedKeysFile ${identity}.pub\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nStrictModes no\nLogLevel ERROR\n`,
      );
      const knownHosts = path.join(root, "known_hosts");
      fs.writeFileSync(
        knownHosts,
        `[127.0.0.1]:${port} ${fs.readFileSync(identity + ".pub", "utf8")}`,
      );
      daemon = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let daemonError = "";
      daemon.stderr.on("data", (data) => {
        daemonError += data.toString();
      });
      application = await _electron.launch({
        args: [path.join(__dirname, ".."), `--user-data-dir=${root}/profile`],
      });
      await application.evaluate((_electron, known) => {
        const pty = process
          .getBuiltinModule("module")
          .createRequire(_electron.app.getAppPath() + "/package.json")(
          "node-pty",
        );
        const original = pty.spawn;
        pty.spawn = (command, args, options) => {
          globalThis.testControlPath = args[args.indexOf("-S") + 1];
          return original(
            command,
            [
              "-o",
              `UserKnownHostsFile=${known}`,
              "-o",
              "StrictHostKeyChecking=yes",
              ...args,
            ],
            options,
          );
        };
      }, knownHosts);
      const page = await application.firstWindow();
      await page.waitForSelector("h1");
      await page
        .getByRole("textbox", { name: "Сервер SSH", exact: true })
        .fill("127.0.0.1");
      await page
        .getByRole("spinbutton", { name: "Порт SSH", exact: true })
        .fill(String(port));
      await page
        .getByRole("textbox", { name: "Пользователь SSH", exact: true })
        .fill(os.userInfo().username);
      await page.evaluate((identity) => {
        const saved = JSON.parse(
          localStorage.getItem("svetoch.migration.profile.v1") || "{}",
        );
        saved.ssh = {
          host: "127.0.0.1",
          port: document.querySelector('[aria-label="Порт SSH"]').value,
          user: document.querySelector('[aria-label="Пользователь SSH"]').value,
          privateKey: identity,
        };
        localStorage.setItem(
          "svetoch.migration.profile.v1",
          JSON.stringify(saved),
        );
      }, identity);
      await page.reload();
      const check = page.getByRole("button", {
        name: "Проверить подключение",
        exact: true,
      });
      assert.equal(await check.isEnabled(), false);
      const noSsh = await page.evaluate(() => window.desktop.testDatabase({}));
      assert.equal(noSsh.ok, false);
      assert.match(noSsh.message, /Сначала откройте SSH/);
      await page
        .getByRole("textbox", { name: "Хост БД", exact: true })
        .fill("127.0.0.1");
      await page
        .getByRole("spinbutton", { name: "Порт БД", exact: true })
        .fill(String(backend.port));
      await page
        .getByRole("textbox", { name: "Имя базы", exact: true })
        .fill("abis");
      await page
        .getByRole("textbox", { name: "Пользователь БД", exact: true })
        .fill("migration");
      await page
        .getByRole("textbox", { name: "Пароль БД", exact: true })
        .fill("test-only-secret");
      await page
        .getByRole("combobox", { name: "SSL-режим", exact: true })
        .selectOption("disable");
      await page
        .getByRole("button", { name: "Открыть SSH", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Отключить", exact: true })
        .waitFor();
      const control = await application.evaluate(
        () => globalThis.testControlPath,
      );
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(control) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(fs.existsSync(control), `SSH master not ready: ${daemonError}`);
      await check.click();
      await page
        .getByRole("status")
        .filter({ hasText: "Соединение с PostgreSQL установлено" })
        .waitFor();
      if (process.env.MIGRATION_DB_SCREENSHOT) {
        await page.locator(".database-result").scrollIntoViewIfNeeded();
        await page.screenshot({ path: process.env.MIGRATION_DB_SCREENSHOT });
      }
      assert.equal(backend.connections, 1);
      assert.deepEqual(backend.passwords, ["test-only-secret"]);
      assert.match(
        await page.locator(".database-result").innerText(),
        /PostgreSQL 16.4/,
      );
      await page
        .getByRole("textbox", { name: "Пароль БД", exact: true })
        .fill("changed-password");
      assert.equal(await page.locator(".database-result").count(), 0);
      backend.reject = true;
      await check.click();
      await page
        .getByRole("alert")
        .filter({ hasText: "password authentication failed" })
        .waitFor();
      await page
        .getByRole("textbox", { name: "Имя базы", exact: true })
        .fill("other_database");
      assert.equal(await page.locator(".database-result").count(), 0);
      await page
        .getByRole("button", { name: "Отключить", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Открыть SSH", exact: true })
        .waitFor();
      assert.equal(await check.isEnabled(), false);
      assert.equal(fs.existsSync(control), false);
    } finally {
      await application?.close();
      if (daemon && daemon.exitCode === null) {
        daemon.kill();
        await new Promise((resolve) => daemon.once("exit", resolve));
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
