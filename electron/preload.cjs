const { contextBridge, ipcRenderer } = require("electron");
/** Узкий мост терминала без доступа React к Node.js. DOC-PREVIEW:/docs/architecture.md#desktop */
contextBridge.exposeInMainWorld("desktop", {
  choosePrivateKey: () => ipcRenderer.invoke("key:choose"),
  connect: (profile) => ipcRenderer.invoke("ssh:connect", profile),
  testDatabase: (request) => ipcRenderer.invoke("database:test", request),
  runAuthority: (request) => ipcRenderer.invoke("authorities:run", request),
  onOperationEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("operations:event", listener);
    return () => ipcRenderer.removeListener("operations:event", listener);
  },
  disconnect: () => ipcRenderer.invoke("ssh:disconnect"),
  write: (data) => ipcRenderer.send("ssh:write", data),
  resize: (cols, rows) => ipcRenderer.send("ssh:resize", { cols, rows }),
  onData: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("ssh:data", listener);
    return () => ipcRenderer.removeListener("ssh:data", listener);
  },
  onExit: (callback) => {
    const listener = (_event, code) => callback(code);
    ipcRenderer.on("ssh:exit", listener);
    return () => ipcRenderer.removeListener("ssh:exit", listener);
  },
});
