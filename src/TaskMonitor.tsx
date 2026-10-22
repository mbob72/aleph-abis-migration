import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  RefreshCw,
  Sparkles,
  TerminalSquare,
  ArrowRight,
} from "lucide-react";
import type { AuthorityAction } from "./types";
import {
  appliedReceipt,
  duration,
  nextOperation,
  running,
  stamp,
  stageNames,
  successful,
  taskTiming,
  type TaskRecord,
} from "./taskObservation";

type Props = {
  history: TaskRecord[];
  liveTaskId?: string;
  disabled: boolean;
  pending: AuthorityAction | null;
  run: (action: AuthorityAction) => void;
};
const time = (v: string | number | null | undefined) =>
  v !== null && v !== undefined && Number.isFinite(new Date(v).getTime())
    ? new Date(v).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
const number = (v?: number) =>
  v === undefined ? "—" : v.toLocaleString("ru-RU");
const statusName = (r: TaskRecord) =>
  successful(r.task)
    ? "Завершена"
    : running(r.task)
      ? "Выполняется"
      : {
          unobserved: "Итог не получен",
          failed: "Ошибка",
          interrupted: "Прервана",
          cancelled: "Отменена",
          stopped: "Остановлена",
        }[r.task.status] || r.task.status;
/** Одна карточка объединяет три источника наблюдения; таймер обновляет только UI. DOC-PREVIEW:/docs/architecture.md#task-observation */
export function TaskMonitor({
  history,
  liveTaskId,
  disabled,
  pending,
  run,
}: Props) {
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState("");
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const latest = history.at(-1);
  useEffect(() => {
    setSelected("");
  }, [latest?.task.id]);
  const record =
    history.find((r) => r.task.id === selected) ||
    history.find((r) => r.task.id === liveTaskId) ||
    latest;
  const timing = record ? taskTiming(record, history, now) : null;
  const importId = record?.report?.id || record?.task.importId;
  const receipt = importId ? appliedReceipt(history, importId) : undefined;
  const final =
    record?.task.stage === "verify" &&
    successful(record.task) &&
    record.report?.verified === true &&
    Boolean(receipt);
  const counts = record?.report?.counts;
  const reportFresh = Boolean(
    record &&
    record.reportAt &&
    (!record.task.finishedAt ||
      (stamp(record.reportAt) ?? 0) >= (stamp(record.task.finishedAt) ?? 0)),
  );
  const rows = history.slice(-6);
  const starts = rows
    .map((r) => stamp(r.task.startedAt))
    .filter((v): v is number => v !== null);
  const begin = starts.length ? Math.min(...starts) : now;
  const end = Math.max(
    begin + 1000,
    ...rows.map(
      (r) =>
        stamp(r.task.finishedAt) ??
        (running(r.task) ? now : (stamp(r.observedAt) ?? begin)),
    ),
  );
  const old = record?.task.id !== liveTaskId;
  return (
    <section
      className="card workflow-card task-monitor"
      aria-label="Наблюдение за задачей"
    >
      <div className="section-heading">
        <div className="section-icon">
          <TerminalSquare size={19} />
        </div>
        <div>
          <h2>Наблюдение за задачей</h2>
          <p>
            Статус, время и результат в одном месте. Обновление сервера — по
            кнопкам.
          </p>
        </div>
      </div>
      <div className="command-buttons monitor-buttons">
        <button
          className="button dark"
          disabled={disabled}
          onClick={() => run("worker-status")}
        >
          <RefreshCw size={14} />
          {pending === "worker-status"
            ? "Проверяем…"
            : "Обновить статус задачи"}
        </button>
        <button
          className="button secondary"
          disabled={disabled}
          onClick={() => run("task-log")}
        >
          {pending === "task-log" ? "Читаем…" : "Последние 100 строк лога"}
        </button>
        <button
          className="button secondary"
          disabled={disabled}
          onClick={() => run("task-report")}
        >
          {pending === "task-report" ? "Читаем…" : "Отчёт обработки"}
        </button>
      </div>
      <p className="monitor-hint">
        Кнопки читают текущую задачу worker. Закрытие приложения не
        останавливает обработку.
      </p>
      {record && timing ? (
        <>
          <div className="monitor-title">
            <div>
              <span className="eyebrow">
                {old ? "Сохранённый снимок" : "Текущая / последняя задача"}
              </span>
              <h3>{stageNames[record.task.stage] || record.task.stage}</h3>
              <code>{record.task.id}</code>
            </div>
            <span
              className={`task-status ${successful(record.task) ? "done" : running(record.task) ? "active" : "error"}`}
            >
              {successful(record.task) && <CheckCircle2 size={14} />}{" "}
              {statusName(record)}
            </span>
          </div>
          <div className="task-clocks">
            <div>
              <span>Начало</span>
              <strong>{time(record.task.startedAt)}</strong>
            </div>
            <div>
              <span>Сейчас · часы компьютера</span>
              <strong>{time(now)}</strong>
            </div>
            <div>
              <span>
                {timing.finish !== null
                  ? "Время выполнения"
                  : "Прошло с начала"}
              </span>
              <strong>{duration(timing.elapsed)}</strong>
            </div>
            <div>
              <span>Завершение</span>
              <strong>{time(record.task.finishedAt)}</strong>
            </div>
          </div>
          <div className="task-forecast">
            <div>
              <span>
                <Clock3 size={13} />{" "}
                {successful(record.task)
                  ? "Задача завершена"
                  : timing.overdue
                    ? "Прогноз превышен — обновите статус"
                    : running(record.task)
                      ? "Прогноз по времени"
                      : "Выполнение остановлено"}
              </span>
              <strong>
                {successful(record.task)
                  ? "100%"
                  : timing.progress !== null
                    ? `≈ ${timing.progress}%`
                    : "Нет оценки"}
              </strong>
            </div>
            <div
              className={`task-progress ${timing.progress === null && running(record.task) ? "indeterminate" : ""} ${!running(record.task) && !successful(record.task) ? "failed" : ""}`}
              role="progressbar"
              aria-label="Оценочный прогресс задачи"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={timing.progress ?? undefined}
            >
              <i
                style={{
                  width:
                    timing.progress === null ? "28%" : `${timing.progress}%`,
                }}
              />
            </div>
            <small>
              {running(record.task)
                ? timing.estimate !== null && timing.start !== null
                  ? `Ожидаемое завершение: ${time(timing.start + timing.estimate)} · оценка по ${timing.samples} успешным запускам. Это не процент обработанных строк.`
                  : "Для прогноза пока нет успешных запусков этого этапа. Фактический прогресс worker не сообщает."
                : `Последнее наблюдение: ${time(record.observedAt)}. Время завершения — из статуса worker.`}
            </small>
          </div>
          {record.report && (
            <div
              className={`report-digest ${record.report.error || record.report.ready === false ? "blocked" : ""}`}
            >
              <div className="digest-heading">
                <strong>
                  {record.report.error
                    ? "Ошибка обработки"
                    : record.report.status === "prepared"
                      ? "Данные в staging"
                      : record.report.status === "dry-run"
                        ? "Пробная загрузка · изменения отменены"
                        : record.report.status === "applied"
                          ? "Результат записи"
                          : record.task.stage === "verify"
                            ? "Проверка результата"
                            : "Результат анализа"}
                </strong>
                <small>Отчёт · {time(record.reportAt)}</small>
              </div>
              {record.report.error ? (
                <p role="alert">{record.report.error}</p>
              ) : (
                <>
                  <div className="digest-metrics">
                    <div>
                      <b>
                        {number(
                          record.report.rows ??
                            counts?.rows ??
                            counts?.exported,
                        )}
                      </b>
                      <span>
                        {record.report.status === "prepared"
                          ? "в staging"
                          : "записей"}
                      </span>
                    </div>
                    {counts?.candidates !== undefined && (
                      <div>
                        <b>{number(counts.candidates)}</b>
                        <span>кандидатов</span>
                      </div>
                    )}
                    {counts?.blocked !== undefined && (
                      <div>
                        <b>{number(counts.blocked)}</b>
                        <span>блокировок</span>
                      </div>
                    )}
                    {counts?.conflicts !== undefined && (
                      <div>
                        <b>{number(counts.conflicts)}</b>
                        <span>конфликтов</span>
                      </div>
                    )}
                  </div>
                  {record.task.stage === "analyze" && (
                    <p>
                      {record.report.ready
                        ? "Готово к пробной загрузке"
                        : "Проверьте препятствия"}
                      {counts?.insertAuthorities !== undefined
                        ? ` · к добавлению НЗ: ${number(counts.insertAuthorities)}`
                        : ""}
                      . В public ещё не записано.
                    </p>
                  )}
                  {record.report.status === "dry-run" && (
                    <p>
                      Пробная запись выполнена с откатом. Загружено в public: 0.
                    </p>
                  )}
                </>
              )}
              <details>
                <summary>Все счётчики отчёта</summary>
                <pre>{JSON.stringify(record.report, null, 2)}</pre>
              </details>
            </div>
          )}
          {receipt && (
            <div className="public-receipt">
              <CheckCircle2 size={20} />
              <div>
                <strong>
                  В public загружено{" "}
                  {number(receipt.report?.counts.insertAuthorities)} нормативных
                  записей
                </strong>
                <small>
                  Подтверждено отчётом apply · {time(receipt.task.finishedAt)} ·
                  импорт {receipt.report?.id}
                </small>
              </div>
            </div>
          )}
          <details
            className="monitor-log"
            key={`${record.task.id}:${record.logAt || "empty"}`}
            open={record.log !== undefined}
          >
            <summary>
              Последние 100 строк лога{" "}
              {record.logAt ? `· ${time(record.logAt)}` : "· ещё не прочитаны"}
            </summary>
            <pre>
              {record.log || "Лог не прочитан или пуст. Нажмите кнопку выше."}
            </pre>
          </details>
          <details className="monitor-technical">
            <summary>Технические данные задачи</summary>
            <dl className="task-summary">
              <dt>Состояние</dt>
              <dd>
                {record.task.status}
                {record.task.exitCode !== undefined
                  ? ` · exit ${record.task.exitCode}`
                  : ""}
              </dd>
              <dt>Каталог</dt>
              <dd>{record.task.output || "—"}</dd>
              <dt>ID импорта</dt>
              <dd>{record.task.importId || record.report?.id || "—"}</dd>
            </dl>
          </details>
          {!reportFresh && successful(record.task) && (
            <p className="monitor-hint">
              Прочитайте итоговый отчёт: завершение процесса само по себе не
              подтверждает количество записей.
            </p>
          )}
          <div className="task-timeline">
            <div className="timeline-heading">
              <h3>Временная шкала</h3>
              <span>Последние 6 задач · локальная история</span>
            </div>
            <div className="timeline-axis">
              <span>{time(begin)}</span>
              <span>{time(end)}</span>
            </div>
            {rows.map((r) => {
              const a = stamp(r.task.startedAt),
                b =
                  stamp(r.task.finishedAt) ??
                  (running(r.task) ? now : stamp(r.observedAt));
              return (
                <button
                  key={r.task.id}
                  className={`timeline-row ${record.task.id === r.task.id ? "selected" : ""}`}
                  onClick={() => setSelected(r.task.id)}
                  title={`${r.task.id} · ${statusName(r)}`}
                >
                  <span>
                    {stageNames[r.task.stage] || r.task.stage}
                    <small>
                      {statusName(r)} ·{" "}
                      {duration(taskTiming(r, history, now).elapsed)}
                    </small>
                  </span>
                  <div className="timeline-track">
                    {a !== null && b !== null ? (
                      <i
                        className={
                          successful(r.task)
                            ? "done"
                            : running(r.task)
                              ? "active"
                              : "error"
                        }
                        style={{
                          left: `${Math.max(0, ((a - begin) / (end - begin)) * 100)}%`,
                          width: `${Math.max(1, Math.min(100, ((b - a) / (end - begin)) * 100))}%`,
                        }}
                      />
                    ) : (
                      <small>Нет времени в снимке worker</small>
                    )}
                  </div>
                </button>
              );
            })}
            {!final && (
              <div className="timeline-row next-operation">
                <span>
                  <ArrowRight size={12} /> Далее
                  <small>{nextOperation(record)}</small>
                </span>
                <div className="timeline-track">
                  <i />
                </div>
              </div>
            )}
            {history.length > 6 && (
              <label className="history-select">
                Другие задачи{" "}
                <select
                  value={record.task.id}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {[...history].reverse().map((r) => (
                    <option key={r.task.id} value={r.task.id}>
                      {stageNames[r.task.stage] || r.task.stage} ·{" "}
                      {time(r.task.startedAt)} · {r.task.id.slice(-8)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {final && (
            <div className="migration-celebration" role="status">
              <div className="confetti" aria-hidden="true">
                {Array.from({ length: 16 }, (_, i) => (
                  <i
                    key={i}
                    style={{
                      left: `${i * 6.3}%`,
                      animationDelay: `${(i % 5) * 0.13}s`,
                      background: ["#9eb9eb", "#e3be70", "#80c7b5", "#c0a5d9"][
                        i % 4
                      ],
                    }}
                  />
                ))}
              </div>
              <Sparkles size={28} />
              <h3>Нормативные записи — в Светоче!</h3>
              <p>
                {number(receipt?.report?.counts.insertAuthorities)} нормативных
                записей загружено. Итоговая проверка пройдена.
              </p>
              <small>Этот этап миграции завершён ✨</small>
            </div>
          )}
        </>
      ) : (
        <div className="monitor-empty">
          <Clock3 size={25} />
          <p>Здесь появятся этапы и время выполнения.</p>
          <small>
            Обновите статус, чтобы получить текущую или последнюю задачу.
          </small>
        </div>
      )}
    </section>
  );
}
