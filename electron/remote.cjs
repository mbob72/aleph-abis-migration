const { spawn } = require("node:child_process");
const { buildSshArgs } = require("./ssh.cjs");

/** Экранирует один аргумент POSIX shell на удалённом сервере. DOC-PREVIEW:/docs/architecture.md#authority-commands */
function quote(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}
function command(argv) {
  return argv.map(quote).join(" ");
}

/** Исполняет ограниченную команду в отдельном SSH-канале с потоковым выводом. DOC-PREVIEW:/docs/architecture.md#remote-executor */
function runRemoteCommand(
  {
    ssh,
    controlPath,
    argv,
    signal,
    onEvent,
    timeoutMs = 15000,
    maxBytes = 524288,
  },
  { spawnProcess = spawn } = {},
) {
  buildSshArgs(ssh);
  if (
    typeof controlPath !== "string" ||
    !controlPath.startsWith("/") ||
    /[\r\n\0]/.test(controlPath)
  )
    throw new Error("SSH ещё не готов.");
  const remote = command(argv);
  return new Promise((resolve) => {
    let child,
      timer,
      finished = false,
      interrupted = "",
      size = 0,
      stdout = "",
      stderr = "";
    const finish = (exitCode, message) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({
        ok: exitCode === 0 && !interrupted,
        exitCode,
        command: remote,
        stdout,
        stderr,
        message:
          interrupted ||
          message ||
          (exitCode === 0
            ? "Команда выполнена."
            : stderr.trim() || `Код завершения ${exitCode}`),
      });
    };
    const abort = () => {
      interrupted =
        "SSH-команда прервана. Серверная задача могла продолжить работу.";
      child?.kill();
      finish(null, interrupted);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    onEvent?.({ kind: "command", text: remote });
    try {
      child = spawnProcess(
        "/usr/bin/ssh",
        [
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
          "-T",
          "-p",
          String(Number(ssh.port)),
          "-l",
          ssh.user,
          ssh.host,
          remote,
        ],
        { stdio: ["ignore", "pipe", "pipe"], shell: false },
      );
    } catch (error) {
      finish(null, error.message);
      return;
    }
    timer = setTimeout(() => {
      interrupted =
        "Время ожидания команды истекло. Проверьте состояние worker.";
      child.kill();
      finish(null, interrupted);
    }, timeoutMs);
    for (const [pipe, kind] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ]) {
      pipe.setEncoding("utf8");
      pipe.on("data", (text) => {
        if (finished) return;
        size += Buffer.byteLength(text);
        if (size > maxBytes) {
          interrupted =
            "Вывод команды превышает допустимый размер. Откройте лог вручную.";
          child.kill();
          finish(null, interrupted);
          return;
        }
        if (kind === "stdout") stdout += text;
        else stderr += text;
        onEvent?.({ kind, text });
      });
      pipe.on("error", (error) => {
        child.kill();
        finish(null, error.message);
      });
    }
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (code) => finish(code));
  });
}
module.exports = { quote, command, runRemoteCommand };
