const path = require("node:path");

/** Проверяет параметры до запуска SSH. DOC-PREVIEW:/docs/architecture.md#ssh */
function buildSshArgs(profile) {
  if (!profile || typeof profile !== "object")
    throw new Error("Не заданы настройки SSH.");
  const { host, user, port, publicKey } = profile;
  if (
    typeof host !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(host) ||
    host.length > 253
  )
    throw new Error("Укажите имя сервера или IP без пробелов и SSH-опций.");
  if (typeof user !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(user))
    throw new Error("Укажите корректное имя пользователя SSH.");
  if (
    !Number.isInteger(Number(port)) ||
    Number(port) < 1 ||
    Number(port) > 65535
  )
    throw new Error("Порт SSH должен быть от 1 до 65535.");
  const args = [
    "-tt",
    "-p",
    String(Number(port)),
    "-o",
    "StrictHostKeyChecking=ask",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  if (publicKey) {
    if (
      typeof publicKey !== "string" ||
      !path.isAbsolute(publicKey) ||
      !publicKey.endsWith(".pub") ||
      /[\r\n\0]/.test(publicKey)
    )
      throw new Error("Выберите абсолютный путь к публичному ключу .pub.");
    // OpenSSH умеет сопоставить публичный ключ с приватным ключом в агенте.
    args.push("-o", "IdentitiesOnly=yes", "-i", publicKey);
  }
  args.push("-l", user, host);
  return args;
}
module.exports = { buildSshArgs };
