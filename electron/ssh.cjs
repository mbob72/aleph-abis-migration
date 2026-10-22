const path = require("node:path");

/** Проверяет параметры до запуска SSH. DOC-PREVIEW:/docs/architecture.md#ssh */
function buildSshArgs(profile) {
  if (!profile || typeof profile !== "object")
    throw new Error("Не заданы настройки SSH.");
  const { host, user, port, privateKey } = profile;
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
  if (privateKey) {
    validatePrivateKeyPath(privateKey);
    args.push("-o", "IdentitiesOnly=yes", "-i", privateKey);
  }
  args.push("-l", user, host);
  return args;
}
/** Проверяет путь без чтения содержимого ключа. DOC-PREVIEW:/docs/architecture.md#ssh */
function validatePrivateKeyPath(privateKey) {
  if (
    typeof privateKey !== "string" ||
    !path.isAbsolute(privateKey) ||
    /[\r\n\0]/.test(privateKey)
  )
    throw new Error("Выберите абсолютный путь к приватному SSH-ключу.");
  if (privateKey.toLowerCase().endsWith(".pub"))
    throw new Error(
      "Это публичный ключ .pub. Выберите соответствующий приватный файл без .pub.",
    );
}
module.exports = { buildSshArgs, validatePrivateKeyPath };
