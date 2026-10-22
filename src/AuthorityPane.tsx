import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Box,
  CheckCircle2,
  ChevronRight,
  FileText,
  FolderOpen,
  Play,
  RefreshCw,
  Server,
} from "lucide-react";
import type {
  AuthorityAction,
  AuthorityResult,
  Profile,
  WorkerState,
  ContainerState,
} from "./types";
import { effectiveSources } from "./profile";
import { AuthorityImportPane } from "./AuthorityImportPane";
import { TaskMonitor } from "./TaskMonitor";
import {
  loadHistory,
  mergeObservation,
  saveHistory,
  type TaskRecord,
} from "./taskObservation";

type Props = {
  profile: Profile;
  connected: boolean;
  step: number;
  onStep: (step: number) => void;
  onUpdate: (field: string, value: string) => void;
  onSettings: () => void;
};
/** Управляет двумя шагами НЗ и отображает фактический статус worker. DOC-PREVIEW:/docs/architecture.md#authority-ui */
export function AuthorityPane({
  profile,
  connected,
  step,
  onStep,
  onUpdate,
  onSettings,
}: Props) {
  const [container, setContainer] = useState<ContainerState | null>(null);
  const [worker, setWorker] = useState<WorkerState | null>(null);
  const [result, setResult] = useState<AuthorityResult | null>(null);
  const [resultAction, setResultAction] = useState<AuthorityAction | null>(
    null,
  );
  const [pending, setPending] = useState<AuthorityAction | null>(null);
  const historyKey =
    "svetoch.tasks.v1:" +
    JSON.stringify([
      profile.ssh.host,
      profile.ssh.port,
      profile.ssh.user,
      profile.processing.container || "auth-docs-relations-worker",
    ]);
  const [archive, setArchive] = useState<{
    key: string;
    records: TaskRecord[];
  }>(() => ({ key: historyKey, records: loadHistory(historyKey) }));
  const history = archive.key === historyKey ? archive.records : [];
  useEffect(() => {
    setArchive({ key: historyKey, records: loadHistory(historyKey) });
  }, [historyKey]);
  useEffect(() => {
    if (archive.key === historyKey) saveHistory(historyKey, archive.records);
  }, [archive, historyKey]);
  const epoch = useRef(0);
  const [needsStatus, setNeedsStatus] = useState(false);
  const sources = effectiveSources(profile.source);
  const fingerprint = JSON.stringify({
    ssh: profile.ssh,
    container: profile.processing.container,
    watcher: profile.processing.watcher,
    connected,
  });
  const settingsFingerprint = JSON.stringify({
    ssh: profile.ssh,
    processing: profile.processing,
    source: sources,
    connected,
  });
  const latestSettings = useRef(settingsFingerprint);
  latestSettings.current = settingsFingerprint;
  useEffect(() => {
    epoch.current++;
    setContainer(null);
    setWorker(null);
    setResult(null);
  }, [fingerprint]);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  const ready = Boolean(container?.state.Running && worker);
  const canStart = ready && !worker?.busy && worker?.accepting && !needsStatus;
  async function run(action: AuthorityAction) {
    if (!window.desktop) {
      setResult({
        ok: false,
        message: "Команды доступны в приложении Electron.",
        durationMs: 0,
      });
      return;
    }
    const current = ++epoch.current;
    const submittedSettings = settingsFingerprint;
    setPending(action);
    setResultAction(action);
    setResult(null);
    try {
      const next = await window.desktop.runAuthority({
        action,
        profile: {
          ssh: profile.ssh,
          source: profile.source,
          processing: profile.processing,
        },
      });
      if (
        current !== epoch.current ||
        submittedSettings !== latestSettings.current
      )
        return;
      setResult(next);
      setArchive((previous) => ({
        key: historyKey,
        records: mergeObservation(
          previous.key === historyKey
            ? previous.records
            : loadHistory(historyKey),
          action,
          next,
          new Date().toISOString(),
        ),
      }));
      if (next.ok && next.observation) setWorker(next.observation.worker);
      if (next.ok && next.checkpointUpdates) {
        for (const [field, value] of Object.entries(next.checkpointUpdates))
          if (typeof value === "string") onUpdate(field, value);
      }
      if (next.uncertain) setNeedsStatus(true);
      if (next.ok && next.importIdRsl10 && next.stageReportRsl10) {
        onUpdate("importIdRsl10", next.importIdRsl10);
        onUpdate("stageReportRsl10", next.stageReportRsl10);
      }
      if (next.ok && action === "worker-status") setNeedsStatus(false);
      if (next.ok && action === "container-status")
        setContainer(next.data as ContainerState);
      if (
        next.ok &&
        (action === "worker-status" ||
          action.startsWith("prepare-") ||
          action === "stage-rsl10" ||
          [
            "analyze-rsl10",
            "dry-run-rsl10",
            "apply-rsl10",
            "verify-rsl10",
            "stage-rsl11",
            "analyze-rsl11",
            "dry-run-rsl11",
            "apply-rsl11",
            "verify-rsl11",
          ].includes(action))
      )
        setWorker(next.data as WorkerState);
      if (!next.ok && action === "container-status") setContainer(null);
      if (!next.ok && action === "worker-status") setWorker(null);
    } catch {
      const uncertain =
        action.startsWith("prepare-") ||
        action === "stage-rsl10" ||
        [
          "analyze-rsl10",
          "dry-run-rsl10",
          "apply-rsl10",
          "verify-rsl10",
          "stage-rsl11",
          "analyze-rsl11",
          "dry-run-rsl11",
          "apply-rsl11",
          "verify-rsl11",
        ].includes(action);
      if (uncertain) setNeedsStatus(true);
      if (current === epoch.current)
        setResult({
          ok: false,
          message:
            "Не удалось получить результат. Перед повторным запуском обновите статус worker.",
          durationMs: 0,
          uncertain,
        });
    } finally {
      setPending(null);
    }
  }
  const disabled = Boolean(pending) || !connected;
  return (
    <div className="authority-flow">
      <div className="folder-heading">
        <FolderOpen size={17} />
        <span>Нормативные записи</span>
        <ChevronRight size={14} />
        <strong>{step === 1 ? "Проверка контейнера" : "Процессинг"}</strong>
      </div>
      <div className="workflow-stepper" aria-label="Этапы нормативных записей">
        <button
          className={step === 1 ? "current" : ""}
          aria-current={step === 1 ? "step" : undefined}
          onClick={() => onStep(1)}
        >
          <span>{ready ? <CheckCircle2 size={17} /> : "1"}</span>
          <div>
            <strong>Проверка контейнера</strong>
            <small>Окружение и доступность worker</small>
          </div>
        </button>
        <i />
        <button
          className={step === 2 ? "current" : ""}
          aria-current={step === 2 ? "step" : undefined}
          onClick={() => onStep(2)}
        >
          <span>2</span>
          <div>
            <strong>Процессинг</strong>
            <small>Подготовка НЗ и результаты</small>
          </div>
        </button>
      </div>
      {!connected && (
        <div className="notice">
          <Server size={16} />
          <span>
            Откройте SSH в разделе «Подключения» и завершите вход в терминале.
          </span>
        </div>
      )}
      {step === 1 ? (
        <>
          <section className="card workflow-card">
            <div className="section-heading">
              <div className="section-icon">
                <Box size={20} />
              </div>
              <div>
                <h2>Контейнер обработки НЗ</h2>
                <p>Проверки читают состояние и не перезапускают контейнеры.</p>
              </div>
            </div>
            <div className="form-grid source-grid">
              <label className="field">
                <span className="field-label">Контейнер worker</span>
                <input
                  aria-label="Контейнер worker"
                  value={profile.processing.container}
                  disabled={Boolean(pending)}
                  onChange={(e) => onUpdate("container", e.target.value)}
                  placeholder="auth-docs-relations-worker"
                />
              </label>
              <label className="field">
                <span className="field-label">Контейнер доставки</span>
                <input
                  aria-label="Контейнер доставки"
                  value={profile.processing.watcher}
                  disabled={Boolean(pending)}
                  onChange={(e) => onUpdate("watcher", e.target.value)}
                  placeholder="abis-deploy-watch"
                />
              </label>
            </div>
            <div className="command-buttons">
              <button
                className="button dark"
                disabled={disabled}
                onClick={() => run("container-status")}
              >
                <Box size={15} />
                {pending === "container-status"
                  ? "Проверяем…"
                  : "Статус контейнера"}
              </button>
              <button
                className="button secondary"
                disabled={disabled}
                onClick={() => run("worker-status")}
              >
                <RefreshCw size={15} />
                {pending === "worker-status" ? "Проверяем…" : "Статус worker"}
              </button>
              <button
                className="button secondary"
                disabled={disabled}
                onClick={() => run("delivery-status")}
              >
                Статус доставки
              </button>
              <button
                className="button secondary"
                disabled={disabled}
                onClick={() => run("help")}
              >
                Команды образа
              </button>
            </div>
            {container && (
              <div className="container-details">
                <span
                  className={container.state.Running ? "pill ready" : "pill"}
                >
                  {container.state.Running
                    ? "Контейнер запущен"
                    : "Контейнер остановлен"}
                </span>
                <code>{container.image}</code>
                <div className="mounts">
                  {container.mounts
                    .filter(
                      (m) =>
                        m.Destination === "/source" ||
                        m.Destination === "/work",
                    )
                    .map((m) => (
                      <div key={m.Destination}>
                        <span>{m.Source}</span>
                        <ArrowRight size={12} />
                        <code>{m.Destination}</code>
                      </div>
                    ))}
                </div>
              </div>
            )}
            {worker && (
              <p className="workflow-description">
                Worker: {worker.busy ? "занят" : "свободен"} ·{" "}
                {worker.accepting
                  ? "принимает задания"
                  : "приём заданий приостановлен"}
              </p>
            )}
            <div className="card-footer">
              <span>
                {ready
                  ? "Контейнер и worker проверены"
                  : "Проверьте контейнер и worker перед обработкой"}
              </span>
              <button
                className="button primary"
                disabled={!ready || Boolean(pending)}
                onClick={() => onStep(2)}
              >
                К процессингу
                <ArrowRight size={14} />
              </button>
            </div>
          </section>
        </>
      ) : (
        <>
          {worker?.task?.importId &&
            worker.task.importId !==
              (profile.processing.library === "RSL11"
                ? profile.processing.importIdRsl11
                : profile.processing.importIdRsl10) && (
              <div className="notice">
                <span>
                  Выбрана{" "}
                  {profile.processing.library === "RSL11" ? "RSL11" : "RSL10"}.
                  Последняя задача worker относится к другому импорту.
                  Наблюдение показывает её до запуска выбранной библиотеки.
                </span>
              </div>
            )}
          <AuthorityImportPane
            settings={profile.processing}
            disabled={disabled}
            canStart={Boolean(canStart)}
            onUpdate={onUpdate}
            run={run}
          />
          <section className="card workflow-card">
            <div className="section-heading">
              <div className="section-icon">
                <Play size={19} />
              </div>
              <div>
                <h2>Подготовка нормативных записей</h2>
                <p>Каждая кнопка запускает отдельную серверную задачу.</p>
              </div>
            </div>
            {!ready && (
              <div className="notice">
                <span>
                  Сначала проверьте контейнер и статус worker на первом шаге.
                </span>
                <button onClick={() => onStep(1)}>К проверке</button>
              </div>
            )}
            <div className="processing-sources">
              {(["RSL10", "RSL11"] as const).map((library) => (
                <div className="processing-row" key={library}>
                  <div className="library-icon">
                    <FileText size={18} />
                  </div>
                  <div className="processing-source">
                    <strong>{library}</strong>
                    <code>
                      {sources[library === "RSL10" ? "rsl10" : "rsl11"]}
                    </code>
                    <small>
                      Идентификатор:{" "}
                      {library === "RSL11" ? "rsl11-nafpn" : "numeric001"} ·
                      пустой FMT: reject
                    </small>
                  </div>
                  <button
                    className="button primary"
                    disabled={disabled || !canStart}
                    onClick={() =>
                      run(
                        library === "RSL10" ? "prepare-rsl10" : "prepare-rsl11",
                      )
                    }
                  >
                    <Play size={14} />
                    {pending === `prepare-${library.toLowerCase()}`
                      ? "Запускаем…"
                      : `Подготовить ${library}`}
                  </button>
                </div>
              ))}
            </div>
            <p className="workflow-description">
              RSL11: политика rsl11-nafpn проверяет совпадение номера префикса с
              001. Запускайте её для соответствующей выгрузки. Одновременно
              worker выполняет одну задачу.
            </p>
            <div className="workflow-path">
              <span>Каталог результатов из настроек</span>
              <code>{sources.output}</code>
              <small>
                Worker назначает собственный каталог
                /work/output/&lt;task.id&gt;. Фактический путь будет показан
                после запуска; поле настроек не перенастраивает worker.
              </small>
            </div>
            <div className="card-footer">
              <button className="button secondary" onClick={onSettings}>
                Изменить источники
              </button>
              <span>Подготовка пакета, без загрузки в БД</span>
            </div>
          </section>
          <TaskMonitor
            history={history}
            liveTaskId={worker?.task?.id}
            disabled={disabled}
            pending={pending}
            run={run}
          />
        </>
      )}
      {pending && (
        <div className="notice" role="status">
          Команда выполняется… Потоковый вывод — справа, во вкладке «Команды».
        </div>
      )}
      {result &&
        !(
          result.ok &&
          (result.observation || resultAction === "worker-status")
        ) && (
          <section
            className={`workflow-result ${result.ok ? "success" : "failure"}`}
            role={result.ok ? "status" : "alert"}
          >
            <strong>{result.message}</strong>
            {result.command && <code>{result.command}</code>}
            {(result.data !== undefined || result.stdout) && (
              <details open={step === 1}>
                <summary>
                  Результат · {result.durationMs} мс
                  {result.exitCode !== undefined
                    ? ` · exit ${result.exitCode ?? "неизвестен"}`
                    : ""}
                </summary>
                <pre>
                  {result.data !== undefined
                    ? JSON.stringify(result.data, null, 2)
                    : result.stdout}
                </pre>
              </details>
            )}
          </section>
        )}
    </div>
  );
}
