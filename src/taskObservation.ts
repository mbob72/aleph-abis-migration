import type { AuthorityAction, AuthorityResult, WorkerState } from "./types";

export type Task = NonNullable<WorkerState["task"]>;
export type ReportSummary = {
  id?: string;
  kind?: string;
  status?: string;
  ready?: boolean;
  dryRun?: boolean;
  verified?: boolean;
  rows?: number;
  counts: Record<string, number>;
  error?: string;
};
export type TaskRecord = {
  task: Task;
  observedAt: string;
  report?: ReportSummary;
  reportAt?: string;
  log?: string;
  logAt?: string;
};
export const stageNames: Record<string, string> = {
  "authorities-prepare": "Подготовка пакета",
  stage: "Загрузка в staging",
  analyze: "Анализ кандидатов",
  "dry-run": "Пробная загрузка",
  apply: "Загрузка в public",
  verify: "Проверка результата",
};
const route = Object.keys(stageNames);
const counters = [
  "rows",
  "candidates",
  "blocked",
  "conflicts",
  "descriptionErrors",
  "insertAuthorities",
  "existingAuthorities",
  "insertForward",
  "insertReverse",
  "missingBib",
  "missingAut",
  "ambiguousBib",
  "ambiguousAut",
  "processed",
  "exported",
  "rejected",
];
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const text = (v: unknown) =>
  typeof v === "string" ? v.slice(0, 2000) : undefined;
export const stamp = (v?: string) =>
  v && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
export const successful = (task: Task) =>
  ["completed", "succeeded"].includes(task.status) && task.exitCode === 0;
export const running = (task: Task) => task.status === "running";
export function summarizeReport(value: unknown): ReportSummary {
  const r = object(value),
    counts = object(r.counts),
    error = object(r.error);
  const summary: ReportSummary = { counts: {} };
  for (const key of ["id", "kind", "status"] as const)
    summary[key] = text(r[key]);
  for (const key of ["ready", "dryRun", "verified"] as const)
    if (typeof r[key] === "boolean") summary[key] = r[key];
  if (typeof r.rows === "number" && Number.isSafeInteger(r.rows) && r.rows >= 0)
    summary.rows = r.rows;
  for (const key of counters)
    if (
      typeof counts[key] === "number" &&
      Number.isSafeInteger(counts[key]) &&
      counts[key] >= 0
    )
      summary.counts[key] = counts[key] as number;
  summary.error = text(error.message) || text(r.error);
  return summary;
}
/** Объединяет независимые снимки статуса, лога и отчёта только по task.id. DOC-PREVIEW:/docs/architecture.md#task-observation */
export function mergeObservation(
  history: TaskRecord[],
  action: AuthorityAction,
  result: AuthorityResult,
  now: string,
): TaskRecord[] {
  if (!result.ok) return history;
  const observation = result.observation;
  const state =
    observation?.worker ||
    ([
      "worker-status",
      "prepare-rsl10",
      "prepare-rsl11",
      "stage-rsl10",
      "analyze-rsl10",
      "dry-run-rsl10",
      "apply-rsl10",
      "verify-rsl10",
      "stage-rsl11",
      "analyze-rsl11",
      "dry-run-rsl11",
      "apply-rsl11",
      "verify-rsl11",
    ].includes(action)
      ? (result.data as WorkerState)
      : undefined);
  if (
    !state?.task?.id ||
    !state.task.stage ||
    !state.task.status ||
    (observation && observation.taskId !== state.task.id)
  )
    return history;
  const task = { ...state.task };
  const libraryFrom = (value: Task) =>
    value.library || value.input?.match(/RSL(?:10|11)/i)?.[0].toUpperCase();
  const manifest = object(object(observation?.report).manifest);
  task.library =
    libraryFrom(task) ||
    (manifest.library === "RSL10" || manifest.library === "RSL11"
      ? manifest.library
      : undefined) ||
    (action.endsWith("-rsl11")
      ? "RSL11"
      : action.endsWith("-rsl10")
        ? "RSL10"
        : undefined) ||
    history
      .filter((r) => task.importId && r.report?.id === task.importId)
      .map((r) => libraryFrom(r.task))
      .find(Boolean);

  const previous = history.find((r) => r.task.id === task.id);
  const record: TaskRecord = {
    ...previous,
    task: { ...previous?.task, ...task },
    observedAt: observation?.observedAt || now,
  };
  if (observation?.log !== undefined) {
    record.log = observation.log.slice(-200000);
    record.logAt = record.observedAt;
  }
  if (observation?.report !== undefined) {
    record.report = summarizeReport(observation.report);
    record.reportAt = record.observedAt;
  }
  // Worker выполняет одну задачу: после появления новой старый running — лишь снимок.
  // Не выдумываем исход и finishedAt, останавливаем локальный рост его длительности.
  const previousRecords = history
    .filter((r) => r.task.id !== task.id)
    .map((r) =>
      running(r.task) ? { ...r, task: { ...r.task, status: "unobserved" } } : r,
    );
  return [...previousRecords, record]
    .sort(
      (a, b) =>
        (stamp(a.task.startedAt) ?? stamp(a.observedAt) ?? 0) -
        (stamp(b.task.startedAt) ?? stamp(b.observedAt) ?? 0),
    )
    .slice(-40);
}
/** Прогноз — медиана успешных задач того же этапа и источника, не фактический процент строк. */
export function taskTiming(
  record: TaskRecord,
  history: TaskRecord[],
  now: number,
) {
  const start = stamp(record.task.startedAt),
    finish = stamp(record.task.finishedAt);
  const elapsed =
    start === null
      ? null
      : Math.max(
          0,
          (finish ??
            (running(record.task) ? now : (stamp(record.observedAt) ?? now))) -
            start,
        );
  const scope = (task: Task) =>
    task.library ||
    task.input?.match(/RSL\d+|rsl\d+/i)?.[0].toUpperCase() ||
    "";
  const samples = history
    .filter(
      (r) =>
        r.task.id !== record.task.id &&
        r.task.stage === record.task.stage &&
        scope(r.task) === scope(record.task) &&
        successful(r.task),
    )
    .map((r) => {
      const a = stamp(r.task.startedAt),
        b = stamp(r.task.finishedAt);
      return a !== null && b !== null && b > a ? b - a : 0;
    })
    .filter((v) => v > 0)
    .slice(-5)
    .sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  const estimate = samples.length
    ? samples.length % 2
      ? samples[middle]
      : (samples[middle - 1] + samples[middle]) / 2
    : null;
  const progress = successful(record.task)
    ? 100
    : estimate && elapsed !== null
      ? Math.min(95, Math.round((elapsed / estimate) * 100))
      : null;
  return {
    start,
    finish,
    elapsed,
    estimate,
    progress,
    samples: samples.length,
    overdue: Boolean(
      estimate &&
      elapsed !== null &&
      elapsed >= estimate &&
      running(record.task),
    ),
  };
}
export function nextOperation(record: TaskRecord): string {
  if (running(record.task)) return "Дождаться завершения и прочитать отчёт";
  if (!successful(record.task))
    return "Посмотреть лог и устранить причину ошибки";
  if (!record.report) return "Прочитать отчёт обработки";
  if (record.report.error || record.report.ready === false)
    return "Разобрать препятствия в отчёте";
  if (["dry-run", "apply"].includes(record.task.stage)) {
    if (record.report.verified !== true) return "Разобрать результат проверки";
    if (record.report.dryRun === true || record.report.status === "dry-run")
      return stageNames.apply;
    if (record.task.stage === "apply" && record.report.status !== "applied")
      return "Проверить результат записи";
  }
  if (record.task.stage === "verify")
    return record.report.verified ? "Готово" : "Разобрать результат проверки";
  const index = route.indexOf(record.task.stage);
  return index < 0
    ? "Проверить результат"
    : stageNames[route[index + 1]] || "Проверить результат";
}
/** Количество записей public подтверждает только успешный apply с verified и dryRun=false. */
export function appliedReceipt(history: TaskRecord[], importId?: string) {
  return [...history]
    .reverse()
    .find(
      (r) =>
        r.task.stage === "apply" &&
        successful(r.task) &&
        r.report?.kind === "authorities" &&
        r.report.status === "applied" &&
        r.report.verified === true &&
        r.report.dryRun === false &&
        typeof r.report.counts.insertAuthorities === "number" &&
        Boolean(r.report.id) &&
        (!importId || r.report.id === importId),
    );
}
export const duration = (ms: number | null) => {
  if (ms === null) return "—";
  const s = Math.floor(ms / 1000);
  return s < 60
    ? `${s} с`
    : s < 3600
      ? `${Math.floor(s / 60)} мин ${s % 60} с`
      : `${Math.floor(s / 3600)} ч ${Math.floor(s / 60) % 60} мин`;
};
/** Храним только краткие метаданные и счётчики; логи и исходные MARC-данные не сохраняются. */
export function saveHistory(key: string, history: TaskRecord[]) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify(history.map(({ log, logAt, ...record }) => record)),
    );
  } catch {
    /* История в памяти остаётся доступной. */
  }
}
export function loadHistory(key: string): TaskRecord[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.slice(-40).flatMap((value) => {
      const r = object(value),
        t = object(r.task);
      if (
        !text(t.id) ||
        !text(t.stage) ||
        !text(t.status) ||
        typeof r.observedAt !== "string" ||
        stamp(r.observedAt) === null
      )
        return [];
      const task: Task = {
        id: text(t.id)!,
        stage: text(t.stage)!,
        status: text(t.status)!,
      };
      for (const name of [
        "startedAt",
        "finishedAt",
        "input",
        "output",
        "result",
        "log",
        "importId",
        "library",
      ] as const)
        if (text(t[name])) task[name] = text(t[name]);
      if (typeof t.exitCode === "number") task.exitCode = t.exitCode;
      if (typeof t.dryRun === "boolean") task.dryRun = t.dryRun;
      return [
        {
          task,
          observedAt: r.observedAt,
          ...(r.report
            ? { report: summarizeReport(r.report), reportAt: text(r.reportAt) }
            : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}
