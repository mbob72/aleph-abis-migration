import { emptyProfile, type Profile } from "./types";
import defaults from "../shared/defaults.json";
export const storageKey = "svetoch.migration.profile.v1";
export const sourceDefaults = defaults.source;

/** Пустые источники получают те же пути, что показаны в placeholder. DOC-PREVIEW:/docs/architecture.md#profile-storage */
export function effectiveSources(source: Profile["source"]): Profile["source"] {
  return Object.fromEntries(
    Object.entries(sourceDefaults).map(([key, fallback]) => [
      key,
      source[key as keyof typeof source]?.trim() || fallback,
    ]),
  ) as Profile["source"];
}
/** Восстанавливает только известные строковые поля; пароль не входит в профиль. DOC-PREVIEW:/docs/architecture.md#profile-storage */
export function loadProfile(): Profile {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    const result = structuredClone(emptyProfile);
    for (const group of ["ssh", "database", "source", "processing"] as const) {
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
/** Пишет профиль без неизвестных полей и с эффективными путями. DOC-PREVIEW:/docs/architecture.md#profile-storage */
export function persistProfile(profile: Profile): void {
  const safe = structuredClone(emptyProfile);
  for (const group of ["ssh", "database", "source", "processing"] as const) {
    for (const key of Object.keys(safe[group])) {
      const value = (profile[group] as Record<string, string>)[key];
      if (typeof value === "string")
        (safe[group] as Record<string, string>)[key] = value;
    }
  }
  safe.source = effectiveSources(safe.source);
  localStorage.setItem(storageKey, JSON.stringify(safe));
}

/** Отдельное локальное сохранение пароля для конкретного SSH/БД-подключения. DOC-PREVIEW:/docs/architecture.md#database-password */
export function databasePasswordKey(profile: Profile): string {
  return (
    "svetoch.database.password.v1:" +
    JSON.stringify([
      profile.ssh.host.trim(),
      profile.ssh.port.trim(),
      profile.ssh.user.trim(),
      profile.database.host.trim(),
      profile.database.port.trim(),
      profile.database.name.trim(),
      profile.database.user.trim(),
    ])
  );
}
export function loadDatabasePassword(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
export function persistDatabasePassword(key: string, password: string): void {
  if (password) localStorage.setItem(key, password);
  else localStorage.removeItem(key);
}
