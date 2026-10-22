const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const pty = require("node-pty");
const { buildSshArgs } = require("./ssh.cjs");
let window;
let session;

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
  previous?.kill();
}

app.whenReady().then(() => {
  ipcMain.handle("key:choose", async (event) => {
    assertSender(event);
    const result = await dialog.showOpenDialog(window, {
      title: "Выберите публичный SSH-ключ",
      defaultPath: path.join(app.getPath("home"), ".ssh"),
      properties: ["openFile", "showHiddenFiles"],
      filters: [{ name: "Публичный ключ", extensions: ["pub"] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("ssh:connect", (event, profile) => {
    assertSender(event);
    if (session) throw new Error("Сначала завершите текущий SSH-сеанс.");
    const args = buildSshArgs(profile);
    const current = pty.spawn("/usr/bin/ssh", args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: app.getPath("home"),
      env: { ...process.env, TERM: "xterm-256color" },
    });
    session = current;
    current.onData((data) => {
      if (session === current && window && !window.isDestroyed())
        window.webContents.send("ssh:data", data);
    });
    current.onExit(({ exitCode }) => {
      if (session !== current) return;
      session = undefined;
      if (window && !window.isDestroyed())
        window.webContents.send("ssh:exit", exitCode);
    });
    return { state: "started" };
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
