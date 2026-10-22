const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, execFileSync } = require("node:child_process");
const { _electron } = require("playwright");
const defaults = require("../shared/defaults.json");

// Настоящие SSH, IPC и UI; ForceCommand моделирует Docker без доступа к рабочим данным.
// DOC-PREVIEW:/docs/authorities-workflow.md#verification
test(
  "Electron: автосохранение, default paths и процессинг НЗ через SSH",
  { timeout: 120000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-workflow-"));
    let app, daemon, page;
    try {
      const identity = path.join(root, "identity");
      execFileSync("/usr/bin/ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        identity,
      ]);
      const reserve = net.createServer();
      await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
      const port = reserve.address().port;
      await new Promise((resolve) => reserve.close(resolve));
      const fixture = path.join(root, "worker.cjs");
      fs.writeFileSync(
        fixture,
        `
const fs = require('node:fs');
const root = ${JSON.stringify(root)};
const command = process.env.SSH_ORIGINAL_COMMAND || '';
if (!command) { process.stdin.resume(); return; }
fs.appendFileSync(root + '/commands', command + '\\n');
const send = value => console.log(JSON.stringify(value));
const library=/rsl11/i.test(command)||command.includes('ceef7299-e0ec-402f-bc8c-43f66a3bf531')?'RSL11':'RSL10';
const total=library==='RSL11'?4321:198007;
const manifest = {kind:'abis-authorities',version:1,library,complete:true,limited:false,ready:true,counts:{exported:total}};
const importId = library==='RSL11'?'ceef7299-e0ec-402f-bc8c-43f66a3bf531':'f57e467d-702e-4d44-a7ef-b6d3b4f898b5';
const status = () => fs.existsSync(root + '/task') ? JSON.parse(fs.readFileSync(root + '/task')) : {busy:false, accepting:true};
if (command.includes("'inspect'")) send({state:{Running:true}, image:'sha256:fixture', command:['worker','server'], mounts:[{Source:'/data/aleph', Destination:'/source'}, {Source:'/data/migration/authorities',Destination:'/work'}]});
else if (command.includes("'worker' 'status'")) send(status());
else if (command.includes("'import' 'check-db'")) send({ready:true, blockers:[]});
else if (command.includes("'test'")) process.exit(0);
else if (command.includes("'worker' 'start'")) {
 const value = {busy:false, accepting:true,task:{id:'fixture-rsl10',stage:'authorities-prepare',status:'succeeded',input:'/source/rsl10_z00.dat',output:'/work/output/fixture-rsl10',log:'/work/reports/fixture-rsl10.log',result:'/work/reports/fixture-rsl10.json',exitCode:0,startedAt:new Date(Date.now()-20000).toISOString(),finishedAt:new Date().toISOString()}};
 if(command.includes("'--stage' 'stage'")) Object.assign(value.task,{id:'fixture-stage',stage:'stage',status:'completed',input:'/work/output/authorities-2026-10-22/RSL10',result:'/work/reports/stage.json'});
 if(command.includes("'--stage' 'analyze'")) Object.assign(value.task,{id:'fixture-analyze',stage:'analyze',status:'completed',input:undefined,importId,result:'/work/reports/analyze.json'});
 if(command.includes("'--stage' 'dry-run'")) Object.assign(value.task,{id:'fixture-dryrun',stage:'dry-run',status:'completed',input:undefined,importId,result:'/work/reports/dryrun.json'});
 if(command.includes("'--stage' 'apply'")) Object.assign(value.task,{id:'fixture-apply',stage:'apply',status:'completed',input:undefined,importId,result:'/work/reports/apply.json'});
 if(command.includes("'--stage' 'verify'")) Object.assign(value.task,{id:'fixture-verify',stage:'verify',status:'completed',input:undefined,importId,result:'/work/reports/verify.json'});
 if(library==='RSL11'){value.task.id+='-rsl11';value.task.result=value.task.result.replace('.json','-rsl11.json');if(value.task.input)value.task.input=value.task.input.replace(/rsl10/ig,'RSL11');}
 fs.writeFileSync(root + '/task', JSON.stringify(value)); send(value);
} else if (command.includes("'tail'")) console.log('Fixture: RSL10 prepared');
else if (command.includes('manifest.json')) send(manifest);
else if (command.includes('stage.json')||command.includes('stage-rsl11.json')) send({id:importId,kind:'authorities',status:'prepared',manifest});
else if (command.includes("'cat'")) {
 const stage=command.includes('dryrun')?'dry-run':command.includes('apply')?'apply':command.includes('verify')?'verify':command.includes('analyze')?'analyze':status().task?.stage;
 if(['analyze','apply','verify','dry-run'].includes(stage)) send({id:importId,kind:'authorities',ready:true,approvalSha256:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',counts:{rows:total,candidates:total,blocked:0,conflicts:0,insertAuthorities:stage==='verify'?0:total},...(stage==='apply'?{status:'applied',dryRun:false,verified:true}:stage==='verify'?{verified:true}:stage==='dry-run'?{status:'dry-run',dryRun:true,verified:true}:{})});
 else send({fixture:true,counts:{exported:3,rejected:0}});
}
else { console.error('Unexpected fixture command: ' + command); process.exit(42); }
`,
      );
      const config = path.join(root, "sshd_config");
      fs.writeFileSync(
        config,
        `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${identity}\nPidFile ${root}/pid\nAuthorizedKeysFile ${identity}.pub\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nStrictModes no\nLogLevel ERROR\nForceCommand ${process.execPath} ${fixture}\n`,
      );
      const known = path.join(root, "known_hosts");
      fs.writeFileSync(
        known,
        `[127.0.0.1]:${port} ${fs.readFileSync(identity + ".pub", "utf8")}`,
      );
      daemon = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let daemonErrors = "";
      daemon.stderr.on("data", (data) => (daemonErrors += data));
      app = await _electron.launch({
        args: [path.join(__dirname, ".."), `--user-data-dir=${root}/profile`],
      });
      await app.evaluate(({ app }, known) => {
        const pty = process
          .getBuiltinModule("module")
          .createRequire(app.getAppPath() + "/package.json")("node-pty");
        const original = pty.spawn;
        pty.spawn = (command, args, options) => {
          globalThis.workflowControl = args[args.indexOf("-S") + 1];
          return original(
            command,
            [
              "-o",
              `UserKnownHostsFile=${known}`,
              "-o",
              "StrictHostKeyChecking=yes",
              ...args,
            ],
            options,
          );
        };
      }, known);
      page = await app.firstWindow();
      await page.waitForSelector("h1");
      await page
        .getByRole("textbox", { name: "Сервер SSH", exact: true })
        .fill("127.0.0.1");
      await page
        .getByRole("spinbutton", { name: "Порт SSH", exact: true })
        .fill(String(port));
      await page
        .getByRole("textbox", { name: "Пользователь SSH", exact: true })
        .fill(os.userInfo().username);
      await app.evaluate(({ dialog }, identity) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [identity],
        });
      }, identity);
      await page
        .getByRole("button", { name: "Выбрать ключ", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Пароль БД", exact: true })
        .fill("never-persist-workflow-password");
      await page
        .getByRole("textbox", { name: "Выгрузка RSL10", exact: true })
        .fill("");
      await page.waitForFunction(
        ({ host, source }) => {
          const saved = JSON.parse(
            localStorage.getItem("svetoch.migration.profile.v1") || "{}",
          );
          return saved.ssh?.host === host && saved.source?.rsl10 === source;
        },
        { host: "127.0.0.1", source: defaults.source.rsl10 },
      );
      const saved = await page.evaluate(() =>
        localStorage.getItem("svetoch.migration.profile.v1"),
      );
      assert.ok(!saved.includes("never-persist-workflow-password"));
      await page.reload();
      assert.equal(
        await page
          .getByRole("textbox", { name: "Приватный SSH-ключ", exact: true })
          .inputValue(),
        identity,
      );
      assert.equal(
        await page
          .getByRole("textbox", { name: "Пароль БД", exact: true })
          .inputValue(),
        "never-persist-workflow-password",
      );
      await page
        .getByRole("button", { name: "Открыть SSH", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Отключить", exact: true })
        .waitFor();
      const control = await app.evaluate(() => globalThis.workflowControl);
      for (let i = 0; i < 200 && !fs.existsSync(control); i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(fs.existsSync(control), daemonErrors);
      await page
        .locator(".nav-item")
        .filter({ hasText: "Нормативные записи" })
        .click();
      await page
        .getByRole("button", { name: "Статус контейнера", exact: true })
        .click();
      await page.getByText("Контейнер запущен", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Статус worker", exact: true })
        .click();
      await page
        .getByRole("button", { name: "К процессингу", exact: true })
        .click();
      assert.equal(
        await page
          .getByRole("button", { name: "Подготовить RSL10", exact: true })
          .count(),
        0,
      );
      await page
        .getByRole("button", { name: "TST11 tst11-ng", exact: true })
        .click();
      await page
        .getByRole("heading", {
          name: "TST11: загрузка и проверка",
          exact: true,
        })
        .waitFor();
      await page
        .getByRole("button", { name: "RSL10 numeric001", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Проверить пакет RSL10", exact: true })
        .click();
      await page
        .locator(".workflow-result")
        .filter({ hasText: "198007" })
        .waitFor();
      await page
        .getByRole("button", { name: "Проверить БД worker", exact: true })
        .click();
      await page
        .locator(".workflow-result")
        .filter({ hasText: '"ready": true' })
        .waitFor();
      await page
        .getByRole("button", { name: "Загрузить RSL10 в staging", exact: true })
        .click();
      await page
        .getByText(
          "Задача fixture-stage принята worker. Это не означает завершение обработки.",
          { exact: true },
        )
        .waitFor();
      await page
        .getByRole("button", { name: "Отчёт обработки", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          JSON.parse(localStorage.getItem("svetoch.migration.profile.v1"))
            .processing.importIdRsl10 ===
          "f57e467d-702e-4d44-a7ef-b6d3b4f898b5",
      );
      await page
        .getByRole("button", {
          name: "Анализировать кандидатов RSL10",
          exact: true,
        })
        .click();
      await page
        .getByText(
          "Задача fixture-analyze принята worker. Это не означает завершение обработки.",
          { exact: true },
        )
        .waitFor();
      await page
        .getByRole("button", { name: "Отчёт обработки", exact: true })
        .click();
      await page
        .locator(".next-operation")
        .filter({ hasText: "Пробная загрузка" })
        .waitFor();
      assert.equal(
        await page
          .locator(".digest-metrics")
          .innerText()
          .then((v) => v.includes("198")),
        true,
      );
      const importId = "f57e467d-702e-4d44-a7ef-b6d3b4f898b5";
      const setTask = (id, stage, more = {}) =>
        fs.writeFileSync(
          path.join(root, "task"),
          JSON.stringify({
            busy: false,
            accepting: true,
            task: {
              id,
              stage,
              status: "completed",
              exitCode: 0,
              startedAt: new Date(Date.now() - 20000).toISOString(),
              finishedAt: new Date().toISOString(),
              result: "/work/reports/" + id + ".json",
              log: "/work/reports/" + id + ".log",
              importId,
              ...more,
            },
          }),
        );
      setTask("fixture-analyze-running", "analyze", {
        status: "running",
        exitCode: undefined,
        finishedAt: undefined,
      });
      await page
        .getByRole("button", { name: "Обновить статус задачи", exact: true })
        .click();
      await page.locator(".task-status.active").waitFor();
      assert.ok(
        (await page.getByRole("progressbar").getAttribute("aria-valuenow")) !==
          null,
      );
      await page
        .locator(".task-forecast")
        .filter({ hasText: "успешным запускам" })
        .waitFor();
      setTask("fixture-analyze-running", "analyze");
      await page
        .getByRole("button", { name: "Обновить статус задачи", exact: true })
        .click();
      // После пробной загрузки карточка не объявляет запись в public.
      await page
        .getByRole("button", { name: "Пробная загрузка RSL10", exact: true })
        .click();
      await page
        .getByText(
          "Задача fixture-dryrun принята worker. Это не означает завершение обработки.",
          { exact: true },
        )
        .waitFor();
      await page
        .getByRole("button", { name: "Обновить статус задачи", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Отчёт обработки", exact: true })
        .click();
      await page
        .getByText(
          "Пробная запись выполнена с откатом. Загружено в public: 0.",
          { exact: true },
        )
        .waitFor();
      assert.equal(await page.locator(".public-receipt").count(), 0);
      await page
        .getByRole("button", { name: "Загрузить RSL10 в public", exact: true })
        .click();
      await page
        .getByText(
          "Задача fixture-apply принята worker. Это не означает завершение обработки.",
          { exact: true },
        )
        .waitFor();
      await page
        .getByRole("button", { name: "Обновить статус задачи", exact: true })
        .click();
      assert.equal(await page.locator(".public-receipt").count(), 0);
      await page
        .getByRole("button", { name: "Отчёт обработки", exact: true })
        .click();
      await page.locator(".public-receipt").waitFor();
      assert.equal(await page.locator(".migration-celebration").count(), 0);
      await page
        .getByRole("button", { name: "Проверить результат RSL10", exact: true })
        .click();
      await page
        .getByText(
          "Задача fixture-verify принята worker. Это не означает завершение обработки.",
          { exact: true },
        )
        .waitFor();
      await page
        .getByRole("button", { name: "Обновить статус задачи", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Отчёт обработки", exact: true })
        .click();
      await page
        .getByText("Нормативные записи — в Светоче!", { exact: true })
        .waitFor();
      assert.equal(await page.locator(".next-operation").count(), 0);
      if (process.env.TASK_MONITOR_SCREENSHOT)
        await page
          .locator(".task-monitor")
          .screenshot({ path: process.env.TASK_MONITOR_SCREENSHOT });
      if (process.env.TASK_MONITOR_SCREENSHOT) {
        await page.locator(".migration-celebration").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: process.env.TASK_MONITOR_SCREENSHOT.replace(
            ".png",
            "-timeline.png",
          ),
        });
      }
      const beforeSwitch = fs.readFileSync(path.join(root, "commands"), "utf8");
      await page
        .getByRole("button", { name: "RSL11 rsl11-nafpn", exact: true })
        .click();
      await page
        .getByRole("heading", {
          name: "RSL11: загрузка и проверка",
          exact: true,
        })
        .waitFor();
      assert.equal(
        fs.readFileSync(path.join(root, "commands"), "utf8"),
        beforeSwitch,
      );
      const savedRsl10 = await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("svetoch.migration.profile.v1"))
            .processing.importIdRsl10,
      );
      for (const label of [
        "Загрузить RSL11 в staging",
        "Анализировать кандидатов RSL11",
        "Пробная загрузка RSL11",
        "Загрузить RSL11 в public",
        "Проверить результат RSL11",
      ]) {
        await page.getByRole("button", { name: label, exact: true }).click();
        await page
          .getByRole("button", { name: "Отчёт обработки", exact: true })
          .click();
        // Следующая кнопка открывается только после получения и сохранения текущего отчёта.
        await page.waitForFunction(
          () => !document.querySelector(".command-buttons .button:disabled"),
        );
      }
      await page.waitForFunction(() =>
        document
          .querySelector(".public-receipt")
          ?.textContent.replace(/\s/g, "")
          .includes("4321"),
      );
      const stored = await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("svetoch.migration.profile.v1"))
            .processing,
      );
      assert.equal(stored.importIdRsl10, savedRsl10);
      assert.equal(
        stored.importIdRsl11,
        "ceef7299-e0ec-402f-bc8c-43f66a3bf531",
      );
      assert.match(stored.applyReportRsl11, /-rsl11/);
      assert.ok(!stored.applyReportRsl10.includes("-rsl11"));
      // Перезагрузка сохраняет историю и подтверждённый apply, но не лог и не SSH-сессию UI.
      await page.reload();
      await page
        .locator(".nav-item")
        .filter({ hasText: "Нормативные записи" })
        .click();
      await page
        .getByRole("button", { name: "Процессинг Подготовка НЗ и результаты" })
        .click();
      await page
        .getByText("Нормативные записи — в Светоче!", { exact: true })
        .waitFor();
      assert.ok(
        await page
          .locator(".monitor-title")
          .innerText()
          .then((v) =>
            v.toLocaleLowerCase("ru").includes("сохранённый снимок"),
          ),
      );
      if (process.env.MIGRATION_WORKFLOW_SCREENSHOT) {
        await page
          .getByText("RSL11: загрузка и проверка", { exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: process.env.MIGRATION_WORKFLOW_SCREENSHOT,
        });
      }
      const commands = fs.readFileSync(path.join(root, "commands"), "utf8");
      assert.match(
        commands,
        /'--stage' 'stage' '--input' '\/work\/output\/authorities-2026-10-22\/RSL10'/,
      );
      assert.match(
        commands,
        /'--stage' 'analyze' '--import-id' 'f57e467d-702e-4d44-a7ef-b6d3b4f898b5'/,
      );
      assert.match(commands, /'--stage' 'dry-run' '--import-id'/);
      assert.match(commands, /'--stage' 'apply' '--import-id'/);
      assert.match(commands, /'--stage' 'verify' '--import-id'/);
      assert.ok(!commands.includes("never-persist-workflow-password"));
    } catch (error) {
      console.error(
        "Workflow alerts:",
        await page?.getByRole("alert").allTextContents(),
      );
      throw error;
    } finally {
      await app?.close();
      if (daemon && daemon.exitCode === null) {
        daemon.kill();
        await new Promise((resolve) => daemon.once("exit", resolve));
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
