import { useState, type ReactNode } from "react";
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
import { emptyProfile, type Profile } from "./types";
import { TerminalPane } from "./TerminalPane";

const storageKey = "svetoch.migration.profile.v1";
/** Загружает только несекретные поля профиля. DOC-PREVIEW:/docs/architecture.md#profile */
function loadProfile(): Profile {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    const result = structuredClone(emptyProfile);
    for (const group of ["ssh", "database", "source"] as const) {
      for (const key of Object.keys(result[group])) {
        const value = saved?.[group]?.[key];
        if (typeof value === "string")
          (result[group] as Record<string, string>)[key] = value;
      }
    }
    return result;
  } catch {
    return structuredClone(emptyProfile);
  }
}
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
  const [password, setPassword] = useState("");
  const [active, setActive] = useState("setup");
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  function update(group: keyof Profile, field: string, value: string) {
    setProfile((previous) => ({
      ...previous,
      [group]: { ...previous[group], [field]: value },
    }));
    setSaved(false);
  }
  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(profile));
      setSaved(true);
      setNotice(
        "Профиль сохранён на этом компьютере. Пароль БД не сохраняется.",
      );
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
      const key = await window.desktop.choosePublicKey();
      if (key) update("ssh", "publicKey", key);
    } catch (cause) {
      setError(String(cause));
    }
  }
  async function connect() {
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
    try {
      await window.desktop?.disconnect();
      setRunning(false);
      setNotice("Локальный SSH-сеанс закрыт.");
    } catch (cause) {
      setError(String(cause));
    }
  }
  const sourceFilled = Boolean(
    profile.source.rsl10 &&
    profile.source.rsl11 &&
    profile.source.relations &&
    profile.source.output,
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
          <FileText size={18} />
          Нормативные записи<span className="nav-badge">НЗ</span>
        </button>
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
                    : "Подготовьте источники данных. Обработка появится на следующем этапе."}
                </p>
              </div>
              <div className="heading-icon">
                <Layers3 size={26} />
              </div>
            </div>
            <div className="steps">
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
                  label="Публичный SSH-ключ"
                  hint="Соответствующий приватный ключ должен быть доступен SSH-agent."
                >
                  <div className="input-with-button">
                    <KeyRound size={16} />
                    <input
                      aria-label="Публичный SSH-ключ"
                      placeholder="По умолчанию — настройки ~/.ssh/config"
                      value={profile.ssh.publicKey}
                      readOnly
                    />
                    <button disabled={running} onClick={chooseKey}>
                      <FolderOpen size={15} /> Выбрать .pub
                    </button>
                    {profile.ssh.publicKey && (
                      <button
                        disabled={running}
                        aria-label="Сбросить SSH-ключ"
                        onClick={() => update("ssh", "publicKey", "")}
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
              <div className="form-grid database-grid">
                <Field label="Хост БД">
                  <input
                    aria-label="Хост БД"
                    value={profile.database.host}
                    onChange={(e) => update("database", "host", e.target.value)}
                  />
                </Field>
                <Field label="Порт">
                  <input
                    aria-label="Порт БД"
                    type="number"
                    min="1"
                    max="65535"
                    value={profile.database.port}
                    onChange={(e) => update("database", "port", e.target.value)}
                  />
                </Field>
                <Field label="Имя базы">
                  <input
                    aria-label="Имя базы"
                    placeholder="abis"
                    value={profile.database.name}
                    onChange={(e) => update("database", "name", e.target.value)}
                  />
                </Field>
                <Field label="Пользователь">
                  <input
                    aria-label="Пользователь БД"
                    placeholder="migration_user"
                    value={profile.database.user}
                    onChange={(e) => update("database", "user", e.target.value)}
                  />
                </Field>
                <Field label="Пароль">
                  <input
                    aria-label="Пароль БД"
                    type="password"
                    autoComplete="off"
                    placeholder="Не сохраняется"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                <Field label="SSL-режим">
                  <select
                    aria-label="SSL-режим"
                    value={profile.database.ssl}
                    onChange={(e) => update("database", "ssl", e.target.value)}
                  >
                    <option value="prefer">prefer</option>
                    <option value="require">require</option>
                    <option value="verify-full">verify-full</option>
                    <option value="disable">disable</option>
                  </select>
                </Field>
              </div>
              <div className="inline-note">
                <CircleHelp size={15} />
                <span>
                  Адрес БД задаётся относительно сервера. Проверка подключения
                  будет доступна на следующем этапе.
                </span>
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
                      placeholder="/data/aleph/rsl10_z00.dat"
                      value={profile.source.rsl10}
                      onChange={(e) =>
                        update("source", "rsl10", e.target.value)
                      }
                    />
                  </Field>
                  <Field label="Выгрузка RSL11">
                    <input
                      aria-label="Выгрузка RSL11"
                      placeholder="/data/aleph/rsl11_z00.dat"
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
                  <strong>Связи нормативных и библиографических записей</strong>
                </div>
                <Field
                  label="Библиографическая выгрузка RSL01"
                  hint="Связи НЗ–БЗ извлекаются из ссылок на НЗ в библиографических записях."
                >
                  <input
                    aria-label="Выгрузка RSL01"
                    placeholder="/data/aleph/rsl01_z00.dat"
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
                    placeholder="/data/migration/authorities"
                    value={profile.source.output}
                    onChange={(e) => update("source", "output", e.target.value)}
                  />
                </Field>
              </div>
              <div className="inline-note">
                <CircleHelp size={15} />
                <span>
                  Пути сохраняются в профиле. Чтение файлов и запуск миграции
                  пока не выполняются.
                </span>
              </div>
            </section>
            <div className="bottom-actions">
              <span>
                {saved ? <CheckCircle2 size={16} /> : <Save size={16} />}
                {saved
                  ? "Профиль сохранён"
                  : "Профиль хранится только локально"}
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
              <span>Подключения и файлы не проверены</span>
            </div>
          </main>
          <TerminalPane
            running={running}
            onExit={(code) => {
              setRunning(false);
              setNotice(`SSH-сеанс завершён с кодом ${code}.`);
            }}
          />
        </div>
      </div>
    </div>
  );
}
