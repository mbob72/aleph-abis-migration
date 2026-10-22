const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const pty = require("node-pty");
const fs = require("node:fs");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { runAuthorityAction } = require("./authorities.cjs");
const { testDatabaseConnection } = require("./database.cjs");
const { buildSshArgs, validatePrivateKeyPath } = require("./ssh.cjs");
let window;
let session;
let sshContext;
let databaseCheck;
let authorityOperation;

/** Создаёт изолированное окно оператора. DOC-PREVIEW:/docs/architecture.md#desktop */
function createWindow() {
  window = new BrowserWindow({
    width: 1510,
    height: 980,
    minWidth: 1120,
    minHeight: 760,
    title: "Светоч · Миграция",
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Перезагрузка интерфейса не должна оставлять SSH без управляющего терминала.
  window.webContents.on(
    "did-start-navigation",
    (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) stopSession();
    },
  );
  window.webContents.on("render-process-gone", stopSession);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.loadFile(path.join(__dirname, "../dist/index.html"));
  window.on("closed", () => {
    stopSession();
    window = undefined;
  });
}
/** Проверяет источник каждого привилегированного запроса. */
function assertSender(event) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error("Запрос из неизвестного окна.");
}
/** Закрывает только локальный SSH-процесс. DOC-PREVIEW:/docs/architecture.md#ssh */
function stopSession() {
  const previous = session;
  session = undefined;
  releaseSshContext();
  previous?.kill();
}

/** Отменяет проверку БД и удаляет только сокет нашей сессии. DOC-PREVIEW:/docs/architecture.md#database */
function releaseSshContext() {
  databaseCheck?.abort();
  authorityOperation?.abort();
  const previous = sshContext;
  sshContext = undefined;
  if (previous) fs.rmSync(previous.directory, { recursive: true, force: true });
}

app.whenReady().then(() => {
  ipcMain.handle("key:choose", async (event) => {
    assertSender(event);
    const result = await dialog.showOpenDialog(window, {
      title: "Выберите приватный SSH-ключ (без .pub)",
      defaultPath: path.join(app.getPath("home"), ".ssh"),
      properties: ["openFile", "showHiddenFiles"],
      filters: [
        { name: "Все файлы (приватный ключ без .pub)", extensions: ["*"] },
      ],
    });
    if (result.canceled) return null;
    const selected = result.filePaths[0];
    validatePrivateKeyPath(selected);
    return selected;
  });
  ipcMain.handle("ssh:connect", (event, profile) => {
    assertSender(event);
    if (session) throw new Error("Сначала завершите текущий SSH-сеанс.");
    const args = buildSshArgs(profile);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sv-"));
    const controlPath = path.join(directory, "s");
    sshContext = { directory, controlPath, profile: { ...profile } };
    let current;
    try {
      current = pty.spawn(
        "/usr/bin/ssh",
        [
          "-o",
          "ControlMaster=yes",
          "-o",
          "ControlPersist=no",
          "-S",
          controlPath,
          ...args,
        ],
        {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: app.getPath("home"),
          env: { ...process.env, TERM: "xterm-256color" },
        },
      );
    } catch (error) {
      releaseSshContext();
      throw error;
    }
    session = current;
    current.onData((data) => {
      if (session === current && window && !window.isDestroyed())
        window.webContents.send("ssh:data", data);
    });
    current.onExit(({ exitCode }) => {
      if (session !== current) return;
      session = undefined;
      releaseSshContext();
      if (window && !window.isDestroyed())
        window.webContents.send("ssh:exit", exitCode);
    });
    return { state: "started" };
  });
  ipcMain.handle("authorities:run", async (event, request) => {
    assertSender(event);
    const failure = (message) => ({ ok: false, message, durationMs: 0 });
    if (authorityOperation)
      return failure("Другая команда НЗ ещё выполняется.");
    if (!session || !sshContext)
      return failure("Сначала откройте SSH и завершите вход в терминале.");
    if (
      !["host", "port", "user", "privateKey"].every(
        (key) => request?.profile?.ssh?.[key] === sshContext.profile[key],
      )
    )
      return failure("Параметры SSH изменились. Переподключитесь к серверу.");
    try {
      if (!fs.statSync(sshContext.controlPath).isSocket()) throw new Error();
    } catch {
      return failure("SSH ещё не готов. Завершите вход в терминале.");
    }
    const controller = new AbortController();
    const id = randomUUID();
    authorityOperation = controller;
    const emit = (data) => {
      if (window && !window.isDestroyed())
        window.webContents.send("operations:event", { id, ...data });
    };
    try {
      const result = await runAuthorityAction({
        action: request?.action,
        profile: {
          ssh: sshContext.profile,
          source: request?.profile?.source,
          processing: request?.profile?.processing,
        },
        controlPath: sshContext.controlPath,
        signal: controller.signal,
        onEvent: emit,
      });
      emit({ kind: "finished", text: result.message });
      return result;
    } finally {
      if (authorityOperation === controller) authorityOperation = undefined;
    }
  });
  ipcMain.handle("database:test", async (event, request) => {
    assertSender(event);
    if (databaseCheck)
      return {
        ok: false,
        message: "Проверка БД уже выполняется.",
        durationMs: 0,
      };
    if (!session || !sshContext)
      return {
        ok: false,
        message: "Сначала откройте SSH и завершите вход в терминале.",
        durationMs: 0,
      };
    const matches = ["host", "port", "user", "privateKey"].every(
      (key) => request?.ssh?.[key] === sshContext.profile[key],
    );
    if (!matches)
      return {
        ok: false,
        message: "Параметры SSH изменились. Переподключитесь к серверу.",
        durationMs: 0,
      };
    try {
      if (!fs.statSync(sshContext.controlPath).isSocket()) throw new Error();
    } catch {
      return {
        ok: false,
        message:
          "SSH ещё не готов. Завершите вход в терминале и повторите проверку.",
        durationMs: 0,
      };
    }
    const controller = new AbortController();
    databaseCheck = controller;
    try {
      return await testDatabaseConnection({
        ssh: sshContext.profile,
        database: request?.database,
        password: request?.password,
        controlPath: sshContext.controlPath,
        signal: controller.signal,
      });
    } finally {
      if (databaseCheck === controller) databaseCheck = undefined;
    }
  });
  ipcMain.handle("ssh:disconnect", (event) => {
    assertSender(event);
    stopSession();
  });
  ipcMain.on("ssh:write", (event, data) => {
    assertSender(event);
    if (typeof data === "string" && data.length <= 65536) session?.write(data);
  });
  ipcMain.on("ssh:resize", (event, size) => {
    assertSender(event);
    if (
      Number.isInteger(size?.cols) &&
      Number.isInteger(size?.rows) &&
      size.cols >= 2 &&
      size.cols <= 500 &&
      size.rows >= 1 &&
      size.rows <= 300
    )
      session?.resize(size.cols, size.rows);
  });
  createWindow();
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});
app.on("window-all-closed", () => {
  stopSession();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", stopSession);
