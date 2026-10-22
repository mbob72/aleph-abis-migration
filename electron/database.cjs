const { spawn } = require("node:child_process");
const { Duplex } = require("node:stream");
const { Client } = require("pg");
const { buildSshArgs } = require("./ssh.cjs");

const SQL = `SELECT current_database() AS database, current_user AS username,
  current_setting('server_version') AS version, inet_server_addr()::text AS address,
  inet_server_port() AS port,
  (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl`;

/** Проверяет форму до открытия канала. DOC-PREVIEW:/docs/architecture.md#database */
function validateDatabase(database, password) {
  if (!database || typeof database !== "object")
    throw new Error("Не заданы параметры БД.");
  for (const field of ["host", "name", "user", "ssl"]) {
    if (
      typeof database[field] !== "string" ||
      !database[field] ||
      /[\r\n\0]/.test(database[field]) ||
      database[field].length > 512
    )
      throw new Error(
        "Заполните корректные хост, имя базы и пользователя PostgreSQL.",
      );
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(database.host))
    throw new Error("Хост БД должен быть именем сервера или IP без пробелов.");
  if (
    !/^\d+$/.test(String(database.port)) ||
    Number(database.port) < 1 ||
    Number(database.port) > 65535
  )
    throw new Error("Порт БД должен быть от 1 до 65535.");
  if (!["disable", "prefer", "require", "verify-full"].includes(database.ssl))
    throw new Error("Недопустимый SSL-режим БД.");
  if (
    typeof password !== "string" ||
    password.includes("\0") ||
    password.length > 8192
  )
    throw new Error("Некорректный пароль БД.");
}

/** Формирует только TCP-перенаправление через существующий master. DOC-PREVIEW:/docs/architecture.md#database */
function buildDatabaseSshArgs(ssh, database, controlPath) {
  buildSshArgs(ssh);
  if (
    typeof controlPath !== "string" ||
    !controlPath.startsWith("/") ||
    /[\r\n\0]/.test(controlPath)
  )
    throw new Error("Нет управляющего сокета SSH.");
  const host = database.host.includes(":")
    ? `[${database.host}]`
    : database.host;
  // ProxyCommand=false запрещает отдельный вход при исчезновении master-сокета.
  return [
    "-S",
    controlPath,
    "-o",
    "ControlMaster=no",
    "-o",
    "ProxyCommand=false",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-p",
    String(Number(ssh.port)),
    "-l",
    ssh.user,
    "-W",
    `${host}:${Number(database.port)}`,
    ssh.host,
  ];
}

/** Адаптирует бинарные stdin/stdout SSH к сокету pg, сохраняя backpressure. DOC-PREVIEW:/docs/architecture.md#database-stream */
class SshDatabaseStream extends Duplex {
  constructor(args, spawnProcess = spawn) {
    super({ allowHalfOpen: false });
    this.args = args;
    this.spawnProcess = spawnProcess;
    this.diagnostic = "";
  }
  connect() {
    try {
      this.child = this.spawnProcess("/usr/bin/ssh", this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
    } catch (error) {
      // Даём pg установить обработчики до ошибки запуска процесса.
      queueMicrotask(() => this.destroy(error));
      return this;
    }
    this.child.once("spawn", () => {
      if (!this.destroyed) this.emit("connect");
    });
    this.child.once("error", (error) => this.destroy(error));
    this.child.stdout.on("data", (chunk) => {
      if (!this.push(chunk)) this.child.stdout.pause();
    });
    this.child.stdout.once("end", () => this.push(null));
    for (const pipe of [this.child.stdin, this.child.stdout, this.child.stderr])
      pipe.on("error", (error) => this.destroy(error));
    this.child.stderr.on("data", (chunk) => {
      this.diagnostic = (this.diagnostic + chunk.toString("utf8")).slice(-4096);
    });
    this.child.once("close", (code) => {
      if (code && !this.destroyed)
        this.destroy(
          new Error(`SSH: ${this.diagnostic.trim() || `код ${code}`}`),
        );
    });
    return this;
  }
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  _read() {
    this.child?.stdout.resume();
  }
  _write(chunk, encoding, callback) {
    this.child.stdin.write(chunk, encoding, callback);
  }
  _final(callback) {
    this.child?.stdin.end();
    callback();
  }
  _destroy(error, callback) {
    this.child?.kill();
    callback(error);
  }
}

/** Выполняет один read-only SELECT, закрывает канал при любом исходе. DOC-PREVIEW:/docs/architecture.md#database */
async function testDatabaseConnection(
  { ssh, database, password, controlPath, signal },
  { spawnProcess = spawn, timeoutMs = 10000 } = {},
) {
  const started = Date.now();
  let client;
  let stream;
  let timer;
  let interrupted;
  let lastError;
  const interrupt = (message) => {
    interrupted = new Error(message);
    stream?.destroy(interrupted);
  };
  const abort = () => interrupt("Проверка отменена: SSH-соединение закрыто.");
  try {
    validateDatabase(database, password);
    const args = buildDatabaseSshArgs(ssh, database, controlPath);
    if (signal?.aborted)
      throw new Error("Проверка отменена: SSH-соединение закрыто.");
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () => interrupt("Время проверки подключения истекло."),
      timeoutMs,
    );
    // prefer повторяется без TLS только при явном ответе PostgreSQL «SSL не поддерживается».
    for (const ssl of database.ssl === "prefer"
      ? [true, false]
      : [database.ssl !== "disable"]) {
      if (interrupted) throw interrupted;
      stream = new SshDatabaseStream(args, spawnProcess);
      client = new Client({
        host: database.host,
        port: Number(database.port),
        database: database.name,
        user: database.user,
        password: () => password,
        stream,
        ssl: ssl
          ? { rejectUnauthorized: database.ssl === "verify-full" }
          : false,
        connectionTimeoutMillis: timeoutMs,
        query_timeout: timeoutMs,
        application_name: "svetoch-connection-test",
        options:
          "-c default_transaction_read_only=on -c statement_timeout=5000",
      });
      // Сохраняем TLS-диагностику: закрытие нижнего потока иногда приходит раньше ошибки сертификата.
      client.connection.on("sslconnect", () => {
        client.connection.stream.on("error", (error) => {
          lastError = error;
        });
      });
      // Ошибка потока между connect и query не должна стать необработанным событием.
      client.on("error", (error) => {
        lastError = error;
      });
      try {
        await client.connect();
        const result = await client.query(SQL);
        if (interrupted) throw interrupted;
        const row = result.rows[0];
        if (!row?.database || !row?.username || !row?.version)
          throw new Error("PostgreSQL вернул неполный результат проверки.");
        return {
          ok: true,
          message: "Соединение с PostgreSQL установлено.",
          details: row,
          durationMs: Date.now() - started,
        };
      } catch (error) {
        if (
          database.ssl !== "prefer" ||
          !ssl ||
          interrupted ||
          error.message !== "The server does not support SSL connections"
        )
          throw error;
      } finally {
        stream.destroy();
        await client.end().catch(() => {});
        client = undefined;
      }
    }
    throw lastError || new Error("Не удалось проверить PostgreSQL.");
  } catch (error) {
    const diagnostic = /terminated|closed|ended unexpectedly/i.test(
      error.message,
    )
      ? stream?.diagnostic.trim()
      : "";
    const raw = String(
      interrupted?.message ||
        diagnostic ||
        lastError?.message ||
        error.message ||
        error,
    );
    const message = password ? raw.split(password).join("[скрыто]") : raw;
    return {
      ok: false,
      message: message.slice(0, 1000),
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    stream?.destroy();
  }
}
module.exports = {
  SQL,
  validateDatabase,
  buildDatabaseSshArgs,
  SshDatabaseStream,
  testDatabaseConnection,
};
