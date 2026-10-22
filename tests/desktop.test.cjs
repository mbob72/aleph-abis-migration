const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
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
      await page
        .getByRole("button", { name: "Открыть SSH", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "SSH-сеанс завершён с кодом 255." })
        .waitFor({ timeout: 5000 });
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
        "",
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
