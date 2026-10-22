import { readFile, writeFile, mkdir, rm, stat, rename } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
const VERSION = "authority-refresh-v1";
const root = "/work/control";
const stateFile = root + "/authority-batch.json";
if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}
if (process.argv.includes("--status")) {
  try {
    console.log(await readFile(stateFile, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    console.log(JSON.stringify({ status: "idle", version: VERSION }));
  }
  process.exit(0);
}
if (!process.argv.includes("--run"))
  throw Error("Use --run, --status or --version");
const { request } = await import("/app/src/runtime/control.js");
const { connectDatabase } = await import("/app/src/import/database.js");
const { to: copyTo } =
  await import("/app/node_modules/pg-copy-streams/index.js");
const config = JSON.parse(
  await readFile(root + "/authority-batch-config.json", "utf8"),
);
if (config.version !== VERSION || config.replaceAuthorities !== true)
  throw Error("Explicit refresh configuration required");
const libraries = ["RSL10", "RSL11", "TST11"];
if (
  JSON.stringify(config.inputs.map((v) => v.library)) !==
  JSON.stringify(libraries)
)
  throw Error("Exactly RSL10,RSL11,TST11 required");
const socket = root + "/worker.sock";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const backup = "/work/backups/authorities-" + runId;
const batch = {
  version: VERSION,
  id: runId,
  status: "running",
  startedAt: new Date().toISOString(),
  progress: 0,
  totalSteps: 19,
  results: [],
  backup,
};
const now = () => new Date().toISOString();
async function save() {
  batch.updatedAt = now();
  await writeFile(stateFile + ".tmp", JSON.stringify(batch, null, 2), {
    mode: 0o600,
  });
  await rename(stateFile + ".tmp", stateFile);
}
async function hash(file) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
function validateReport(value, entry, stage) {
  if (stage === "authorities-prepare") {
    if (
      value.kind !== "abis-authorities" ||
      value.library !== entry.library ||
      !value.ready ||
      !value.complete ||
      value.limited !== false ||
      value.inputSha256 !== entry.sha256
    )
      throw Error("Invalid prepared " + entry.library);
  } else if (stage === "stage") {
    if (
      value.kind !== "authorities" ||
      value.status !== "prepared" ||
      value.manifest.library !== entry.library ||
      value.rows !== entry.expected
    )
      throw Error("Invalid stage " + entry.library);
  } else {
    if (
      value.id !== entry.importId ||
      value.kind !== "authorities" ||
      value.ready !== true ||
      value.counts.blocked ||
      value.counts.conflicts ||
      value.counts.descriptionErrors
    )
      throw Error("Blocked " + stage + " " + entry.library);
    if (stage === "analyze" && !/^[0-9a-f]{64}$/.test(value.approvalSha256))
      throw Error("Missing approval");
    if (
      ["dry-run", "apply"].includes(stage) &&
      (value.approvalSha256 !== entry.approval ||
        !value.verified ||
        value.dryRun !== (stage === "dry-run") ||
        value.status !== (stage === "apply" ? "applied" : "dry-run") ||
        value.counts.insertAuthorities !== entry.expected)
    )
      throw Error("Transaction result mismatch");
    if (
      stage === "verify" &&
      (!value.verified ||
        value.counts.insertAuthorities !== 0 ||
        value.counts.existingAuthorities !== entry.expected)
    )
      throw Error("Final verification failed");
  }
}
async function task(entry, stage, options) {
  const before = await request(socket, { command: "status" });
  if (before.busy || !before.accepting || before.image !== config.image)
    throw Error("Worker not idle/accepting or image changed");
  const message = { command: "start", stage, ...options };
  let started;
  try {
    started = await request(socket, message);
  } catch (error) {
    // Потерянный ответ не повторяет start: разрешаем неопределённость только чтением статуса.
    started = await request(socket, { command: "status" });
    if (
      !started.task ||
      started.task.id === before.task?.id ||
      started.task.stage !== stage ||
      (options.input && started.task.input !== options.input) ||
      (options.importId && started.task.importId !== options.importId)
    )
      throw error;
  }
  const id = started.task?.id;
  if (!id || id === before.task?.id || started.task.stage !== stage)
    throw Error("Start not confirmed");
  batch.current = {
    library: entry.library,
    stage,
    taskId: id,
    startedAt: started.task.startedAt,
  };
  await save();
  for (;;) {
    const state = await request(socket, { command: "status" });
    if (state.task?.id !== id)
      throw Error("Another operator changed worker task");
    batch.current = {
      ...batch.current,
      status: state.task.status,
      finishedAt: state.task.finishedAt,
    };
    await save();
    if (!state.busy && state.task.status !== "running") {
      if (state.task.status !== "completed" || state.task.exitCode !== 0)
        throw Error("Task failed: " + JSON.stringify(state.task));
      const report = JSON.parse(await readFile(state.task.result, "utf8"));
      validateReport(report, entry, stage);
      entry.reports[stage] = state.task.result;
      if (stage === "authorities-prepare") {
        entry.package = state.task.output;
        entry.expected = report.counts.exported;
        entry.preparation = report.counts;
      }
      if (stage === "stage") entry.importId = report.id;
      if (stage === "analyze") entry.approval = report.approvalSha256;
      if (stage === "apply") entry.inserted = report.counts.insertAuthorities;
      if (stage === "verify") entry.verified = true;
      batch.progress++;
      await save();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}
async function backupAndClear() {
  batch.current = { stage: "backup-and-clear", startedAt: now() };
  await save();
  const db = await connectDatabase("/run/db.env");
  try {
    await db.query("BEGIN");
    await db.query(
      "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='5min'",
    );
    if (
      !(
        await db.query(
          "SELECT pg_try_advisory_xact_lock(hashtext('abis-aut-import')) locked",
        )
      ).rows[0].locked
    )
      throw Error("Another import transaction active");
    await db.query("LOCK TABLE public.authorities IN SHARE ROW EXCLUSIVE MODE");
    const fk = (
      await db.query(
        "SELECT conname FROM pg_constraint WHERE contype='f' AND confrelid='public.authorities'::regclass",
      )
    ).rows;
    if (fk.length)
      throw Error("Unexpected foreign keys; no cascading cleanup allowed");
    const before = (
      await db.query(
        "SELECT library_code,count(*)::int count FROM public.authorities GROUP BY library_code ORDER BY library_code",
      )
    ).rows;
    const aut = (
      await db.query(
        "SELECT EXISTS(SELECT 1 FROM public.document_relations WHERE lkr_type='AUT') present",
      )
    ).rows[0].present;
    await mkdir(backup, { recursive: true });
    const docs =
      "SELECT d.* FROM public.document_relations d WHERE d.lkr_type='AUT' AND (EXISTS(SELECT 1 FROM public.authorities a WHERE a.id=d.rec_key_to) OR EXISTS(SELECT 1 FROM public.authorities a WHERE a.id=d.rec_key_from))";
    const queries = {
      authorities: "SELECT * FROM public.authorities",
      authority_relations: "SELECT * FROM public.authority_relations",
      document_relations: aut
        ? docs
        : "SELECT * FROM public.document_relations WHERE false",
    };
    const files = [];
    for (const [name, query] of Object.entries(queries)) {
      const file = backup + "/" + name + ".copy.gz";
      await pipeline(
        db.query(copyTo("COPY (" + query + ") TO STDOUT")),
        createGzip(),
        createWriteStream(file, { flags: "wx", mode: 0o600, flush: true }),
      );
      files.push({
        table: "public." + name,
        file,
        sha256: await hash(file),
        bytes: (await stat(file)).size,
      });
    }
    await writeFile(
      backup + "/manifest.json",
      JSON.stringify(
        {
          version: 1,
          createdAt: now(),
          before,
          files,
          format: "PostgreSQL COPY text, gzip",
          scope: "authorities and their relations; no documents/items",
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
    let removedDocumentRelations = 0;
    if (aut)
      removedDocumentRelations = (
        await db.query(
          "DELETE FROM public.document_relations d WHERE d.lkr_type='AUT' AND (EXISTS(SELECT 1 FROM public.authorities a WHERE a.id=d.rec_key_to) OR EXISTS(SELECT 1 FROM public.authorities a WHERE a.id=d.rec_key_from))",
        )
      ).rowCount;
    const removedAuthorityRelations = (
      await db.query("DELETE FROM public.authority_relations")
    ).rowCount;
    const removedAuthorities = (
      await db.query("DELETE FROM public.authorities")
    ).rowCount;
    await db.query("COMMIT");
    batch.cleanup = {
      before,
      removedAuthorities,
      removedAuthorityRelations,
      removedDocumentRelations,
      committedAt: now(),
      backup,
    };
    batch.progress++;
    await save();
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}
await mkdir(root, { recursive: true });
await mkdir(root + "/authority-batch.lock");
try {
  await save();
  for (const input of config.inputs) {
    if (
      !input.path.startsWith("/source/") ||
      !libraries.includes(input.library) ||
      !/^[0-9a-f]{64}$/.test(input.sha256)
    )
      throw Error("Invalid source configuration");
    if ((await hash(input.path)) !== input.sha256)
      throw Error("Source SHA mismatch " + input.library);
    batch.results.push({ ...input, reports: {} });
  }
  await save();
  // Все три пакета и staging готовы до очистки public; ошибка исходника оставит старые НЗ.
  for (const entry of batch.results)
    await task(entry, "authorities-prepare", {
      input: entry.path,
      library: entry.library,
      identityPolicy:
        entry.library === "RSL10"
          ? "numeric001"
          : entry.library === "RSL11"
            ? "rsl11-nafpn"
            : "tst11-ng",
      missingFormatPolicy:
        entry.library === "TST11" ? "authority-leader-z" : "reject",
    });
  for (const entry of batch.results)
    await task(entry, "stage", { input: entry.package });
  await backupAndClear();
  for (const entry of batch.results) {
    await task(entry, "analyze", { importId: entry.importId });
    await task(entry, "dry-run", {
      importId: entry.importId,
      approval: entry.approval,
    });
    await task(entry, "apply", {
      importId: entry.importId,
      approval: entry.approval,
    });
    await task(entry, "verify", { importId: entry.importId });
  }
  const db = await connectDatabase("/run/db.env");
  try {
    batch.finalCounts = (
      await db.query(
        "SELECT library_code,count(*)::int count FROM public.authorities GROUP BY library_code ORDER BY library_code",
      )
    ).rows;
  } finally {
    await db.end();
  }
  for (const entry of batch.results)
    if (
      batch.finalCounts.find((r) => r.library_code === entry.library)?.count !==
      entry.expected
    )
      throw Error("Final count mismatch " + entry.library);
  if (batch.finalCounts.some((r) => !libraries.includes(r.library_code)))
    throw Error("Unexpected library in public");
  batch.status = "completed";
  batch.finishedAt = now();
  batch.current = null;
  await save();
} catch (error) {
  batch.status = "failed";
  batch.error = error.message;
  batch.finishedAt = now();
  await save();
  process.exitCode = 1;
} finally {
  await rm(root + "/authority-batch.lock", { recursive: true, force: true });
}
