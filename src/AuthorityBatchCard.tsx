import { RefreshCw, CheckCircle2 } from "lucide-react";
export type BatchState = {
  status: "idle" | "running" | "failed" | "completed";
  progress?: number;
  totalSteps?: number;
  backup?: string;
  error?: string;
  current?: { library?: string; stage: string };
  results?: {
    library: string;
    sourceDate: string;
    expected?: number;
    inserted?: number;
    verified?: boolean;
  }[];
};
/** Показывает подтверждённое состояние автономного контроллера; обновление также восстанавливает checkpoints. DOC-PREVIEW:/docs/architecture.md#authority-batch */
export function AuthorityBatchCard({
  state,
  disabled,
  refresh,
}: {
  state: BatchState | null;
  disabled: boolean;
  refresh: () => void;
}) {
  const labels = {
    idle: "Не запускалась",
    running: "Выполняется",
    failed: "Остановлена с ошибкой",
    completed: "Все три библиотеки загружены и проверены",
  };
  return (
    <section className="card workflow-card">
      <div className="section-heading">
        <div className="section-icon">
          <CheckCircle2 size={20} />
        </div>
        <div>
          <h2>Общая загрузка RSL10 · RSL11 · TST11</h2>
          <p>
            Подготовка всех файлов → staging → резервная копия → замена НЗ в
            public → проверка.
          </p>
        </div>
      </div>
      <div className="command-buttons">
        <button
          className="button secondary"
          disabled={disabled}
          onClick={refresh}
        >
          <RefreshCw size={15} />
          Обновить общую загрузку
        </button>
        <strong role="status">
          {state
            ? labels[state.status]
            : "Получите состояние серверной цепочки"}
        </strong>
      </div>
      {state && state.status !== "idle" && (
        <>
          <progress
            className="batch-progress"
            max={state.totalSteps || 19}
            value={state.progress || 0}
          />
          <p className="workflow-description">
            {state.progress || 0} / {state.totalSteps || 19} этапов
            {state.current
              ? ` · ${state.current.library || ""} ${state.current.stage}`
              : ""}
          </p>
          <div className="batch-libraries">
            {state.results?.map((entry) => (
              <div key={entry.library}>
                <strong>{entry.library}</strong>
                <small>Выгрузка {entry.sourceDate}</small>
                <span>
                  {entry.verified
                    ? "✓ Проверено"
                    : entry.inserted !== undefined
                      ? "Записано в public"
                      : "В очереди / обработка"}
                </span>
                <b>
                  {(entry.inserted ?? entry.expected)?.toLocaleString(
                    "ru-RU",
                  ) ?? "—"}
                </b>
              </div>
            ))}
          </div>
          {state.error && <p role="alert">{state.error}</p>}
          {state.backup && (
            <details>
              <summary>Резервная копия</summary>
              <code>{state.backup}</code>
            </details>
          )}
          {state.status === "completed" && (
            <p className="workflow-description">
              🎉 Нормативные записи трёх библиотек на месте!
            </p>
          )}
        </>
      )}
    </section>
  );
}
