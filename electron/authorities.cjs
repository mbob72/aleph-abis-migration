const path = require("node:path").posix;
const defaults = require("../shared/defaults.json");
const { runRemoteCommand } = require("./remote.cjs");
const CLI = "/usr/local/bin/rsl-aut";
const uncertainStarts = new Set();

/** Нормализует профиль без передачи произвольных команд из React. DOC-PREVIEW:/docs/architecture.md#authority-commands */
function settings(profile) {
  const library = profile?.processing?.library || "RSL10";
  if (!["RSL10", "RSL11"].includes(library))
    throw new Error("Выберите библиотеку RSL10 или RSL11.");
  const suffix = library === "RSL11" ? "Rsl11" : "Rsl10";
  const result = {
    library,
    suffix,
    container:
      profile?.processing?.container?.trim() || defaults.processing.container,
    watcher:
      profile?.processing?.watcher?.trim() || defaults.processing.watcher,
    source: {},
  };
  for (const field of [
    "package",
    "importId",
    "stageReport",
    "analysisReport",
    "dryRunReport",
    "applyReport",
  ]) {
    result[field] =
      profile?.processing?.[field + suffix]?.trim() ||
      defaults.processing[field + suffix] ||
      "";
  }
  for (const name of ["container", "watcher"])
    if (
      typeof result[name] !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(result[name])
    )
      throw new Error("Недопустимое имя Docker-контейнера.");
  for (const [key, fallback] of Object.entries(defaults.source)) {
    const raw = profile?.source?.[key];
    if (raw !== undefined && typeof raw !== "string")
      throw new Error("Путь источника должен быть строкой.");
    const value = raw?.trim() || fallback;
    if (!path.isAbsolute(value) || /[\r\n\0]/.test(value))
      throw new Error("Укажите абсолютные серверные пути без переводов строк.");
    result.source[key] = path.normalize(value);
  }
  return result;
}
/** Переводит путь сервера по самому длинному совпадению Docker mount. DOC-PREVIEW:/docs/architecture.md#authority-commands */
function containerPath(hostPath, mounts) {
  const candidates = mounts
    .filter(
      (m) =>
        typeof m.Source === "string" &&
        typeof m.Destination === "string" &&
        (hostPath === m.Source ||
          hostPath.startsWith(m.Source.replace(/\/$/, "") + "/")),
    )
    .sort((a, b) => b.Source.length - a.Source.length);
  if (!candidates.length)
    throw new Error(
      `Исходник ${hostPath} не доступен через mounts контейнера. Проверьте путь в настройках.`,
    );
  const mount = candidates[0];
  const mapped = path.join(
    mount.Destination,
    path.relative(mount.Source, hostPath),
  );
  if (!mapped.startsWith("/source/"))
    throw new Error(
      "Исходник должен быть смонтирован внутрь /source контейнера worker.",
    );
  return mapped;
}
function parseJson(result) {
  if (!result.ok) throw Object.assign(new Error(result.message), { result });
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      "Команда вернула некорректный JSON. Посмотрите вывод во вкладке «Команды».",
    );
  }
}
function workerState(value) {
  if (
    !value ||
    typeof value.busy !== "boolean" ||
    typeof value.accepting !== "boolean"
  )
    throw new Error(
      "Неизвестный формат worker status. Проверьте версию контейнера.",
    );
  return value;
}
function reportPath(value) {
  if (
    typeof value !== "string" ||
    /[\r\n\0]/.test(value) ||
    !path.normalize(value).startsWith("/work/reports/")
  )
    throw new Error("Worker не сообщил допустимый путь отчёта или лога.");
  return path.normalize(value);
}
/** Различает готовый пакет НЗ, UUID импорта и worker task.id. DOC-PREVIEW:/docs/architecture.md#authority-staging */
function isImportId(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
function validateRsl10Manifest(manifest, library = "RSL10") {
  if (
    manifest?.kind !== "abis-authorities" ||
    manifest.library !== library ||
    manifest.version !== 1 ||
    manifest.complete !== true ||
    manifest.limited !== false ||
    manifest.ready !== true
  )
    throw new Error(`Пакет не является готовым полным пакетом ${library}.`);
}
function validateRsl10Stage(report, id, library = "RSL10") {
  if (
    !isImportId(id) ||
    report?.id !== id ||
    report.kind !== "authorities" ||
    report.status !== "prepared"
  )
    throw new Error(
      `Отчёт stage не подтверждает выбранный ID импорта ${library}.`,
    );
  validateRsl10Manifest(report.manifest, library);
}

/** Связывает готовый анализ и результат транзакции с импортом и approval. DOC-PREVIEW:/docs/architecture.md#authority-final-stages */
function validateImportAnalysis(report, id) {
  if (
    report?.id !== id ||
    report.kind !== "authorities" ||
    report.ready !== true ||
    !/^[0-9a-f]{64}$/.test(report.approvalSha256 || "") ||
    !report.counts ||
    !Number.isSafeInteger(report.counts.rows) ||
    report.counts.rows < 0
  )
    throw new Error(
      "Нет готового анализа этого импорта. Прочитайте успешный отчёт анализа.",
    );
  for (const field of [
    "blocked",
    "conflicts",
    "descriptionErrors",
    "missingBib",
    "missingAut",
    "ambiguousBib",
    "ambiguousAut",
  ])
    if (report.counts[field] !== undefined && report.counts[field] !== 0)
      throw new Error("Анализ содержит препятствия: " + field);
}
function validateImportOutcome(report, id, approval, dryRun) {
  validateImportAnalysis(report, id);
  if (
    report.approvalSha256 !== approval ||
    report.verified !== true ||
    report.dryRun !== dryRun ||
    report.status !== (dryRun ? "dry-run" : "applied")
  )
    throw new Error(
      dryRun
        ? "Dry-run этого анализа не подтверждён. Прочитайте его отчёт."
        : "Загрузка в public не подтверждена отчётом apply.",
    );
}

function packagePath(value, mounts) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    /[\r\n\0]/.test(value)
  )
    throw new Error(
      "Укажите абсолютный путь готового пакета нормативных записей.",
    );
  const normalized = path.normalize(value);
  if (normalized.startsWith("/work/") || normalized.startsWith("/source/"))
    return normalized;
  const mount = mounts
    .filter(
      (m) =>
        typeof m.Source === "string" &&
        typeof m.Destination === "string" &&
        (normalized === m.Source ||
          normalized.startsWith(m.Source.replace(/\/$/, "") + "/")),
    )
    .sort((a, b) => b.Source.length - a.Source.length)[0];
  if (!mount)
    throw new Error(
      "Готовый пакет не доступен через mounts worker. Укажите путь в /work или /source.",
    );
  return packagePath(
    path.join(mount.Destination, path.relative(mount.Source, normalized)),
    [],
  );
}
function workerDatabasePaths(command = []) {
  const option = (flag, fallback) => {
    const index = command.indexOf(flag);
    const value =
      index >= 0
        ? command[index + 1]
        : command
            .find(
              (arg) => typeof arg === "string" && arg.startsWith(flag + "="),
            )
            ?.slice(flag.length + 1) || fallback;
    if (
      typeof value !== "string" ||
      !value.startsWith("/run/") ||
      /[\r\n\0]/.test(value)
    )
      throw new Error(
        "Неизвестный путь подключения worker. Проверьте его конфигурацию.",
      );
    return path.normalize(value);
  };
  return {
    env: option("--db-env", "/run/db.env"),
    profile: option("--profile", "/run/import-profile.json"),
  };
}
/** Выполняет действие и свежие preflight-проверки перед start, не повторяет неопределённый start. DOC-PREVIEW:/docs/architecture.md#authority-commands */
async function runAuthorityAction(
  { action, profile, controlPath, signal, onEvent },
  { run = runRemoteCommand } = {},
) {
  const started = Date.now();
  let observation;
  let startIssued = false,
    last,
    key;
  try {
    const config = settings(profile);
    const selectedAction =
      /^(stage|analyze|dry-run|apply|verify)-rsl(10|11)$/.exec(action);
    if (selectedAction) {
      if (config.library !== "RSL" + selectedAction[2])
        throw new Error(
          "Кнопка относится к другой библиотеке. Проверьте выбранный маршрут.",
        );
      action = selectedAction[1] + "-rsl10"; // Общий allowlist и исполнение для обеих библиотек.
    }
    if (
      ![
        "container-status",
        "worker-status",
        "delivery-status",
        "help",
        "prepare-rsl10",
        "prepare-rsl11",
        "task-log",
        "task-report",
        "inspect-package",
        "check-worker-db",
        "stage-rsl10",
        "analyze-rsl10",
        "dry-run-rsl10",
        "apply-rsl10",
        "verify-rsl10",
      ].includes(action)
    )
      throw new Error("Неизвестная операция НЗ.");
    key = JSON.stringify([
      profile.ssh.host,
      profile.ssh.port,
      profile.ssh.user,
      config.container,
    ]);
    const exec = async (argv) => {
      last = await run({
        ssh: profile.ssh,
        controlPath,
        argv,
        signal,
        onEvent,
      });
      if (!last.ok)
        throw Object.assign(new Error(last.message), { result: last });
      return last;
    };
    const worker = async () =>
      workerState(
        parseJson(
          await exec([
            "docker",
            "exec",
            config.container,
            CLI,
            "worker",
            "status",
          ]),
        ),
      );
    const inspect = async () => {
      const value = parseJson(
        await exec([
          "docker",
          "inspect",
          "--type",
          "container",
          "--format",
          '{"state":{{json .State}},"image":{{json .Image}},"mounts":{{json .Mounts}},"command":{{json .Config.Cmd}}}',
          config.container,
        ]),
      );
      if (
        !value?.state ||
        typeof value.state.Running !== "boolean" ||
        !Array.isArray(value.mounts)
      )
        throw new Error("Неизвестный ответ docker inspect.");
      return value;
    };
    let data;
    if (action === "container-status") data = await inspect();
    else if (action === "worker-status") {
      data = await worker();
      uncertainStarts.delete(key);
    } else if (action === "delivery-status")
      data = parseJson(
        await exec([
          "docker",
          "exec",
          config.watcher,
          "python3",
          "/app/watch.py",
          "status",
        ]),
      );
    else if (action === "help") {
      await exec(["docker", "exec", config.container, CLI, "help"]);
    } else if (
      [
        "inspect-package",
        "check-worker-db",
        "stage-rsl10",
        "analyze-rsl10",
        "dry-run-rsl10",
        "apply-rsl10",
        "verify-rsl10",
      ].includes(action)
    ) {
      const container = await inspect();
      if (!container.state.Running) throw new Error("Контейнер остановлен.");
      const paths = workerDatabasePaths(container.command);
      const packageDirectory = packagePath(config.package, container.mounts);
      const readManifest = async () => {
        await exec([
          "docker",
          "exec",
          config.container,
          "test",
          "-d",
          packageDirectory,
        ]);
        const manifest = parseJson(
          await exec([
            "docker",
            "exec",
            config.container,
            "cat",
            "--",
            path.join(packageDirectory, "manifest.json"),
          ]),
        );
        validateRsl10Manifest(manifest, config.library);
        return manifest;
      };
      const checkDb = async () => {
        const result = parseJson(
          await exec([
            "docker",
            "exec",
            config.container,
            CLI,
            "import",
            "check-db",
            "--env",
            paths.env,
            "--profile",
            paths.profile,
          ]),
        );
        if (result.ready !== true)
          throw new Error("Проверка БД worker не подтвердила ready=true.");
        return result;
      };
      if (action === "inspect-package")
        data = {
          package: packageDirectory,
          manifest: await readManifest(),
          connection: paths,
        };
      else if (action === "check-worker-db") data = await checkDb();
      else {
        if (uncertainStarts.has(key))
          throw new Error(
            "Предыдущий start не подтверждён. Сначала обновите статус worker и прочитайте отчёт задачи.",
          );
        const state = await worker();
        if (state.busy)
          throw new Error(
            `Worker занят задачей ${state.task?.id || "без ID"}.`,
          );
        if (!state.accepting)
          throw new Error("Worker не принимает задания (drain).");
        let args;
        if (action === "stage-rsl10") {
          if (
            state.task?.stage === "stage" &&
            state.task.input === packageDirectory &&
            state.task.status === "completed" &&
            state.task.exitCode === 0
          )
            throw new Error(
              "Stage этого пакета уже завершён. Прочитайте отчёт обработки и используйте его ID импорта для analyze.",
            );
          await readManifest();
          await checkDb();
          args = ["--stage", "stage", "--input", packageDirectory];
        } else {
          if (!isImportId(config.importId))
            throw new Error(
              `Сначала прочитайте отчёт завершённого stage ${config.library} и получите ID импорта.`,
            );
          const stageReport = parseJson(
            await exec([
              "docker",
              "exec",
              config.container,
              "cat",
              "--",
              reportPath(config.stageReport),
            ]),
          );
          validateRsl10Stage(stageReport, config.importId, config.library);
          const stage = {
            "analyze-rsl10": "analyze",
            "dry-run-rsl10": "dry-run",
            "apply-rsl10": "apply",
            "verify-rsl10": "verify",
          }[action];
          args = ["--stage", stage, "--import-id", config.importId];
          const read = async (file) =>
            parseJson(
              await exec([
                "docker",
                "exec",
                config.container,
                "cat",
                "--",
                reportPath(file),
              ]),
            );
          if (stage !== "analyze") {
            const analysis = await read(config.analysisReport);
            validateImportAnalysis(analysis, config.importId);
            if (stage === "dry-run" || stage === "apply")
              args.push("--approval", analysis.approvalSha256);
            if (stage === "apply" || stage === "verify") {
              const dryRun = await read(config.dryRunReport);
              validateImportOutcome(
                dryRun,
                config.importId,
                analysis.approvalSha256,
                true,
              );
            }
            if (
              stage === "apply" &&
              (config.applyReport ||
                (state.task?.stage === "apply" &&
                  state.task.importId === config.importId &&
                  state.task.status === "completed" &&
                  state.task.exitCode === 0))
            )
              throw new Error(
                "Apply уже выполнен или указан его отчёт. Прочитайте отчёт и переходите к итоговой проверке.",
              );
            if (stage === "verify")
              validateImportOutcome(
                await read(config.applyReport),
                config.importId,
                analysis.approvalSha256,
                false,
              );
          }
        }
        uncertainStarts.add(key);
        startIssued = true;
        data = workerState(
          parseJson(
            await exec([
              "docker",
              "exec",
              config.container,
              CLI,
              "worker",
              "start",
              ...args,
            ]),
          ),
        );
        const expected = args[1];
        if (
          !data.task?.id ||
          data.task.id === state.task?.id ||
          data.task.stage !== expected ||
          (expected === "stage"
            ? data.task.input !== packageDirectory
            : data.task.importId !== config.importId)
        )
          throw new Error(
            "Ответ start не подтверждает ожидаемую задачу. Обновите worker status.",
          );
        uncertainStarts.delete(key);
      }
    } else if (action.startsWith("prepare-")) {
      if (uncertainStarts.has(key))
        throw new Error(
          "Предыдущий start не подтверждён. Сначала обновите статус worker и проверьте task.id.",
        );
      const container = await inspect();
      if (!container.state.Running)
        throw new Error(
          "Контейнер остановлен. Сначала запустите worker на сервере.",
        );
      const state = await worker();
      if (state.busy)
        throw new Error(
          `Worker занят задачей ${state.task?.id || "без ID"}. Дождитесь её завершения.`,
        );
      if (!state.accepting)
        throw new Error(
          "Worker не принимает задания (drain). Проверьте состояние перед запуском.",
        );
      const library = action === "prepare-rsl10" ? "RSL10" : "RSL11";
      const input = containerPath(
        config.source[library.toLowerCase()],
        container.mounts,
      );
      await exec(["docker", "exec", config.container, "test", "-f", input]);
      uncertainStarts.add(key);
      startIssued = true;
      data = workerState(
        parseJson(
          await exec([
            "docker",
            "exec",
            config.container,
            CLI,
            "worker",
            "start",
            "--stage",
            "authorities-prepare",
            "--input",
            input,
            "--library",
            library,
            "--identity-policy",
            library === "RSL11" ? "rsl11-nafpn" : "numeric001",
          ]),
        ),
      );
      if (
        !data.task?.id ||
        data.task.id === state.task?.id ||
        data.task.stage !== "authorities-prepare" ||
        data.task.input !== input
      )
        throw new Error(
          "Ответ start не подтверждает ожидаемую задачу. Проверьте worker status.",
        );
      uncertainStarts.delete(key);
      const mount = container.mounts
        .filter(
          (m) =>
            typeof m.Destination === "string" &&
            typeof m.Source === "string" &&
            typeof data.task.output === "string" &&
            data.task.output.startsWith(m.Destination.replace(/\/$/, "") + "/"),
        )
        .sort((a, b) => b.Destination.length - a.Destination.length)[0];
      if (mount)
        data.outputOnServer = path.join(
          mount.Source,
          path.relative(mount.Destination, data.task.output),
        );
    } else {
      const state = await worker();
      if (
        !state.task?.id ||
        ![
          "authorities-prepare",
          "stage",
          "analyze",
          "dry-run",
          "apply",
          "verify",
        ].includes(state.task.stage)
      )
        throw new Error(
          "Нет задачи миграции НЗ. Сначала проверьте статус worker.",
        );
      if (action === "task-log")
        await exec([
          "docker",
          "exec",
          config.container,
          "tail",
          "-n",
          "100",
          "--",
          reportPath(state.task.log),
        ]);
      else {
        if (state.busy || state.task.status === "running")
          throw new Error("Задача ещё работает. Итоговый отчёт пока не готов.");
        data = parseJson(
          await exec([
            "docker",
            "exec",
            config.container,
            "cat",
            "--",
            reportPath(state.task.result),
          ]),
        );
      }
      const artifact = last;
      const confirmedState = await worker();
      if (
        confirmedState.task?.id !== state.task.id ||
        confirmedState.task?.stage !== state.task.stage ||
        confirmedState.task?.result !== state.task.result ||
        confirmedState.task?.log !== state.task.log
      )
        throw new Error(
          "Задача сменилась во время чтения. Обновите статус и повторите чтение.",
        );
      last = artifact;
      observation = {
        taskId: state.task.id,
        worker: confirmedState,
        observedAt: new Date().toISOString(),
        ...(action === "task-log"
          ? { log: artifact.stdout }
          : { report: data }),
      };
    }
    const artifactResult = last;
    const importDetails = {};
    if (
      action === "task-report" &&
      observation &&
      ["analyze", "dry-run", "apply", "verify"].includes(
        observation.worker.task?.stage,
      ) &&
      isImportId(config.importId) &&
      observation.worker.task?.importId === config.importId &&
      data?.id === config.importId &&
      observation.worker.task.status === "completed" &&
      observation.worker.task.exitCode === 0
    ) {
      const task = observation.worker.task;
      if (
        observation.worker.busy ||
        task.status !== "completed" ||
        task.exitCode !== 0
      )
        throw new Error(
          "Задача не завершена успешно. Изучите лог перед продолжением.",
        );
      if (
        !isImportId(config.importId) ||
        task.importId !== config.importId ||
        data?.id !== config.importId
      )
        throw new Error(
          `Отчёт относится к другому импорту. Проверьте ID ${config.library}.`,
        );
      const read = async (file) =>
        parseJson(
          await exec([
            "docker",
            "exec",
            config.container,
            "cat",
            "--",
            reportPath(file),
          ]),
        );
      validateRsl10Stage(
        await read(config.stageReport),
        config.importId,
        config.library,
      );
      if (task.stage === "analyze") {
        if (data.ready === true) validateImportAnalysis(data, config.importId);
        importDetails.checkpointUpdates = {
          ["analysisReport" + config.suffix]:
            data.ready === true ? reportPath(task.result) : "",
          ["dryRunReport" + config.suffix]: "",
          ["applyReport" + config.suffix]: "",
        };
      } else if (task.stage === "dry-run" || task.stage === "apply") {
        const analysis = await read(config.analysisReport);
        validateImportAnalysis(analysis, config.importId);
        validateImportOutcome(
          data,
          config.importId,
          analysis.approvalSha256,
          task.stage === "dry-run",
        );
        importDetails.checkpointUpdates =
          task.stage === "dry-run"
            ? {
                ["dryRunReport" + config.suffix]: reportPath(task.result),
                ["applyReport" + config.suffix]: "",
              }
            : { ["applyReport" + config.suffix]: reportPath(task.result) };
      }
    }
    if (
      action === "task-report" &&
      observation?.worker.task?.stage === "authorities-prepare" &&
      observation.worker.task.status === "completed" &&
      observation.worker.task.exitCode === 0 &&
      data?.library === config.library
    ) {
      validateRsl10Manifest(data, config.library);
      importDetails.checkpointUpdates = {
        ["package" + config.suffix]: packagePath(
          observation.worker.task.output,
          [],
        ),
        ["importId" + config.suffix]: "",
        ["stageReport" + config.suffix]: "",
        ["analysisReport" + config.suffix]: "",
        ["dryRunReport" + config.suffix]: "",
        ["applyReport" + config.suffix]: "",
      };
    }
    if (
      action === "task-report" &&
      data?.kind === "authorities" &&
      data?.manifest?.library === config.library
    ) {
      validateRsl10Stage(data, data.id, config.library);
      const state = await worker();
      if (
        state.task?.stage !== "stage" ||
        state.busy ||
        state.task.status !== "completed" ||
        state.task.exitCode !== 0
      )
        throw new Error(`Stage ${config.library} ещё не завершён успешно.`);
      const confirmed = parseJson(
        await exec([
          "docker",
          "exec",
          config.container,
          "cat",
          "--",
          reportPath(state.task.result),
        ]),
      );
      validateRsl10Stage(confirmed, data.id, config.library);
      importDetails.checkpointUpdates = {
        ["importId" + config.suffix]: data.id,
        ["stageReport" + config.suffix]: state.task.result,
        ["analysisReport" + config.suffix]: "",
        ["dryRunReport" + config.suffix]: "",
        ["applyReport" + config.suffix]: "",
      };
      if (config.library === "RSL10") {
        importDetails.importIdRsl10 = data.id;
        importDetails.stageReportRsl10 = state.task.result;
      }
    }
    // Служебные перечитывания checkpoints не должны заслонять выбранный отчёт.
    // Повторно показываем уже полученные данные, не выполняя новую серверную команду.
    if (action === "task-report" && observation) {
      const task = observation.worker.task;
      onEvent?.({
        kind: "stdout",
        text: `\n=== ОТЧЁТ ТЕКУЩЕЙ ЗАДАЧИ ===\nЗадача: ${task.id}\nЭтап: ${task.stage}\nФайл: ${task.result}\n${JSON.stringify(data, null, 2)}\n`,
      });
    }
    return {
      ...artifactResult,
      ...importDetails,
      observation,
      ok: true,
      data,
      durationMs: Date.now() - started,
      message: startIssued
        ? `Задача ${data.task.id} принята worker. Это не означает завершение обработки.`
        : "Команда выполнена.",
    };
  } catch (error) {
    const uncertain = startIssued && uncertainStarts.has(key);
    return {
      ...last,
      ...error.result,
      ok: false,
      uncertain,
      durationMs: Date.now() - started,
      message: uncertain
        ? `${error.message} Ответ запуска не подтверждён; обновите статус worker перед новым start.`
        : error.message,
    };
  }
}
module.exports = {
  validateImportAnalysis,
  validateImportOutcome,
  isImportId,
  validateRsl10Manifest,
  validateRsl10Stage,
  packagePath,
  workerDatabasePaths,
  settings,
  containerPath,
  reportPath,
  runAuthorityAction,
};
