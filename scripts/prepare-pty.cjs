const fs = require("node:fs");
const path = require("node:path");

/** Восстанавливает executable у helper из npm-пакета node-pty. DOC-PREVIEW:/docs/architecture.md#pty-install */
function preparePty() {
  if (process.platform === "win32") return;
  const root = path.dirname(require.resolve("node-pty/package.json"));
  // Проверяются только известные каталоги нашей зависимости; чужие файлы не меняются.
  for (const relative of [
    "build/Release",
    "build/Debug",
    `prebuilds/${process.platform}-${process.arch}`,
  ]) {
    const helper = path.join(root, relative, "spawn-helper");
    if (fs.existsSync(helper))
      fs.chmodSync(helper, fs.statSync(helper).mode | 0o111);
  }
}
preparePty();
