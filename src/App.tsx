import { useState, useRef, useEffect, type ReactNode } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Database,
  FileText,
  FolderOpen,
  KeyRound,
  Layers3,
  Link2,
  PlugZap,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  Unplug,
  Workflow,
} from "lucide-react";
import { type Profile, type DatabaseTestResult } from "./types";
import { TerminalPane } from "./TerminalPane";
import { TerminalDivider } from "./TerminalDivider";
import {
  loadProfile,
  persistProfile,
  effectiveSources,
  sourceDefaults,
  databasePasswordKey,
  loadDatabasePassword,
  persistDatabasePassword,
} from "./profile";
import { AuthorityPane } from "./AuthorityPane";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
function SectionTitle({
  number,
  icon,
  title,
  subtitle,
}: {
  number: string;
  icon: ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="section-heading">
      <div className="section-icon">{icon}</div>
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      <span className="section-number">{number}</span>
    </div>
  );
}
/** Управляет черновиком подключения и источников. DOC-PREVIEW:/docs/architecture.md#profile */
export default function App() {
  const [profile, setProfile] = useState<Profile>(loadProfile);
  const passwordKey = databasePasswordKey(profile);
  const [credential, setCredential] = useState(() => ({
    key: passwordKey,
    password: loadDatabasePassword(passwordKey),
  }));
  const password =
    credential.key === passwordKey
      ? credential.password
      : loadDatabasePassword(passwordKey);
  const [active, setActive] = useState("setup");
  const [authorityStep, setAuthorityStep] = useState(1);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [databaseTesting, setDatabaseTesting] = useState(false);
  const [databaseResult, setDatabaseResult] =
    useState<DatabaseTestResult | null>(null);
  const databaseEpoch = useRef(0);
  useEffect(() => {
    try {
      persistProfile(profile);
      setSaved(true);
    } catch {
      setSaved(false);
      setError(
        "Не удалось автоматически сохранить настройки. Проверьте локальное хранилище.",
      );
    }
  }, [profile]);
  function invalidateDatabase() {
    databaseEpoch.current += 1;
    setDatabaseResult(null);
  }
  /** Проверяет снимок формы; устаревший ответ не заменяет новые настройки. DOC-PREVIEW:/docs/architecture.md#database-ui */
  async function checkDatabase() {
    if (!window.desktop) {
      setDatabaseResult({
        ok: false,
        message: "Проверка БД доступна в Electron.",
        durationMs: 0,
      });
      return;
    }
    const epoch = ++databaseEpoch.current;
    setDatabaseTesting(true);
    setDatabaseResult(null);
    try {
      const result = await window.desktop.testDatabase({
        ssh: profile.ssh,
        database: profile.database,
        password,
      });
      if (epoch === databaseEpoch.current) setDatabaseResult(result);
    } catch {
      if (epoch === databaseEpoch.current)
        setDatabaseResult({
          ok: false,
          message: "Не удалось выполнить проверку подключения.",
          durationMs: 0,
        });
    } finally {
      setDatabaseTesting(false);
    }
  }
  function update(group: keyof Profile, field: string, value: string) {
    if (group !== "source") invalidateDatabase();
    setProfile((previous) => ({
      ...previous,
      [group]: { ...previous[group], [field]: value },
    }));
    setSaved(false);
  }
  function save() {
    try {
      persistProfile(profile);
      persistDatabasePassword(passwordKey, password);
      setSaved(true);
      setNotice("Профиль и пароль БД сохранены на этом компьютере.");
      setError("");
    } catch {
      setError("Не удалось сохранить профиль в локальном хранилище.");
    }
  }
  async function chooseKey() {
    if (!window.desktop) {
      setError("Выбор ключа доступен в Electron. Запустите npm start.");
      return;
    }
    try {
      setError("");
      const key = await window.desktop.choosePrivateKey();
      if (key) update("ssh", "privateKey", key);
    } catch (cause) {
      setError(String(cause));
    }
  }
  async function connect() {
    invalidateDatabase();
    setError("");
    setNotice("");
    if (!window.desktop) {
      setError("SSH доступен в приложении Electron. Запустите npm start.");
      return;
    }
    setBusy(true);
    try {
      await window.desktop.connect(profile.ssh);
      setRunning(true);
      setNotice("SSH запущен. Завершите вход в терминале справа.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    invalidateDatabase();
    try {
      await window.desktop?.disconnect();
      setRunning(false);
      setNotice("Локальный SSH-сеанс закрыт.");
    } catch (cause) {
      setError(String(cause));
    }
  }
  const sources = effectiveSources(profile.source);
  const sourceFilled = Boolean(
    sources.rsl10 && sources.rsl11 && sources.relations && sources.output,
  );
  const databaseFilled = Boolean(
    profile.database.host && profile.database.name && profile.database.user,
  );
  return (
    <div className="app-shell">
      <nav className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <BookOpen size={23} />
          </div>
          <div>
            <strong>
              светоч<span> / </span>
            </strong>
            <small>МИГРАЦИЯ ДАННЫХ</small>
          </div>
        </div>
        <div className="workspace-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <div className="workspace">
          <div className="workspace-avatar">А</div>
          <div>
            <strong>АЛЕФ → АБИС</strong>
            <small>Перенос библиотечных данных</small>
          </div>
        </div>
        <div className="nav-label">МИГРАЦИЯ</div>
        <button
          className={`nav-item ${active === "setup" ? "selected" : ""}`}
          onClick={() => setActive("setup")}
        >
          <Settings2 size={18} />
          Подключения
          <ChevronRight size={14} />
        </button>
        <button
          className={`nav-item ${active === "authorities" ? "selected" : ""}`}
          onClick={() => setActive("authorities")}
        >
          <FolderOpen size={18} />
          Нормативные записи<span className="nav-badge">НЗ</span>
        </button>
        {active === "authorities" && (
          <div className="nav-folder">
            <button
              className={authorityStep === 1 ? "selected" : ""}
              onClick={() => setAuthorityStep(1)}
            >
              1 · Проверка контейнера
            </button>
            <button
              className={authorityStep === 2 ? "selected" : ""}
              onClick={() => setAuthorityStep(2)}
            >
              2 · Процессинг
            </button>
          </div>
        )}
        <button
          className={`nav-item ${active === "relations" ? "selected" : ""}`}
          onClick={() => setActive("relations")}
        >
          <Link2 size={18} />
          Связи НЗ — БЗ
        </button>
        <div className="sidebar-note">
          <Workflow size={20} />
          <strong>
            Одна миграция.
            <br />
            Все этапы под контролем.
          </strong>
          <p>Настройте окружение, затем переходите к обработке данных.</p>
        </div>
        <div className="sidebar-bottom">
          <span className="version-dot" /> Версия 0.1 <span>Интерфейс</span>
        </div>
      </nav>
      <div className="workspace-body">
        <header className="topbar">
          <div>
            Миграция <ChevronRight size={13} />{" "}
            <strong>
              {active === "setup"
                ? "Подключения"
                : active === "authorities"
                  ? "Нормативные записи"
                  : "Связи НЗ — БЗ"}
            </strong>
          </div>
          <span className="environment">
            <span className={running ? "status-dot live" : "status-dot"} />
            {running ? "SSH-сеанс запущен" : "Нет подключения"}
          </span>
        </header>
        <div className="split-layout">
          <main className="main-content">
            <div className="page-eyebrow">
              АЛЕФ → АБИС «СВЕТОЧ» <span> / </span> ПОДГОТОВКА
            </div>
            <div className="page-heading">
              <div>
                <h1>
                  {active === "setup"
                    ? "Настройка окружения"
                    : active === "authorities"
                      ? "Нормативные записи"
                      : "Связи НЗ — БЗ"}
                </h1>
                <p>
                  {active === "setup"
                    ? "Подключите сервер и укажите данные для первого этапа миграции."
                    : active === "authorities"
                      ? "Проверка окружения, подготовка пакетов НЗ и наблюдение за задачами."
                      : "Подготовьте источники данных для связей НЗ — БЗ."}
                </p>
              </div>
              <div className="heading-icon">
                <Layers3 size={26} />
              </div>
            </div>
            <div className="steps" hidden={active === "authorities"}>
              <div className={`step ${active === "setup" ? "current" : ""}`}>
                <span>1</span>
                <strong>Окружение</strong>
              </div>
              <i />
              <div
                className={`step ${active === "authorities" ? "current" : ""}`}
              >
                <span>2</span>Нормативные записи
              </div>
              <i />
              <div
                className={`step ${active === "relations" ? "current" : ""}`}
              >
                <span>3</span>Связи НЗ — БЗ
              </div>
            </div>
            {(error || notice) && (
              <div
                className={`notice ${error ? "error" : ""}`}
                role={error ? "alert" : "status"}
              >
                {error || notice}
                <button
                  aria-label="Закрыть уведомление"
                  onClick={() => {
                    setError("");
                    setNotice("");
                  }}
                >
                  ×
                </button>
              </div>
            )}
            {active === "authorities" && (
              <AuthorityPane
                profile={profile}
                connected={running}
                step={authorityStep}
                onStep={setAuthorityStep}
                onUpdate={(field, value) => update("processing", field, value)}
                onSettings={() => setActive("setup")}
              />
            )}
            <div hidden={active === "authorities"}>
              <section
                className="card"
                id="ssh-settings"
                hidden={active !== "setup"}
              >
                <SectionTitle
                  number="01"
                  icon={<Server size={20} />}
                  title="Сервер миграции"
                  subtitle="SSH-подключение к вашему рабочему окружению"
                />
                <div className="form-grid ssh-grid">
                  <Field label="Сервер / SSH alias">
                    <input
                      aria-label="Сервер SSH"
                      placeholder="migration.example.org"
                      value={profile.ssh.host}
                      disabled={running}
                      onChange={(e) => update("ssh", "host", e.target.value)}
                    />
                  </Field>
                  <Field label="Порт">
                    <input
                      aria-label="Порт SSH"
                      type="number"
                      min="1"
                      max="65535"
                      value={profile.ssh.port}
                      disabled={running}
                      onChange={(e) => update("ssh", "port", e.target.value)}
                    />
                  </Field>
                  <Field label="Пользователь">
                    <input
                      aria-label="Пользователь SSH"
                      placeholder="operator"
                      value={profile.ssh.user}
                      disabled={running}
                      onChange={(e) => update("ssh", "user", e.target.value)}
                    />
                  </Field>
                </div>
                <div className="key-row">
                  <Field
                    label="Приватный SSH-ключ"
                    hint="Выберите файл без .pub, например id_ed25519. Парольную фразу SSH запросит в терминале."
                  >
                    <div className="input-with-button">
                      <KeyRound size={16} />
                      <input
                        aria-label="Приватный SSH-ключ"
                        placeholder="По умолчанию — настройки ~/.ssh/config"
                        value={profile.ssh.privateKey}
                        readOnly
                      />
                      <button disabled={running} onClick={chooseKey}>
                        <FolderOpen size={15} /> Выбрать ключ
                      </button>
                      {profile.ssh.privateKey && (
                        <button
                          disabled={running}
                          aria-label="Сбросить SSH-ключ"
                          onClick={() => update("ssh", "privateKey", "")}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </Field>
                </div>
                <div className="card-footer">
                  <span>
                    <ShieldCheck size={15} /> Системный SSH · ключи остаются на
                    компьютере
                  </span>
                  {running ? (
                    <button className="button secondary" onClick={disconnect}>
                      <Unplug size={15} />
                      Отключить
                    </button>
                  ) : (
                    <button
                      className="button dark"
                      disabled={busy || !profile.ssh.host || !profile.ssh.user}
                      onClick={connect}
                    >
                      <PlugZap size={15} />
                      {busy ? "Открываем…" : "Открыть SSH"}
                      <ArrowUpRight size={14} />
                    </button>
                  )}
                </div>
              </section>
              <section className="card" hidden={active !== "setup"}>
                <SectionTitle
                  number="02"
                  icon={<Database size={20} />}
                  title="База данных АБИС"
                  subtitle="Параметры PostgreSQL на стороне сервера миграции"
                />
                <fieldset
                  disabled={databaseTesting}
                  className="form-grid database-grid database-fields"
                >
                  <Field label="Хост БД">
                    <input
                      aria-label="Хост БД"
                      value={profile.database.host}
                      onChange={(e) =>
                        update("database", "host", e.target.value)
                      }
                    />
                  </Field>
                  <Field label="Порт">
                    <input
                      aria-label="Порт БД"
                      type="number"
                      min="1"
                      max="65535"
                      value={profile.database.port}
                      onChange={(e) =>
                        update("database", "port", e.target.value)
                      }
                    />
                  </Field>
                  <Field label="Имя базы">
                    <input
                      aria-label="Имя базы"
                      placeholder="abis"
                      value={profile.database.name}
                      onChange={(e) =>
                        update("database", "name", e.target.value)
                      }
                    />
                  </Field>
                  <Field label="Пользователь">
                    <input
                      aria-label="Пользователь БД"
                      placeholder="migration_user"
                      value={profile.database.user}
                      onChange={(e) =>
                        update("database", "user", e.target.value)
                      }
                    />
                  </Field>
                  <Field label="Пароль">
                    <input
                      aria-label="Пароль БД"
                      type="password"
                      autoComplete="off"
                      placeholder="Сохраняется на этом компьютере"
                      value={password}
                      onChange={(e) => {
                        invalidateDatabase();
                        const value = e.target.value;
                        setCredential({ key: passwordKey, password: value });
                        try {
                          persistDatabasePassword(passwordKey, value);
                          setSaved(true);
                        } catch {
                          setSaved(false);
                          setError(
                            "Не удалось сохранить пароль БД на этом компьютере.",
                          );
                        }
                      }}
                    />
                  </Field>
                  <Field label="SSL-режим">
                    <select
                      aria-label="SSL-режим"
                      value={profile.database.ssl}
                      onChange={(e) =>
                        update("database", "ssl", e.target.value)
                      }
                    >
                      <option value="prefer">prefer</option>
                      <option value="require">require</option>
                      <option value="verify-full">verify-full</option>
                      <option value="disable">disable</option>
                    </select>
                  </Field>
                </fieldset>
                <div className="inline-note">
                  <CircleHelp size={15} />
                  <span>
                    Адрес БД задаётся относительно сервера SSH. Проверка читает
                    параметры PostgreSQL и не изменяет данные.
                  </span>
                </div>
                {databaseResult && (
                  <div
                    className={`notice database-result ${databaseResult.ok ? "database-success" : "error"}`}
                    role={databaseResult.ok ? "status" : "alert"}
                  >
                    <div>
                      <strong>{databaseResult.message}</strong>
                      {databaseResult.details && (
                        <p>
                          База: {databaseResult.details.database} ·
                          Пользователь: {databaseResult.details.username}
                          <br />
                          PostgreSQL {databaseResult.details.version} · SSL:{" "}
                          {databaseResult.details.ssl ? "включён" : "выключен"}{" "}
                          · {databaseResult.durationMs} мс
                        </p>
                      )}
                    </div>
                  </div>
                )}
                <div className="card-footer">
                  <span>
                    {running
                      ? "Через текущее SSH-соединение"
                      : "Сначала откройте SSH и завершите вход"}
                  </span>
                  <button
                    className="button dark"
                    onClick={checkDatabase}
                    disabled={databaseTesting || !running || !databaseFilled}
                  >
                    <Database size={15} />
                    {databaseTesting ? "Проверяем…" : "Проверить подключение"}
                  </button>
                </div>
              </section>
              <section className="card">
                <SectionTitle
                  number="03"
                  icon={<FolderOpen size={20} />}
                  title="Источники данных"
                  subtitle="Абсолютные пути к файлам на удалённом сервере"
                />
                <div hidden={active === "relations"}>
                  <div className="source-label">
                    <FileText size={15} />
                    <strong>Нормативные записи</strong>
                    <span>Aleph sequential</span>
                  </div>
                  <div className="form-grid source-grid">
                    <Field label="Выгрузка RSL10">
                      <input
                        aria-label="Выгрузка RSL10"
                        placeholder={sourceDefaults.rsl10}
                        value={profile.source.rsl10}
                        onChange={(e) =>
                          update("source", "rsl10", e.target.value)
                        }
                      />
                    </Field>
                    <Field label="Выгрузка RSL11">
                      <input
                        aria-label="Выгрузка RSL11"
                        placeholder={sourceDefaults.rsl11}
                        value={profile.source.rsl11}
                        onChange={(e) =>
                          update("source", "rsl11", e.target.value)
                        }
                      />
                    </Field>
                  </div>
                </div>
                <div hidden={active === "authorities"}>
                  <div className="source-label relations-label">
                    <Link2 size={15} />
                    <strong>
                      Связи нормативных и библиографических записей
                    </strong>
                  </div>
                  <Field
                    label="Библиографическая выгрузка RSL01"
                    hint="Связи НЗ–БЗ извлекаются из ссылок на НЗ в библиографических записях."
                  >
                    <input
                      aria-label="Выгрузка RSL01"
                      placeholder={sourceDefaults.relations}
                      value={profile.source.relations}
                      onChange={(e) =>
                        update("source", "relations", e.target.value)
                      }
                    />
                  </Field>
                </div>
                <div className="output-field">
                  <Field label="Каталог результатов">
                    <input
                      aria-label="Каталог результатов"
                      placeholder={sourceDefaults.output}
                      value={profile.source.output}
                      onChange={(e) =>
                        update("source", "output", e.target.value)
                      }
                    />
                  </Field>
                </div>
                <div className="inline-note">
                  <CircleHelp size={15} />
                  <span>
                    Пустые поля используют пути из подсказок. Настройки
                    сохраняются автоматически. Подготовка НЗ запускается в
                    разделе «Нормативные записи».
                  </span>
                </div>
              </section>
              <div className="bottom-actions">
                <span>
                  {saved ? <CheckCircle2 size={16} /> : <Save size={16} />}
                  {saved
                    ? "Настройки сохранены автоматически"
                    : "Автосохранение настроек…"}
                </span>
                <button className="button primary" onClick={save}>
                  {saved ? <Check size={16} /> : <Save size={16} />}Сохранить
                  настройки
                  <ArrowRight size={15} />
                </button>
              </div>
              <div className="readiness">
                <span className={databaseFilled ? "ready" : ""}>
                  База: {databaseFilled ? "параметры заданы" : "не настроена"}
                </span>
                <span className={sourceFilled ? "ready" : ""}>
                  Источники: {sourceFilled ? "пути заданы" : "не заданы"}
                </span>
                <span>
                  {databaseResult?.ok
                    ? "Соединение с БД проверено · файлы не проверены"
                    : "Подключение к БД и файлы не проверены"}
                </span>
              </div>
            </div>
          </main>
          <TerminalDivider />
          <TerminalPane
            running={running}
            onExit={(code) => {
              invalidateDatabase();
              setRunning(false);
              setNotice(`SSH-сеанс завершён с кодом ${code}.`);
            }}
          />
        </div>
      </div>
    </div>
  );
}
