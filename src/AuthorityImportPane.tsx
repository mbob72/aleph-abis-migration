import { ArrowRight, Database, FileCheck2, Play } from "lucide-react";
import type { AuthorityAction, Profile } from "./types";
import defaults from "../shared/defaults.json";
type Props = {
  settings: Profile["processing"];
  disabled: boolean;
  canStart: boolean;
  onUpdate: (field: string, value: string) => void;
  run: (action: AuthorityAction) => void;
};
/** Общий маршрут с отдельными checkpoints RSL10/RSL11/TST11. DOC-PREVIEW:/docs/architecture.md#authority-libraries */
export function AuthorityImportPane({
  settings,
  disabled,
  canStart,
  onUpdate,
  run,
}: Props) {
  const library = ["RSL10", "RSL11", "TST11"].includes(settings.library)
    ? (settings.library as "RSL10" | "RSL11" | "TST11")
    : "RSL10";
  const suffix =
    library === "TST11" ? "Tst11" : library === "RSL11" ? "Rsl11" : "Rsl10";
  const fields = {
    package: `package${suffix}`,
    importId: `importId${suffix}`,
    stageReport: `stageReport${suffix}`,
    analysisReport: `analysisReport${suffix}`,
    dryRunReport: `dryRunReport${suffix}`,
    applyReport: `applyReport${suffix}`,
  } as const;
  const current = {
    package: settings[fields.package],
    importId: settings[fields.importId],
    stageReport: settings[fields.stageReport],
    analysisReport: settings[fields.analysisReport],
    dryRunReport: settings[fields.dryRunReport],
    applyReport: settings[fields.applyReport],
  };
  const hasId = Boolean(current.importId.trim());
  const action = (stage: string) =>
    `${stage}-${library.toLowerCase()}` as AuthorityAction;
  function resetFrom(field: keyof typeof fields, value: string) {
    onUpdate(fields[field], value);
    const order = Object.keys(fields) as (keyof typeof fields)[];
    for (const next of order.slice(order.indexOf(field) + 1))
      onUpdate(fields[next], "");
  }
  const operations = [
    {
      number: 1,
      action: action("stage"),
      title: "Загрузить пакет в промежуточные таблицы",
      description: "Проверка SHA и загрузка в aut_import без записи в public.",
      label: `Загрузить ${library} в staging`,
      ready: true,
      done: hasId,
    },
    {
      number: 2,
      action: action("analyze"),
      title: "Проанализировать кандидатов",
      description:
        "Сопоставление с АБИС и поиск препятствий перед пробной записью.",
      label: `Анализировать кандидатов ${library}`,
      ready: hasId && Boolean(current.stageReport),
      done: Boolean(current.analysisReport),
    },
    {
      number: 3,
      action: action("dry-run"),
      title: "Пробная загрузка с откатом",
      description:
        "Пробная запись и проверка в транзакции с отменой изменений.",
      label: `Пробная загрузка ${library}`,
      ready: Boolean(current.analysisReport),
      done: Boolean(current.dryRunReport),
    },
    {
      number: 4,
      action: action("apply"),
      title: "Загрузить нормативные записи в public",
      description:
        "Фактическая запись в БД после успешного dry-run того же анализа.",
      label: `Загрузить ${library} в public`,
      ready: Boolean(current.dryRunReport),
      done: Boolean(current.applyReport),
    },
    {
      number: 5,
      action: action("verify"),
      title: "Проверить итоговую загрузку",
      description:
        "Сверка результата импорта с анализом и подтверждение завершения.",
      label: `Проверить результат ${library}`,
      ready: Boolean(current.applyReport),
      done: false,
    },
  ];
  return (
    <section className="card workflow-card staging-card">
      <div className="section-heading">
        <div className="section-icon">
          <Database size={20} />
        </div>
        <div>
          <h2>{library}: загрузка и проверка</h2>
          <p>Отдельные пакет, импорт и отчёты для каждой библиотеки.</p>
        </div>
      </div>
      <div
        className="library-switch"
        role="group"
        aria-label="Библиотека нормативных записей"
      >
        {(["RSL10", "RSL11", "TST11"] as const).map((value) => (
          <button
            key={value}
            className={value === library ? "selected" : ""}
            aria-pressed={value === library}
            disabled={disabled}
            onClick={() => onUpdate("library", value)}
          >
            {value}
            <small>
              {value === "TST11"
                ? "tst11-ng"
                : value === "RSL10"
                  ? "numeric001"
                  : "rsl11-nafpn"}
            </small>
          </button>
        ))}
      </div>
      <div className="stage-route">
        <span>Готовый пакет</span>
        <ArrowRight size={13} />
        <strong>aut_import</strong>
        <ArrowRight size={13} />
        <span>Кандидаты</span>
        <ArrowRight size={13} />
        <span>Пробная загрузка</span>
        <ArrowRight size={13} />
        <span>public</span>
        <ArrowRight size={13} />
        <span>Проверка</span>
      </div>
      <label className="field">
        <span className="field-label">Готовый пакет {library}</span>
        <input
          aria-label={`Готовый пакет ${library}`}
          value={current.package}
          disabled={disabled}
          placeholder={defaults.processing[fields.package]}
          onChange={(e) => resetFrom("package", e.target.value)}
        />
        <span className="field-hint">
          Каталог с manifest.json, authorities.ndjson.gz и diagnostics.ndjson.
          Проверьте готовый пакет перед загрузкой в staging.
        </span>
      </label>
      <div className="command-buttons">
        <button
          className="button secondary"
          disabled={disabled}
          onClick={() => run("inspect-package")}
        >
          <FileCheck2 size={15} />
          Проверить пакет {library}
        </button>
        <button
          className="button secondary"
          disabled={disabled}
          onClick={() => run("check-worker-db")}
        >
          <Database size={15} />
          Проверить БД worker
        </button>
      </div>
      {operations.map((operation) => (
        <div
          className={`staging-operation ${!operation.ready ? "future-operation" : ""}`}
          key={operation.action}
        >
          <span className="operation-number">
            {operation.done ? "✓" : operation.number}
          </span>
          <div>
            <h3>{operation.title}</h3>
            <p>{operation.description}</p>
          </div>
          <button
            className={`button ${operation.number === 1 || operation.number === 4 ? "primary" : operation.number === 2 ? "dark" : "secondary"}`}
            disabled={
              disabled || !canStart || !operation.ready || operation.done
            }
            onClick={() => run(operation.action)}
          >
            <Play size={14} />
            {operation.done ? "Выполнено" : operation.label}
          </button>
        </div>
      ))}
      <p className="workflow-description">
        После каждого этапа: обновите статус до completed / exit 0, затем
        нажмите «Отчёт обработки». Следующая кнопка откроется после проверки
        отчёта. Выбор библиотеки и чтение отчётов не запускают новые задачи.
      </p>
      <details className="checkpoint-paths">
        <summary>Подтверждённые отчёты и ID импорта · {library}</summary>
        <div className="form-grid source-grid">
          <label className="field">
            <span className="field-label">ID импорта {library}</span>
            <input
              aria-label={`ID импорта ${library}`}
              value={current.importId}
              disabled={disabled}
              placeholder="UUID из отчёта stage"
              onChange={(e) => resetFrom("importId", e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Отчёт stage в контейнере</span>
            <input
              aria-label={`Отчёт stage ${library}`}
              value={current.stageReport}
              disabled={disabled}
              placeholder="/work/reports/<stage-task.id>.json"
              onChange={(e) => resetFrom("stageReport", e.target.value)}
            />
          </label>
        </div>
        {(["analysisReport", "dryRunReport", "applyReport"] as const).map(
          (field) => (
            <label className="field" key={field}>
              <span className="field-label">
                {field === "analysisReport"
                  ? "Отчёт анализа"
                  : field === "dryRunReport"
                    ? "Отчёт dry-run"
                    : "Отчёт apply"}{" "}
                {library}
              </span>
              <input
                aria-label={`${field === "analysisReport" ? "Отчёт анализа" : field === "dryRunReport" ? "Отчёт dry-run" : "Отчёт apply"} ${library}`}
                value={current[field]}
                disabled={disabled}
                placeholder="Заполняется после чтения отчёта"
                onChange={(e) => resetFrom(field, e.target.value)}
              />
            </label>
          ),
        )}
      </details>
      <div className="inline-note">
        <Database size={15} />
        <span>
          Используется подключение серверного worker к БД. Поле пароля из формы
          подключения не изменяет конфигурацию worker.
        </span>
      </div>
    </section>
  );
}
