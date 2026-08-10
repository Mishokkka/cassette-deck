import { DEFAULT_DECK_STATE, DEFAULT_LIBRARY, DEFAULT_PERMISSIONS, DEFAULT_WIDGET_STATE, SCHEMA_VERSIONS, SETTINGS } from "./constants.mjs";
import { logger } from "./logger.mjs";
import { getSetting, setSetting } from "./settings.mjs";
import { AuthorityService } from "./authority.mjs";
import { normalizeCassette } from "../models/cassette.mjs";
import { normalizePlaybackRate } from "../models/deck-state.mjs";

const MIGRATION_VERSION = 5;
let migrationInProgress = false;

export function isMigrationInProgress() {
  return migrationInProgress;
}

function deepClone(value) {
  return foundry.utils.deepClone(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function differs(a, b) {
  try { return JSON.stringify(stable(a)) !== JSON.stringify(stable(b)); }
  catch (_error) { return true; }
}

function normalizeWidgetPosition(position) {
  const left = Number(position?.left);
  const top = Number(position?.top);
  return Number.isFinite(left) && Number.isFinite(top) ? { left: Math.max(8, Math.round(left)), top: Math.max(8, Math.round(top)) } : null;
}

function normalizeWidgetSize(size) {
  const width = Number(size?.width);
  return Number.isFinite(width) ? { width: Math.max(320, Math.round(width)) } : null;
}

async function migrateWidgetState() {
  const raw = getSetting(SETTINGS.widgetState) ?? {};
  const current = foundry.utils.mergeObject(deepClone(DEFAULT_WIDGET_STATE), raw, { inplace: false });
  const next = {
    lastKnownPosition: normalizeWidgetPosition(current.lastKnownPosition),
    lastKnownSize: normalizeWidgetSize(current.lastKnownSize),
    browserOpen: Boolean(raw.browserOpen ?? raw.libraryOpen ?? false),
    diagnostics: Boolean(current.diagnostics),
    debugOverlay: Boolean(current.debugOverlay),
    calibrationMode: Boolean(current.calibrationMode)
  };
  if (!differs(current, next)) return false;
  await setSetting(SETTINGS.widgetState, next);
  return true;
}

function migrateCassetteEffects(source = {}) {
  const legacyPreset = source.effectPreset ?? source.preset ?? source.effect?.preset ?? source.effects?.preset;
  const legacyIntensity = source.effectIntensity ?? source.intensity ?? source.effect?.intensity ?? source.effects?.intensity;
  return {
    effects: {
      ...(source.effects ?? {}),
      preset: String(legacyPreset || "clean"),
      intensity: Number.isFinite(Number(legacyIntensity)) ? Number(legacyIntensity) : 1
    }
  };
}

function migrateLibraryValue(raw) {
  const source = foundry.utils.mergeObject(deepClone(DEFAULT_LIBRARY), raw ?? {}, { inplace: false });
  const cassettes = Array.isArray(source.cassettes) ? source.cassettes : [];
  return {
    ...source,
    schemaVersion: SCHEMA_VERSIONS.library,
    revision: Math.max(0, Number(source.revision ?? 0) || 0),
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : null,
    cassettes: cassettes.map((cassette) => normalizeCassette({ ...cassette, ...migrateCassetteEffects(cassette) }))
  };
}

function migrateDeckStateValue(raw, library) {
  const deck = foundry.utils.mergeObject(deepClone(DEFAULT_DECK_STATE), raw ?? {}, { inplace: false });
  const status = ["idle", "playing", "paused", "stopped"].includes(String(deck.status)) ? String(deck.status) : "idle";
  const cassette = library?.cassettes?.find?.((item) => item.id === deck.cassetteId) ?? null;
  const track = cassette?.tracks?.find?.((item) => item.id === deck.trackId) ?? null;
  const duration = Number(track?.duration ?? deck.duration);
  return {
    ...deck,
    schemaVersion: SCHEMA_VERSIONS.deckState,
    revision: Math.max(0, Number(deck.revision ?? 0) || 0),
    seq: Math.max(0, Number(deck.seq ?? 0) || 0),
    playbackSeq: Math.max(0, Number(deck.playbackSeq ?? deck.seq ?? 0) || 0),
    authorityEpoch: Math.max(0, Number(deck.authorityEpoch ?? 0) || 0),
    authorityUserId: deck.authorityUserId ? String(deck.authorityUserId) : null,
    authorityHeartbeatAt: Number.isFinite(Number(deck.authorityHeartbeatAt)) ? Number(deck.authorityHeartbeatAt) : null,
    command: deck.command && typeof deck.command === "object" ? deck.command : null,
    status,
    cassetteId: deck.cassetteId ? String(deck.cassetteId) : null,
    trackId: deck.trackId ? String(deck.trackId) : null,
    trackPath: track?.path ? String(track.path) : (deck.trackPath ? String(deck.trackPath) : null),
    startedAt: Number.isFinite(Number(deck.startedAt)) ? Number(deck.startedAt) : null,
    pausedAt: Number.isFinite(Number(deck.pausedAt)) ? Number(deck.pausedAt) : null,
    offset: Math.max(0, Number(deck.offset ?? 0) || 0),
    playbackRate: normalizePlaybackRate(deck.playbackRate),
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    expectedEndAt: Number.isFinite(Number(deck.expectedEndAt)) ? Number(deck.expectedEndAt) : null,
    volume: Math.min(1, Math.max(0, Number(deck.volume ?? 0.8) || 0)),
    lidOpen: Boolean(deck.lidOpen)
  };
}

function migratePermissionsValue(raw) {
  const permissions = foundry.utils.mergeObject(deepClone(DEFAULT_PERMISSIONS), raw ?? {}, { inplace: false });
  permissions.schemaVersion = SCHEMA_VERSIONS.permissions;
  permissions.defaultPlayer = foundry.utils.mergeObject(deepClone(DEFAULT_PERMISSIONS.defaultPlayer), permissions.defaultPlayer ?? {}, { inplace: false });
  permissions.users = permissions.users && typeof permissions.users === "object" ? permissions.users : {};
  return permissions;
}

async function maybeSet(key, next, label) {
  const current = getSetting(key);
  if (!differs(current, next)) return false;
  await setSetting(key, next);
  logger.info(`Migration updated ${label}.`);
  return true;
}

export async function runMigrations() {
  let changed = await migrateWidgetState();
  if (!AuthorityService.isLocalAuthority) {
    logger.log("Client migration complete. World migration is reserved for the active authority GM.");
    return { ok: true, changed, worldSkipped: true };
  }

  migrationInProgress = true;
  try {
    const installedVersion = Math.max(0, Number(getSetting(SETTINGS.migrationVersion) ?? 0) || 0);
    if (installedVersion >= MIGRATION_VERSION) {
      logger.log(`Migration already current at version ${installedVersion}.`);
      return { ok: true, changed, migrationVersion: installedVersion, current: true };
    }

    if (installedVersion < MIGRATION_VERSION) {
      await setSetting(SETTINGS.migrationBackup, {
        createdAt: Date.now(),
        fromVersion: installedVersion,
        library: deepClone(getSetting(SETTINGS.library)),
        deckState: deepClone(getSetting(SETTINGS.deckState)),
        permissions: deepClone(getSetting(SETTINGS.permissions))
      });
    }

    const library = migrateLibraryValue(getSetting(SETTINGS.library));
    changed = await maybeSet(SETTINGS.library, library, "library") || changed;
    changed = await maybeSet(SETTINGS.deckState, migrateDeckStateValue(getSetting(SETTINGS.deckState), library), "deck state") || changed;
    changed = await maybeSet(SETTINGS.permissions, migratePermissionsValue(getSetting(SETTINGS.permissions)), "permissions") || changed;
    if (installedVersion !== MIGRATION_VERSION) {
      await setSetting(SETTINGS.migrationVersion, MIGRATION_VERSION);
      changed = true;
    }

    logger.log(`Migration check complete. Changed: ${changed ? "yes" : "no"}.`);
    return { ok: true, changed, migrationVersion: MIGRATION_VERSION };
  } finally {
    migrationInProgress = false;
  }
}
