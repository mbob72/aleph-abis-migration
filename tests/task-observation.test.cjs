const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
// Модель React компилируется в памяти; ни SSH, ни рабочая БД не используются.
const file = path.resolve(__dirname, "../src/taskObservation.ts");
const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const mod = new Module(file, module);
mod._compile(compiled, file);
const {
  mergeObservation,
  taskTiming,
  appliedReceipt,
  nextOperation,
  loadHistory,
  saveHistory,
} = mod.exports;
const start = "2026-10-22T15:00:00.000Z",
  finish = "2026-10-22T15:00:20.000Z";
const task = (id, more = {}) => ({
  id,
  stage: "analyze",
  status: "completed",
  exitCode: 0,
  startedAt: start,
  finishedAt: finish,
  importId: "import-a",
  ...more,
});
const record = (id, more = {}) => ({
  task: task(id, more),
  observedAt: finish,
});
const observation = (t, more = {}) => ({
  ok: true,
  message: "ok",
  durationMs: 1,
  observation: {
    worker: { busy: false, accepting: true, task: t },
    taskId: t.id,
    observedAt: finish,
    ...more,
  },
});
test("три источника дополняют одну задачу; разные ID и неуспешные команды не смешиваются", () => {
  let history = mergeObservation(
    [],
    "worker-status",
    { ok: true, data: { task: task("a") }, durationMs: 1, message: "ok" },
    finish,
  );
  history = mergeObservation(
    history,
    "task-log",
    observation(task("a"), { log: "line" }),
    finish,
  );
  history = mergeObservation(
    history,
    "task-report",
    observation(task("a"), {
      report: {
        id: "import-a",
        counts: { rows: 198007, blocked: 0 },
        ready: true,
      },
    }),
    finish,
  );
  assert.equal(history.length, 1);
  assert.equal(history[0].log, "line");
  assert.equal(history[0].report.counts.rows, 198007);
  assert.equal(
    mergeObservation(
      history,
      "task-report",
      observation(task("b"), { taskId: "a", report: {} }),
      finish,
    ),
    history,
  );
  assert.equal(
    mergeObservation(history, "task-report", { ok: false }, finish),
    history,
  );
  history = mergeObservation(
    history,
    "worker-status",
    { ok: true, data: { task: task("b") }, durationMs: 0, message: "" },
    finish,
  );
  assert.equal(history.length, 2);
  assert.equal(history[1].report, undefined);
});
test("прогноз без истории неизвестен; медиана своего этапа; оценка не достигает 100% до завершения", () => {
  const current = record("new", {
    status: "running",
    exitCode: undefined,
    finishedAt: undefined,
  });
  assert.equal(taskTiming(current, [], Date.parse(finish)).progress, null);
  const history = [
    record("a"),
    record("b", { finishedAt: "2026-10-22T15:00:40Z" }),
    record("bad", { status: "failed" }),
    record("other", { stage: "stage" }),
  ];
  const timing = taskTiming(current, history, Date.parse(finish));
  assert.equal(timing.estimate, 30000);
  assert.equal(timing.samples, 2);
  assert.equal(timing.progress, 67);
  const late = taskTiming(current, history, Date.parse(finish) + 90000);
  assert.equal(late.progress, 95);
  assert.equal(late.overdue, true);
  assert.equal(taskTiming(record("done"), history, Date.now()).elapsed, 20000);
  assert.equal(taskTiming(record("done"), history, Date.now()).progress, 100);
  assert.equal(
    taskTiming(record("missing", { startedAt: undefined }), history, Date.now())
      .elapsed,
    null,
  );
});
test("план анализа и dry-run никогда не считаются загрузкой в public", () => {
  const report = {
    id: "import-a",
    kind: "authorities",
    status: "applied",
    verified: true,
    dryRun: false,
    counts: { insertAuthorities: 198007 },
  };
  const applied = { ...record("apply", { stage: "apply" }), report };
  assert.equal(appliedReceipt([applied], "import-a"), applied);
  assert.equal(appliedReceipt([applied], "other"), undefined);
  for (const invalid of [
    { dryRun: true },
    { verified: false },
    { status: "dry-run" },
    { kind: "relations" },
    { counts: {} },
    { id: undefined },
  ])
    assert.equal(
      appliedReceipt([{ ...applied, report: { ...report, ...invalid } }]),
      undefined,
    );
  assert.equal(
    appliedReceipt([
      { ...applied, task: task("fail", { stage: "apply", status: "failed" }) },
    ]),
    undefined,
  );
  assert.equal(
    appliedReceipt([{ ...applied, task: task("analyze") }]),
    undefined,
  );
});
test("следующая операция видна только после отчёта; неготовый анализ не продвигается", () => {
  const r = record("a");
  assert.match(nextOperation(r), /Прочитать отчёт/);
  assert.match(
    nextOperation({ ...r, report: { ready: false, counts: {} } }),
    /препятствия/,
  );
  assert.equal(
    nextOperation({ ...r, report: { ready: true, counts: {} } }),
    "Пробная загрузка",
  );
});
test("история ограничена 40 задачами; после перезапуска нет логов и неизвестных полей отчёта", () => {
  const data = new Map();
  global.localStorage = {
    getItem: (k) => data.get(k),
    setItem: (k, v) => data.set(k, v),
  };
  let history = [];
  for (let n = 0; n < 45; n++)
    history = mergeObservation(
      history,
      "task-report",
      observation(task(String(n)), {
        log: "secret log",
        report: {
          id: "import-a",
          counts: { rows: 198007 },
          password: "secret",
        },
      }),
      finish,
    );
  assert.equal(history.length, 40);
  saveHistory("one", history);
  assert.ok(!data.get("one").includes("secret"));
  assert.equal(loadHistory("one").length, 40);
  assert.equal(loadHistory("two").length, 0);
  data.set("bad", '[{"task":null}]');
  assert.deepEqual(loadHistory("bad"), []);
  delete global.localStorage;
});

test("новая задача не оставляет предыдущий снимок running бесконечно растущим", () => {
  const old = {
    ...record("old", {
      status: "running",
      finishedAt: undefined,
      exitCode: undefined,
    }),
    observedAt: finish,
  };
  const history = mergeObservation(
    [old],
    "worker-status",
    { ok: true, data: { task: task("new") }, durationMs: 0, message: "" },
    finish,
  );
  assert.equal(history[0].task.status, "unobserved");
  assert.equal(history[0].task.finishedAt, undefined);
  assert.equal(taskTiming(history[0], history, Date.now()).elapsed, 20000);
});

test("прогноз RSL11 не использует длительности RSL10", () => {
  const current = record("new", {
    library: "RSL11",
    status: "running",
    exitCode: undefined,
    finishedAt: undefined,
  });
  assert.equal(
    taskTiming(
      current,
      [record("old", { library: "RSL10" })],
      Date.parse(finish),
    ).estimate,
    null,
  );
  const history = mergeObservation(
    [],
    "stage-rsl11",
    {
      ok: true,
      data: { task: task("rsl11", { stage: "stage" }) },
      durationMs: 0,
      message: "",
    },
    finish,
  );
  assert.equal(history[0].task.library, "RSL11");
});
