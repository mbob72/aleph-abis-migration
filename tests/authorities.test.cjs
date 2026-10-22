const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const {
  settings,
  containerPath,
  reportPath,
  runAuthorityAction,
} = require("../electron/authorities.cjs");
const { quote, runRemoteCommand } = require("../electron/remote.cjs");
const defaults = require("../shared/defaults.json");
const profile = {
  ssh: {
    host: "fixture.invalid",
    port: "22",
    user: "operator",
    privateKey: "",
  },
  source: { rsl10: "", rsl11: "", relations: "", output: "" },
  processing: {
    container: "auth-docs-relations-worker",
    watcher: "abis-deploy-watch",
  },
};
const mounts = [
  { Source: "/data/aleph", Destination: "/source" },
  { Source: "/data/migration/authorities", Destination: "/work" },
];
function fixture(overrides = {}) {
  const commands = [];
  let status = { busy: false, accepting: true };
  const run = async ({ argv, onEvent }) => {
    commands.push(argv);
    onEvent?.({ kind: "command", text: argv.join(" ") });
    let data;
    if (argv[1] === "inspect")
      data = { state: { Running: true }, image: "sha256:fixture", mounts };
    else if (argv.includes("status") && argv.includes("worker")) data = status;
    else if (argv.includes("start")) {
      status = {
        busy: true,
        accepting: true,
        task: {
          id: "new-task",
          stage: "authorities-prepare",
          input: argv[argv.indexOf("--input") + 1],
          status: "running",
          output: "/work/output/new-task",
          log: "/work/reports/new-task.log",
          result: "/work/reports/new-task.json",
        },
      };
      data = status;
    } else if (argv.includes("cat")) data = { complete: true, ready: true };
    else data = { projects: {} };
    const changed = overrides.respond?.(argv, data);
    if (changed instanceof Error) throw changed;
    if (changed?.failure)
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        message: changed.failure,
      };
    return {
      ok: true,
      exitCode: 0,
      command: argv.join(" "),
      stdout: JSON.stringify(changed === undefined ? data : changed),
      stderr: "",
      message: "ok",
    };
  };
  return { commands, run, setStatus: (value) => (status = value) };
}
const request = (action, more = {}) => ({
  action,
  profile,
  controlPath: "/tmp/fixture/control",
  ...more,
});
test("пустые пути берутся из единого файла defaults", () => {
  assert.deepEqual(settings(profile).source, defaults.source);
  assert.equal(
    settings({ ...profile, source: { rsl10: "   " } }).source.rsl10,
    defaults.source.rsl10,
  );
  assert.throws(() =>
    settings({ ...profile, processing: { container: "-bad" } }),
  );
  assert.throws(() =>
    settings({ ...profile, source: { rsl10: "relative/file" } }),
  );
});
test("host-path переводится в самый конкретный source mount", () => {
  assert.equal(
    containerPath("/data/aleph/sub/file.dat", [
      ...mounts,
      { Source: "/data/aleph/sub", Destination: "/source/specific" },
    ]),
    "/source/specific/file.dat",
  );
  assert.throws(() => containerPath("/data/aleph-other/file.dat", mounts));
  assert.throws(() => containerPath("/etc/passwd", mounts));
  assert.throws(() => reportPath("/work/reports/../../run/db.env"));
});
test("RSL10: свежие проверки предшествуют start, пути и идентификация корректны", async () => {
  const f = fixture();
  const result = await runAuthorityAction(request("prepare-rsl10"), f);
  assert.equal(result.ok, true, result.message);
  assert.equal(f.commands.length, 4);
  assert.equal(f.commands[0][1], "inspect");
  assert.ok(f.commands[1].includes("status"));
  assert.ok(f.commands[2].includes("test"));
  const command = f.commands[3];
  assert.equal(
    command[command.indexOf("--input") + 1],
    "/source/rsl10_z00.dat",
  );
  assert.equal(command[command.indexOf("--identity-policy") + 1], "numeric001");
  assert.equal(
    result.data.outputOnServer,
    "/data/migration/authorities/output/new-task",
  );
  assert.match(result.message, /не означает завершение/);
});
test("RSL11 использует rsl11-nafpn, исходник с кавычками остаётся одним аргументом", async () => {
  const f = fixture();
  const changed = {
    ...profile,
    source: { ...profile.source, rsl11: "/data/aleph/a 'test.dat" },
  };
  const result = await runAuthorityAction(
    request("prepare-rsl11", { profile: changed }),
    f,
  );
  assert.equal(result.ok, true, result.message);
  const command = f.commands.at(-1);
  assert.equal(command[command.indexOf("--input") + 1], "/source/a 'test.dat");
  assert.equal(
    command[command.indexOf("--identity-policy") + 1],
    "rsl11-nafpn",
  );
});
for (const mode of ["busy", "drain", "stopped", "unmounted", "missing"])
  test(`preflight ${mode} не запускает обработку`, async () => {
    const f = fixture({
      respond: (argv, data) => {
        if (mode === "stopped" && argv[1] === "inspect")
          return { ...data, state: { Running: false } };
        if (mode === "unmounted" && argv[1] === "inspect")
          return { ...data, mounts: [] };
        if (mode === "missing" && argv.includes("test"))
          return { failure: "нет файла" };
      },
    });
    if (mode === "busy")
      f.setStatus({ busy: true, accepting: true, task: { id: "previous" } });
    if (mode === "drain") f.setStatus({ busy: false, accepting: false });
    const result = await runAuthorityAction(request("prepare-rsl10"), f);
    assert.equal(result.ok, false);
    assert.ok(!f.commands.some((command) => command.includes("start")));
  });
test("потерянный ответ start требует явного status, автоматического повтора нет", async () => {
  let lose = true;
  const f = fixture({
    respond: (argv) =>
      argv.includes("start") && lose ? { failure: "SSH потерян" } : undefined,
  });
  const changed = {
    ...profile,
    ssh: { ...profile.ssh, host: "uncertain.fixture.invalid" },
  };
  const first = await runAuthorityAction(
    request("prepare-rsl10", { profile: changed }),
    f,
  );
  assert.equal(first.uncertain, true);
  const count = f.commands.length;
  const second = await runAuthorityAction(
    request("prepare-rsl10", { profile: changed }),
    f,
  );
  assert.equal(second.ok, false);
  assert.equal(f.commands.length, count);
  const status = await runAuthorityAction(
    request("worker-status", { profile: changed }),
    f,
  );
  assert.equal(status.ok, true);
  f.setStatus({ busy: false, accepting: true });
  lose = false;
  const third = await runAuthorityAction(
    request("prepare-rsl10", { profile: changed }),
    f,
  );
  assert.equal(third.ok, true, third.message);
});
test("лог и отчёт читаются только для задачи НЗ из /work/reports", async () => {
  const f = fixture();
  let result = await runAuthorityAction(request("task-log"), f);
  assert.equal(result.ok, false);
  f.setStatus({
    busy: false,
    accepting: true,
    task: {
      id: "t",
      stage: "authorities-prepare",
      status: "completed",
      log: "/work/reports/t.log",
      result: "/work/reports/t.json",
    },
  });
  result = await runAuthorityAction(request("task-report"), f);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.data.complete, true);
  f.setStatus({
    busy: false,
    accepting: true,
    task: {
      id: "t",
      stage: "authorities-prepare",
      status: "completed",
      result: "/run/db.env",
    },
  });
  result = await runAuthorityAction(request("task-report"), f);
  assert.equal(result.ok, false);
  assert.ok(!f.commands.some((c) => c.includes("/run/db.env")));
});
test("произвольные операции не доходят до исполнителя", async () => {
  const f = fixture();
  const result = await runAuthorityAction(request("delete-container"), f);
  assert.equal(result.ok, false);
  assert.equal(f.commands.length, 0);
});
test("POSIX quoting сохраняет кавычки и shell-подстановки как данные", () => {
  const value = "a 'quote' $(printf injected) `printf injected` ; end";
  assert.equal(
    execFileSync("/bin/sh", ["-c", "printf '%s' " + quote(value)], {
      encoding: "utf8",
    }),
    value,
  );
});
test("remote runner передаёт потоковый вывод и exit code, не вызывает shell локально", async () => {
  const events = [];
  let args;
  const result = await runRemoteCommand(
    {
      ...request("help"),
      ssh: profile.ssh,
      argv: ["docker", "exec", "fixture", "help"],
      onEvent: (e) => events.push(e),
    },
    {
      spawnProcess: (file, argv, options) => {
        assert.equal(options.shell, false);
        args = argv;
        return spawn(
          process.execPath,
          [
            "-e",
            "process.stdout.write('hello');process.stderr.write('warning');process.exitCode=7",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, "hello");
  assert.equal(result.stderr, "warning");
  assert.ok(events.some((e) => e.kind === "stdout"));
  assert.ok(args.includes("ProxyCommand=false"));
});
test("remote runner ограничивает объём и время вывода", async () => {
  for (const mode of ["output", "timeout"]) {
    const result = await runRemoteCommand(
      {
        ssh: profile.ssh,
        controlPath: "/tmp/fixture",
        argv: ["docker", "info"],
        timeoutMs: 100,
        maxBytes: 10,
      },
      {
        spawnProcess: () =>
          spawn(
            process.execPath,
            [
              "-e",
              mode === "output"
                ? "process.stdout.write('x'.repeat(100));setInterval(()=>{},1000)"
                : "setInterval(()=>{},1000)",
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          ),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.match(result.message, mode === "output" ? /превышает/ : /истекло/);
  }
});

const {
  validateRsl10Manifest,
  validateRsl10Stage,
  packagePath,
  workerDatabasePaths,
} = require("../electron/authorities.cjs");
const IMPORT_ID = "12345678-1234-4123-8123-123456789abc";
const rsl10Manifest = {
  kind: "abis-authorities",
  version: 1,
  library: "RSL10",
  complete: true,
  limited: false,
  ready: true,
  counts: { exported: 198007 },
};
const stageReport = {
  id: IMPORT_ID,
  kind: "authorities",
  status: "prepared",
  rows: 198007,
  manifest: rsl10Manifest,
};
function stageFixture({
  manifest = rsl10Manifest,
  ready = true,
  report = stageReport,
} = {}) {
  const commands = [];
  let state = { busy: false, accepting: true };
  const run = async ({ argv }) => {
    commands.push(argv);
    let data = {};
    if (argv[1] === "inspect")
      data = {
        state: { Running: true },
        image: "1b12367",
        mounts,
        command: [
          "worker",
          "server",
          "--db-env",
          "/run/existing-db.env",
          "--profile=/run/existing-profile.json",
        ],
      };
    else if (argv.includes("worker") && argv.includes("status")) data = state;
    else if (argv.includes("check-db"))
      data = { ready, obstacles: ready ? [] : ["fixture obstacle"] };
    else if (argv.includes("cat"))
      data = argv.at(-1).endsWith("/manifest.json") ? manifest : report;
    else if (argv.includes("start")) {
      const stage = argv[argv.indexOf("--stage") + 1];
      state = {
        busy: true,
        accepting: true,
        task: {
          id: "task-" + stage,
          stage,
          status: "running",
          result: "/work/reports/task-" + stage + ".json",
          log: "/work/reports/task-" + stage + ".log",
          output: "/work/output/task-" + stage,
        },
      };
      if (stage === "stage")
        state.task.input = argv[argv.indexOf("--input") + 1];
      if (stage === "analyze")
        state.task.importId = argv[argv.indexOf("--import-id") + 1];
      data = state;
    }
    return {
      ok: true,
      exitCode: 0,
      command: argv.join(" "),
      stdout: JSON.stringify(data),
      stderr: "",
      message: "ok",
    };
  };
  return { commands, run, setState: (next) => (state = next) };
}
const stageProfile = {
  ...profile,
  processing: {
    ...profile.processing,
    packageRsl10: "/work/output/authorities-2026-10-22/RSL10",
    importIdRsl10: IMPORT_ID,
    stageReportRsl10: "/work/reports/task-stage.json",
  },
};
test("RSL10 stage использует готовый пакет и реальные пути подключения worker", async () => {
  const f = stageFixture();
  const result = await runAuthorityAction(
    request("stage-rsl10", { profile: stageProfile }),
    f,
  );
  assert.equal(result.ok, true, result.message);
  const command = f.commands.at(-1);
  assert.equal(command[command.indexOf("--stage") + 1], "stage");
  assert.equal(
    command[command.indexOf("--input") + 1],
    stageProfile.processing.packageRsl10,
  );
  assert.ok(!command.some((arg) => arg.endsWith(".dat")));
  const checkDb = f.commands.find((c) => c.includes("check-db"));
  assert.equal(checkDb[checkDb.indexOf("--env") + 1], "/run/existing-db.env");
  assert.equal(
    checkDb[checkDb.indexOf("--profile") + 1],
    "/run/existing-profile.json",
  );
  assert.ok(
    f.commands.findIndex((c) => c.includes("check-db")) <
      f.commands.findIndex((c) => c.includes("start")),
  );
  assert.ok(
    !f.commands.some((c) => c.includes("apply") || c.includes("PGPASSWORD")),
  );
});
for (const mode of ["library", "limited", "ready", "db"])
  test(`RSL10 stage не запускается при дефекте ${mode}`, async () => {
    const manifest = { ...rsl10Manifest };
    if (mode === "library") manifest.library = "RSL11";
    if (mode === "limited") manifest.limited = true;
    if (mode === "ready") manifest.ready = false;
    const f = stageFixture({ manifest, ready: mode !== "db" });
    const result = await runAuthorityAction(
      request("stage-rsl10", { profile: stageProfile }),
      f,
    );
    assert.equal(result.ok, false);
    assert.ok(!f.commands.some((c) => c.includes("start")));
  });
test("отчёт stage возвращает UUID импорта отдельно от task.id", async () => {
  const f = stageFixture();
  f.setState({
    busy: false,
    accepting: true,
    task: {
      id: "task-stage",
      stage: "stage",
      status: "completed",
      exitCode: 0,
      input: stageProfile.processing.packageRsl10,
      result: "/work/reports/task-stage.json",
    },
  });
  const result = await runAuthorityAction(
    request("task-report", { profile: stageProfile }),
    f,
  );
  assert.equal(result.ok, true, result.message);
  assert.equal(result.importIdRsl10, IMPORT_ID);
  assert.notEqual(result.importIdRsl10, "task-stage");
  assert.equal(result.stageReportRsl10, "/work/reports/task-stage.json");
});
test("analyze получает UUID подтверждённого RSL10 stage и не запускает apply", async () => {
  const f = stageFixture();
  const result = await runAuthorityAction(
    request("analyze-rsl10", { profile: stageProfile }),
    f,
  );
  assert.equal(result.ok, true, result.message);
  const command = f.commands.at(-1);
  assert.equal(command[command.indexOf("--stage") + 1], "analyze");
  assert.equal(command[command.indexOf("--import-id") + 1], IMPORT_ID);
  assert.ok(!command.includes("apply"));
});
test("analyze отклоняет task.id и отчёт другой библиотеки/импорта", async () => {
  for (const [id, report] of [
    ["task-stage", stageReport],
    [IMPORT_ID, { ...stageReport, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    [
      IMPORT_ID,
      { ...stageReport, manifest: { ...rsl10Manifest, library: "RSL11" } },
    ],
  ]) {
    const f = stageFixture({ report });
    const result = await runAuthorityAction(
      request("analyze-rsl10", {
        profile: {
          ...stageProfile,
          processing: { ...stageProfile.processing, importIdRsl10: id },
        },
      }),
      f,
    );
    assert.equal(result.ok, false);
    assert.ok(!f.commands.some((c) => c.includes("start")));
  }
});
test("пути пакета и настройки подключения worker не смешиваются с raw источниками", () => {
  assert.equal(
    packagePath(
      "/data/migration/authorities/output/authorities-2026-10-22/RSL10",
      mounts,
    ),
    stageProfile.processing.packageRsl10,
  );
  assert.throws(() => packagePath("/run/db.env", mounts));
  assert.deepEqual(workerDatabasePaths(), {
    env: "/run/db.env",
    profile: "/run/import-profile.json",
  });
  assert.throws(() =>
    validateRsl10Manifest({ ...rsl10Manifest, library: "TST11" }),
  );
  assert.throws(() =>
    validateRsl10Stage({ ...stageReport, status: "failed" }, IMPORT_ID),
  );
});

test("завершённый stage того же пакета не дублируется до чтения отчёта", async () => {
  const f = stageFixture();
  f.setState({
    busy: false,
    accepting: true,
    task: {
      id: "already-staged",
      stage: "stage",
      status: "completed",
      exitCode: 0,
      input: stageProfile.processing.packageRsl10,
    },
  });
  const result = await runAuthorityAction(
    request("stage-rsl10", { profile: stageProfile }),
    f,
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /уже завершён/);
  assert.ok(!f.commands.some((c) => c.includes("start")));
});

test("наблюдение apply/verify возвращает привязанный отчёт без запуска задач", async () => {
  for (const stage of ["dry-run", "apply", "verify"]) {
    const f = fixture();
    f.setStatus({
      busy: false,
      accepting: true,
      task: {
        id: "observed-" + stage,
        stage,
        status: "completed",
        exitCode: 0,
        result: "/work/reports/observed.json",
      },
    });
    const result = await runAuthorityAction(request("task-report"), f);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.observation.taskId, "observed-" + stage);
    assert.equal(result.observation.report.complete, true);
    assert.ok(!f.commands.some((c) => c.includes("start")));
  }
});
test("смена задачи во время чтения не прикрепляет отчёт к другому запуску", async () => {
  let statuses = 0;
  const f = fixture({
    respond: (argv, data) =>
      argv.includes("worker") && argv.includes("status")
        ? {
            busy: false,
            accepting: true,
            task: {
              id: ++statuses === 1 ? "before" : "after",
              stage: "analyze",
              status: "completed",
              exitCode: 0,
              result: "/work/reports/result.json",
            },
          }
        : data,
  });
  const result = await runAuthorityAction(request("task-report"), f);
  assert.equal(result.ok, false);
  assert.match(result.message, /сменилась/);
  assert.equal(result.observation, undefined);
});

const APPROVAL = "b".repeat(64);
const analysisReport = {
  id: IMPORT_ID,
  kind: "authorities",
  ready: true,
  approvalSha256: APPROVAL,
  counts: {
    rows: 198007,
    candidates: 198007,
    blocked: 0,
    conflicts: 0,
    descriptionErrors: 0,
    insertAuthorities: 198007,
  },
};
const finalProfile = {
  ...stageProfile,
  processing: {
    ...stageProfile.processing,
    analysisReportRsl10: "/work/reports/analysis.json",
    dryRunReportRsl10: "/work/reports/dry.json",
    applyReportRsl10: "",
  },
};
function finalFixture(overrides = {}) {
  const commands = [];
  let state = { busy: false, accepting: true };
  const reports = {
    "/work/reports/task-stage.json": stageReport,
    "/work/reports/analysis.json": analysisReport,
    "/work/reports/dry.json": {
      ...analysisReport,
      status: "dry-run",
      dryRun: true,
      verified: true,
    },
    "/work/reports/applied.json": {
      ...analysisReport,
      status: "applied",
      dryRun: false,
      verified: true,
    },
    ...overrides.reports,
  };
  return {
    commands,
    setState: (value) => (state = value),
    run: async ({ argv }) => {
      commands.push(argv);
      let data = {};
      if (argv[1] === "inspect")
        data = {
          state: { Running: true },
          mounts,
          command: ["worker", "server"],
        };
      else if (argv.includes("worker") && argv.includes("status")) data = state;
      else if (argv.includes("cat")) data = reports[argv.at(-1)] ?? {};
      else if (argv.includes("start")) {
        const stage = argv[argv.indexOf("--stage") + 1];
        state = {
          busy: true,
          accepting: true,
          task: {
            id: "new-" + stage,
            stage,
            status: "running",
            importId: IMPORT_ID,
          },
        };
        data = state;
      }
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify(data),
        message: "ok",
        command: argv.join(" "),
      };
    },
  };
}
for (const [action, stage] of [
  ["dry-run-rsl10", "dry-run"],
  ["apply-rsl10", "apply"],
  ["verify-rsl10", "verify"],
])
  test(
    "кнопка " + stage + " запускает только свой этап с подтверждённым импортом",
    async () => {
      const f = finalFixture();
      const p = structuredClone(finalProfile);
      if (stage === "verify")
        p.processing.applyReportRsl10 = "/work/reports/applied.json";
      const result = await runAuthorityAction(
        request(action, { profile: p }),
        f,
      );
      assert.equal(result.ok, true, result.message);
      const command = f.commands.find((c) => c.includes("start"));
      assert.equal(command[command.indexOf("--stage") + 1], stage);
      assert.equal(command[command.indexOf("--import-id") + 1], IMPORT_ID);
      if (stage !== "verify")
        assert.equal(command[command.indexOf("--approval") + 1], APPROVAL);
      else assert.ok(!command.includes("--approval"));
    },
  );
for (const [name, path, invalid] of [
  [
    "чужой анализ",
    "analysis.json",
    { ...analysisReport, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  ],
  [
    "блокировка",
    "analysis.json",
    { ...analysisReport, counts: { ...analysisReport.counts, blocked: 1 } },
  ],
  ["неполный анализ", "analysis.json", { ...analysisReport, ready: false }],
  [
    "чужой approval",
    "dry.json",
    {
      ...analysisReport,
      status: "dry-run",
      dryRun: true,
      verified: true,
      approvalSha256: "a".repeat(64),
    },
  ],
  [
    "dry-run без отката",
    "dry.json",
    { ...analysisReport, status: "applied", dryRun: false, verified: true },
  ],
  [
    "dry-run без проверки",
    "dry.json",
    { ...analysisReport, status: "dry-run", dryRun: true, verified: false },
  ],
])
  test("apply заблокирован: " + name, async () => {
    const f = finalFixture({ reports: { ["/work/reports/" + path]: invalid } });
    const result = await runAuthorityAction(
      request("apply-rsl10", { profile: finalProfile }),
      f,
    );
    assert.equal(result.ok, false);
    assert.ok(!f.commands.some((c) => c.includes("start")));
  });
test("повторный apply после успешного завершения не запускается", async () => {
  const f = finalFixture();
  f.setState({
    busy: false,
    accepting: true,
    task: {
      id: "already-applied",
      stage: "apply",
      importId: IMPORT_ID,
      status: "completed",
      exitCode: 0,
    },
  });
  const result = await runAuthorityAction(
    request("apply-rsl10", { profile: finalProfile }),
    f,
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /уже выполнен/);
  assert.ok(!f.commands.some((c) => c.includes("start")));
});
test("успешные отчёты сохраняют checkpoint, чужой импорт не открывает следующий этап", async () => {
  for (const [stage, file, field] of [
    ["analyze", "analysis.json", "analysisReportRsl10"],
    ["dry-run", "dry.json", "dryRunReportRsl10"],
    ["apply", "applied.json", "applyReportRsl10"],
  ]) {
    const f = finalFixture();
    f.setState({
      busy: false,
      accepting: true,
      task: {
        id: "observed-" + stage,
        stage,
        importId: IMPORT_ID,
        status: "completed",
        exitCode: 0,
        result: "/work/reports/" + file,
      },
    });
    const result = await runAuthorityAction(
      request("task-report", { profile: finalProfile }),
      f,
    );
    assert.equal(result.ok, true, result.message);
    assert.equal(result.checkpointUpdates[field], "/work/reports/" + file);
  }
  const f = finalFixture();
  f.setState({
    busy: false,
    accepting: true,
    task: {
      id: "other",
      stage: "analyze",
      importId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "completed",
      exitCode: 0,
      result: "/work/reports/analysis.json",
    },
  });
  const result = await runAuthorityAction(
    request("task-report", { profile: finalProfile }),
    f,
  );
  assert.equal(result.checkpointUpdates, undefined);
});

test("после служебного staging в конце потока показан именно отчёт verify без дополнительного exec", async () => {
  const verifyReport = {
    ...analysisReport,
    verified: true,
    counts: {
      ...analysisReport.counts,
      insertAuthorities: 0,
      existingAuthorities: 198007,
    },
  };
  const f = finalFixture({
    reports: { "/work/reports/verify.json": verifyReport },
  });
  f.setState({
    busy: false,
    accepting: true,
    task: {
      id: "verify-current",
      stage: "verify",
      importId: IMPORT_ID,
      status: "completed",
      exitCode: 0,
      result: "/work/reports/verify.json",
    },
  });
  const events = [];
  const result = await runAuthorityAction(
    request("task-report", {
      profile: finalProfile,
      onEvent: (event) => events.push(event),
    }),
    f,
  );
  assert.equal(result.ok, true, result.message);
  assert.equal(
    f.commands.filter(
      (c) => c.includes("cat") && c.at(-1) === "/work/reports/verify.json",
    ).length,
    1,
  );
  assert.equal(f.commands.at(-1).at(-1), "/work/reports/task-stage.json");
  const tail = events.at(-1);
  assert.equal(tail.kind, "stdout");
  assert.match(tail.text, /ОТЧЁТ ТЕКУЩЕЙ ЗАДАЧИ/);
  assert.match(tail.text, /Задача: verify-current/);
  assert.match(tail.text, /Этап: verify/);
  assert.match(tail.text, /"verified": true/);
  assert.deepEqual(
    JSON.parse(tail.text.slice(tail.text.indexOf("{"))),
    verifyReport,
  );
  assert.deepEqual(result.data, verifyReport);
});

const SECOND_ID = "ceef7299-e0ec-402f-bc8c-43f66a3bf531";
const rsl11Profile = {
  ...finalProfile,
  processing: {
    ...finalProfile.processing,
    library: "RSL11",
    packageRsl11: "/work/output/authorities-2026-10-22/RSL11",
    importIdRsl11: SECOND_ID,
    stageReportRsl11: "/work/reports/stage-rsl11.json",
    analysisReportRsl11: "/work/reports/analyze-rsl11.json",
    dryRunReportRsl11: "/work/reports/dry-rsl11.json",
    applyReportRsl11: "",
  },
};
function rsl11Fixture(overrides = {}) {
  let state = { busy: false, accepting: true };
  const commands = [];
  const manifest = {
    ...rsl10Manifest,
    library: "RSL11",
    identityPolicy: "rsl11-nafpn",
  };
  const analysis = { ...analysisReport, id: SECOND_ID };
  const reports = {
    "/work/reports/stage-rsl11.json": {
      ...stageReport,
      id: SECOND_ID,
      manifest,
    },
    "/work/reports/analyze-rsl11.json": analysis,
    "/work/reports/dry-rsl11.json": {
      ...analysis,
      status: "dry-run",
      verified: true,
      dryRun: true,
    },
    "/work/reports/apply-rsl11.json": {
      ...analysis,
      status: "applied",
      verified: true,
      dryRun: false,
    },
    ...overrides.reports,
  };
  return {
    commands,
    setState: (value) => (state = value),
    run: async ({ argv }) => {
      commands.push(argv);
      let data = {};
      if (argv[1] === "inspect")
        data = {
          state: { Running: true },
          mounts,
          command: ["worker", "server"],
        };
      else if (argv.includes("status") && argv.includes("worker")) data = state;
      else if (argv.includes("check-db")) data = { ready: true };
      else if (argv.includes("cat"))
        data = argv.at(-1).endsWith("/manifest.json")
          ? overrides.manifest || manifest
          : reports[argv.at(-1)] || {};
      else if (argv.includes("start")) {
        const stage = argv[argv.indexOf("--stage") + 1];
        state = {
          busy: true,
          accepting: true,
          task: {
            id: "rsl11-" + stage,
            stage,
            status: "running",
            ...(stage === "stage"
              ? { input: rsl11Profile.processing.packageRsl11 }
              : { importId: SECOND_ID }),
          },
        };
        data = state;
      }
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify(data),
        message: "ok",
      };
    },
  };
}
for (const stage of ["stage", "analyze", "dry-run", "apply", "verify"])
  test(
    "RSL11: отдельный маршрут " + stage + " не читает настройки RSL10",
    async () => {
      const f = rsl11Fixture(),
        p = structuredClone(rsl11Profile);
      if (stage === "verify")
        p.processing.applyReportRsl11 = "/work/reports/apply-rsl11.json";
      const result = await runAuthorityAction(
        request(stage + "-rsl11", { profile: p }),
        f,
      );
      assert.equal(result.ok, true, result.message);
      const command = f.commands.find((c) => c.includes("start"));
      assert.equal(command[command.indexOf("--stage") + 1], stage);
      assert.ok(
        !f.commands.some(
          (c) =>
            c.includes(finalProfile.processing.stageReportRsl10) ||
            c.includes(finalProfile.processing.analysisReportRsl10),
        ),
      );
      if (stage === "stage")
        assert.equal(
          command[command.indexOf("--input") + 1],
          p.processing.packageRsl11,
        );
      else assert.equal(command[command.indexOf("--import-id") + 1], SECOND_ID);
    },
  );
test("RSL11: чужой manifest и кнопка другой библиотеки блокируются до старта", async () => {
  const f = rsl11Fixture({ manifest: rsl10Manifest });
  let result = await runAuthorityAction(
    request("stage-rsl11", { profile: rsl11Profile }),
    f,
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /RSL11/);
  assert.ok(!f.commands.some((c) => c.includes("start")));
  const g = rsl11Fixture();
  result = await runAuthorityAction(
    request("apply-rsl10", { profile: rsl11Profile }),
    g,
  );
  assert.equal(result.ok, false);
  assert.equal(g.commands.length, 0);
});
test("RSL11: отчёт сохраняет только собственные UUID и checkpoints", async () => {
  const f = rsl11Fixture();
  f.setState({
    busy: false,
    accepting: true,
    task: {
      id: "rsl11-stage",
      stage: "stage",
      status: "completed",
      exitCode: 0,
      result: "/work/reports/stage-rsl11.json",
    },
  });
  let result = await runAuthorityAction(
    request("task-report", { profile: rsl11Profile }),
    f,
  );
  assert.equal(result.ok, true, result.message);
  assert.equal(result.checkpointUpdates.importIdRsl11, SECOND_ID);
  assert.equal(result.checkpointUpdates.importIdRsl10, undefined);
  assert.equal(result.importIdRsl10, undefined);
  f.setState({
    busy: false,
    accepting: true,
    task: {
      id: "rsl11-dry",
      stage: "dry-run",
      status: "completed",
      exitCode: 0,
      importId: SECOND_ID,
      result: "/work/reports/dry-rsl11.json",
    },
  });
  result = await runAuthorityAction(
    request("task-report", { profile: rsl11Profile }),
    f,
  );
  assert.equal(result.ok, true, result.message);
  assert.equal(
    result.checkpointUpdates.dryRunReportRsl11,
    "/work/reports/dry-rsl11.json",
  );
  assert.equal(result.checkpointUpdates.dryRunReportRsl10, undefined);
});
