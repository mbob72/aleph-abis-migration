import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TerminalSquare, Eraser, LockKeyhole } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

/** Отображает PTY и передаёт ввод в SSH. DOC-PREVIEW:/docs/architecture.md#terminal */
export function TerminalPane({
  running,
  onExit,
}: {
  running: boolean;
  onExit: (code: number) => void;
}) {
  const [tab, setTab] = useState<"ssh" | "commands">("ssh");
  const [commands, setCommands] = useState("");
  const commandSurface = useRef<HTMLPreElement>(null);
  useEffect(
    () =>
      window.desktop?.onOperationEvent((event) => {
        const text =
          event.kind === "command"
            ? `\n$ ${event.text}\n`
            : event.kind === "finished"
              ? `\n[${event.text}]\n`
              : event.text;
        setCommands((previous) => (previous + text).slice(-200000));
        setTab("commands");
      }),
    [],
  );
  useEffect(() => {
    if (commandSurface.current)
      commandSurface.current.scrollTop = commandSurface.current.scrollHeight;
  }, [commands, tab]);
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const exitHandler = useRef(onExit);
  exitHandler.current = onExit;
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: '"SFMono-Regular", Consolas, monospace',
      lineHeight: 1.5,
      scrollback: 5000,
      theme: {
        background: "#141b28",
        foreground: "#ccd5e4",
        cursor: "#a9c3ff",
        selectionBackground: "#344a70",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current!);
    terminal.current = term;
    term.writeln("\x1b[38;2;154;181;224mСветоч / SSH-терминал\x1b[0m\r\n");
    term.writeln("Укажите сервер и пользователя,");
    term.writeln("затем нажмите «Открыть SSH».\r\n");
    term.writeln("Здесь появится настоящий вывод SSH.");
    if (!window.desktop)
      term.writeln(
        "\r\nБраузерный просмотр: SSH доступен\r\nв приложении Electron.",
      );
    const input = term.onData((data) => window.desktop?.write(data));
    const removeData = window.desktop?.onData((data) => term.write(data));
    const removeExit = window.desktop?.onExit((code) => {
      term.writeln(`\r\n\x1b[90m[SSH завершён, код ${code}]\x1b[0m`);
      exitHandler.current(code);
    });
    const observer = new ResizeObserver(() => {
      if (!container.current?.clientWidth) return;
      fit.fit();
      window.desktop?.resize(term.cols, term.rows);
    });
    observer.observe(container.current!);
    return () => {
      observer.disconnect();
      input.dispose();
      removeData?.();
      removeExit?.();
      term.dispose();
      terminal.current = null;
    };
  }, []);
  useEffect(() => {
    if (running) {
      terminal.current?.writeln("\r\n── Новый SSH-сеанс ──\r\n");
      terminal.current?.focus();
      window.desktop?.resize(
        terminal.current?.cols ?? 80,
        terminal.current?.rows ?? 24,
      );
    }
  }, [running]);
  return (
    <aside className="terminal-pane">
      <div className="terminal-heading">
        <span>
          <TerminalSquare size={16} /> Терминал
        </span>
        <button
          className="icon-button"
          title="Очистить терминал"
          aria-label="Очистить терминал"
          onClick={() =>
            tab === "ssh" ? terminal.current?.clear() : setCommands("")
          }
        >
          <Eraser size={15} />
        </button>
      </div>
      <div className="terminal-tabs">
        <button
          className={tab === "ssh" ? "active" : ""}
          onClick={() => setTab("ssh")}
        >
          SSH
        </button>
        <button
          className={tab === "commands" ? "active" : ""}
          onClick={() => setTab("commands")}
        >
          Команды
        </button>
      </div>
      <div className="terminal-tab">
        <span className={running ? "status-dot live" : "status-dot"} />
        <span>SSH / {running ? "сеанс запущен" : "ожидание подключения"}</span>
        <kbd>1</kbd>
      </div>
      <div className="terminal-surface" hidden={tab !== "ssh"}>
        <div className="terminal-host" ref={container} />
      </div>
      <pre
        className="operation-output"
        ref={commandSurface}
        hidden={tab !== "commands"}
      >
        {commands || "Здесь появятся команды проверок и обработки НЗ."}
      </pre>
      <div className="terminal-tip">
        <LockKeyhole size={16} />
        <p>
          Подтверждение ключа сервера и запрос пароля отображаются здесь.
          Успешный вход проверяйте по выводу SSH.
        </p>
      </div>
      <div className="terminal-footer">
        <span>OpenSSH</span>
        <span>Интерактивный сеанс</span>
      </div>
    </aside>
  );
}
