import { DEFAULT_PERMISSIONS, MODULE_ID, SCHEMA_VERSIONS, SETTINGS } from "./constants.mjs";
import { setSetting } from "./settings.mjs";

export const PERMISSION_DEFINITIONS = Object.freeze([
  {
    key: "openWidget",
    label: "Виджет",
    shortLabel: "Виджет",
    hint: "Пользователь может открыть кассетный виджет."
  },
  {
    key: "browseUnlocked",
    label: "Библиотека",
    shortLabel: "Библ.",
    hint: "Пользователь видит доступные найденные кассеты в виджете."
  },
  {
    key: "selectCassette",
    label: "Выбор",
    shortLabel: "Выбор",
    hint: "Пользователь может вставлять доступную кассету в проигрыватель."
  },
  {
    key: "play",
    label: "Пуск",
    shortLabel: "Play",
    hint: "Пользователь может запускать выбранную дорожку."
  },
  {
    key: "pause",
    label: "Пауза",
    shortLabel: "Pause",
    hint: "Пользователь может ставить воспроизведение на паузу."
  },
  {
    key: "stop",
    label: "Стоп",
    shortLabel: "Stop",
    hint: "Пользователь может останавливать воспроизведение."
  },
  {
    key: "seek",
    label: "Перемотка",
    shortLabel: "Seek",
    hint: "Пользователь может мотать дорожку вперед и назад."
  },
  {
    key: "previous",
    label: "Предыдущая",
    shortLabel: "Prev",
    hint: "Пользователь может переключаться на предыдущую дорожку."
  },
  {
    key: "next",
    label: "Следующая",
    shortLabel: "Next",
    hint: "Пользователь может переключаться на следующую дорожку."
  },
  {
    key: "eject",
    label: "Извлечь",
    shortLabel: "Eject",
    hint: "Пользователь может извлекать текущую кассету."
  },
  {
    key: "volume",
    label: "Громкость",
    shortLabel: "Vol",
    hint: "Пользователь может менять общую громкость деки для всех клиентов. Личная громкость настраивается отдельно в параметрах модуля."
  }
]);

const CONTROLLER_TRUE = new Set([
  "openWidget",
  "browseUnlocked",
  "selectCassette",
  "play",
  "pause",
  "stop",
  "seek",
  "previous",
  "next",
  "eject",
  "volume"
]);

export function normalizePermissions(source = {}) {
  const base = foundry.utils.mergeObject(
    foundry.utils.deepClone(DEFAULT_PERMISSIONS),
    source ?? {},
    { inplace: false }
  );

  base.schemaVersion = SCHEMA_VERSIONS.permissions;
  base.defaultPlayer = normalizePermissionSet(base.defaultPlayer, DEFAULT_PERMISSIONS.defaultPlayer);

  const users = {};
  for (const [userId, value] of Object.entries(base.users ?? {})) {
    if (!userId) continue;
    const overrides = normalizePermissionOverrides(value, base.defaultPlayer);
    if (Object.keys(overrides).length) users[userId] = overrides;
  }
  base.users = users;

  return base;
}

export function normalizePermissionSet(source = {}, fallback = {}) {
  const result = {};
  for (const definition of PERMISSION_DEFINITIONS) {
    const key = definition.key;
    result[key] = Boolean(source?.[key] ?? fallback?.[key] ?? false);
  }
  return result;
}

export function normalizePermissionOverrides(source = {}, fallback = {}) {
  const result = {};
  for (const definition of PERMISSION_DEFINITIONS) {
    const key = definition.key;
    if (!Object.hasOwn(source ?? {}, key)) continue;
    const value = Boolean(source[key]);
    const inherited = Boolean(fallback?.[key] ?? false);
    if (value !== inherited) result[key] = value;
  }
  return result;
}

export function readPermissions() {
  return normalizePermissions(game.settings.get(MODULE_ID, SETTINGS.permissions) ?? {});
}

export async function savePermissions(permissions) {
  if (!game.user?.isGM) throw new Error("Only a GM can edit cassette deck permissions.");
  return setSetting(SETTINGS.permissions, normalizePermissions(permissions));
}

export async function resetPermissions() {
  if (!game.user?.isGM) throw new Error("Only a GM can reset cassette deck permissions.");
  return setSetting(SETTINGS.permissions, foundry.utils.deepClone(DEFAULT_PERMISSIONS));
}

export function buildControllerPreset() {
  const result = {};
  for (const definition of PERMISSION_DEFINITIONS) result[definition.key] = CONTROLLER_TRUE.has(definition.key);
  return result;
}

export function buildViewerPreset() {
  return normalizePermissionSet({
    openWidget: true,
    browseUnlocked: true,
    selectCassette: false
  });
}

export function buildLockedPreset() {
  return normalizePermissionSet({});
}

export function getEffectivePermissions(user = game.user) {
  if (!user) return normalizePermissionSet({});
  if (user.isGM) {
    const full = {};
    for (const definition of PERMISSION_DEFINITIONS) full[definition.key] = true;
    return full;
  }

  const permissions = readPermissions();
  return normalizePermissionSet(permissions.users?.[user.id] ?? {}, permissions.defaultPlayer);
}

export function canOpenWidget(user = game.user) {
  if (!user) return false;
  if (user.isGM) return true;
  return Boolean(getEffectivePermissions(user).openWidget);
}

export function canUseControl(action, user = game.user) {
  if (!user) return false;
  if (user.isGM) return true;
  if (typeof action !== "string" || !action) return false;

  return Boolean(getEffectivePermissions(user)[action] ?? false);
}
