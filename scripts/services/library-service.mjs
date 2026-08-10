import { DEFAULT_LIBRARY, SCHEMA_VERSIONS, SETTINGS } from "../core/constants.mjs";
import { getSetting, setSetting } from "../core/settings.mjs";
import { createEmptyCassette, normalizeCassette } from "../models/cassette.mjs";
import { isSafeAudioPath } from "../models/validators.mjs";
import { codedError } from "../core/utils.mjs";
import { AuthorityService } from "../core/authority.mjs";


let librarySnapshotCache = null;
let libraryWriteQueue = Promise.resolve();

function cloneValue(value) {
  return foundry.utils.deepClone(value);
}

function getLibrarySnapshot() {
  const raw = getSetting(SETTINGS.library) ?? DEFAULT_LIBRARY;
  const revision = Math.max(0, Number(raw?.revision ?? 0) || 0);
  const updatedAt = Number.isFinite(Number(raw?.updatedAt)) ? Number(raw.updatedAt) : null;
  const cassetteCount = Array.isArray(raw?.cassettes) ? raw.cassettes.length : 0;

  if (librarySnapshotCache
    && librarySnapshotCache.raw === raw
    && librarySnapshotCache.revision === revision
    && librarySnapshotCache.updatedAt === updatedAt
    && librarySnapshotCache.cassetteCount === cassetteCount) {
    return librarySnapshotCache;
  }

  if (librarySnapshotCache
    && librarySnapshotCache.revision === revision
    && librarySnapshotCache.updatedAt === updatedAt
    && librarySnapshotCache.cassetteCount === cassetteCount) {
    return librarySnapshotCache;
  }

  const library = normalizeLibrary(raw);
  librarySnapshotCache = {
    raw,
    revision: library.revision,
    updatedAt: library.updatedAt,
    cassetteCount: library.cassettes.length,
    library,
    byId: new Map(library.cassettes.map((cassette) => [cassette.id, cassette]))
  };
  return librarySnapshotCache;
}

export function invalidateLibraryCache() {
  librarySnapshotCache = null;
}

function requireGM() {
  if (!game.user?.isGM) throw codedError("Only a GM can edit the cassette library.", "GM_ONLY");
}

export function normalizeLibrary(source = {}) {
  const library = foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_LIBRARY), source ?? {}, { inplace: false });
  library.schemaVersion = SCHEMA_VERSIONS.library;
  library.revision = Math.max(0, Number(library.revision ?? 0) || 0);
  library.updatedAt = Number.isFinite(Number(library.updatedAt)) ? Number(library.updatedAt) : null;
  library.cassettes = Array.isArray(library.cassettes)
    ? library.cassettes.map(normalizeCassette).sort((a, b) => (a.sort - b.sort) || a.title.localeCompare(b.title))
    : [];
  return library;
}

function assertSafeCassette(cassette) {
  for (const track of cassette.tracks ?? []) {
    if (track.path && !isSafeAudioPath(track.path, { allowRemote: false })) throw codedError(`Unsafe or unsupported audio path: ${track.path}`, "UNSAFE_AUDIO_PATH");
  }
}

function assertLibraryValid(library) {
  for (const cassette of library.cassettes) assertSafeCassette(cassette);
  const inspection = inspectNormalizedLibrary(library);
  const blocking = inspection.issues.filter((issue) => ["duplicate-cassette-id", "duplicate-track-id", "unsafe-audio-path"].includes(issue.type));
  if (blocking.length) throw codedError(`Library validation failed: ${blocking.map((issue) => issue.type).join(", ")}`, "LIBRARY_INVALID", { issues: blocking });
}

export function readLibrary() {
  return cloneValue(getLibrarySnapshot().library);
}

export function readVisibleLibrary(user = game.user) {
  const library = readLibrary();
  if (user?.isGM) return library;
  library.cassettes = library.cassettes.filter((cassette) => isCassetteVisibleToUser(cassette, user));
  return library;
}

export function getCassetteSummaries({ visibleTo = game.user } = {}) {
  const cassettes = getLibrarySnapshot().library.cassettes ?? [];
  const visible = (!visibleTo || visibleTo.isGM)
    ? cassettes
    : cassettes.filter((cassette) => isCassetteVisibleToUser(cassette, visibleTo));
  return visible.map((cassette) => ({
    id: cassette.id,
    title: cassette.title,
    trackCount: Array.isArray(cassette.tracks) ? cassette.tracks.length : 0
  }));
}

export function getVisibleTrackSummaries({ visibleTo = game.user, limit = Infinity } = {}) {
  const max = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : Infinity;
  if (max === 0) return [];

  const result = [];
  const seenPaths = new Set();
  for (const cassette of getLibrarySnapshot().library.cassettes ?? []) {
    if (visibleTo && !visibleTo.isGM && !isCassetteVisibleToUser(cassette, visibleTo)) continue;
    for (const track of cassette.tracks ?? []) {
      const path = String(track?.path || "").trim();
      if (!path || seenPaths.has(path)) continue;
      seenPaths.add(path);
      result.push({ id: track.id, path, duration: track.duration ?? null });
      if (result.length >= max) return result;
    }
  }
  return result;
}

export function getCassettes({ visibleTo = game.user } = {}) {
  const cassettes = getLibrarySnapshot().library.cassettes ?? [];
  const visible = (!visibleTo || visibleTo.isGM)
    ? cassettes
    : cassettes.filter((cassette) => isCassetteVisibleToUser(cassette, visibleTo));
  return cloneValue(visible);
}

export function getCassetteById(cassetteId) {
  const cassette = getLibrarySnapshot().byId.get(cassetteId) ?? null;
  return cassette ? cloneValue(cassette) : null;
}

export function getVisibleCassetteById(cassetteId, user = game.user) {
  const cassette = getLibrarySnapshot().byId.get(cassetteId) ?? null;
  if (!cassette || !isCassetteVisibleToUser(cassette, user)) return null;
  return cloneValue(cassette);
}

export function isCassetteVisibleToUser(cassette, user = game.user) {
  if (!cassette || !user) return false;
  if (user.isGM) return true;
  if (!cassette.discovered) return false;
  const mode = cassette.access?.mode ?? "locked";
  if (mode === "unlocked") return true;
  if (mode === "locked") return false;
  if (mode === "users") return Array.isArray(cassette.access?.users) && cassette.access.users.includes(user.id);
  if (mode === "roles") return Array.isArray(cassette.access?.roles) && cassette.access.roles.includes(String(user.role));
  return false;
}

export async function writeLibrary(library, { expectedRevision = null } = {}) {
  requireGM();
  if (AuthorityService.isLocalAuthority) return writeLibraryAsAuthority(library, { expectedRevision });

  const authorityUserId = AuthorityService.authorityUserId;
  if (!authorityUserId) throw codedError("No active Cassette Deck authority GM is available.", "NO_ACTIVE_GM");

  // Keep the write path single-writer across multiple GM clients. The dynamic
  // import avoids a static library-service <-> socket module cycle.
  const { CassetteSocket } = await import("../core/socket.mjs");
  return CassetteSocket.writeLibrary(library, { expectedRevision });
}

export async function writeLibraryAsAuthority(library, { expectedRevision = null } = {}) {
  requireGM();
  AuthorityService.assertLocalAuthority();

  const run = libraryWriteQueue.then(async () => {
    const currentRevision = getLibrarySnapshot().revision;
    if (expectedRevision !== null && Number(expectedRevision) !== currentRevision) {
      throw codedError("The cassette library changed in another GM window. Reload before saving.", "LIBRARY_CONFLICT", { expectedRevision, actualRevision: currentRevision });
    }
    const next = normalizeLibrary(library);
    assertLibraryValid(next);
    next.revision = currentRevision + 1;
    next.updatedAt = Date.now();
    await setSetting(SETTINGS.library, next);
    invalidateLibraryCache();
    return cloneValue(next);
  });

  libraryWriteQueue = run.catch(() => undefined);
  return run;
}

async function mutateLibrary(mutator) {
  const library = readLibrary();
  const expectedRevision = library.revision;
  const result = await mutator(library);
  const saved = await writeLibrary(library, { expectedRevision });
  return { result, library: saved };
}

export async function createCassette() {
  requireGM();
  const { result } = await mutateLibrary((library) => {
    const cassette = createEmptyCassette();
    cassette.sort = library.cassettes.reduce((highest, item) => Math.max(highest, Number(item.sort) || 0), 0) + 10;
    library.cassettes.push(cassette);
    return cassette;
  });
  return result;
}

export async function duplicateCassette(cassetteData) {
  requireGM();
  const source = typeof cassetteData === "string" ? getCassetteById(cassetteData) : normalizeCassette(cassetteData);
  if (!source) throw codedError("Cassette not found.", "NOT_FOUND");
  const { result } = await mutateLibrary((library) => {
    const copy = normalizeCassette({
      ...foundry.utils.deepClone(source),
      id: foundry.utils.randomID(),
      title: `${source.title || "Кассета"} — копия`,
      sort: library.cassettes.reduce((highest, item) => Math.max(highest, Number(item.sort) || 0), 0) + 10,
      tracks: (source.tracks ?? []).map((track) => ({ ...foundry.utils.deepClone(track), id: foundry.utils.randomID() }))
    });
    assertSafeCassette(copy);
    library.cassettes.push(copy);
    return copy;
  });
  return result;
}

export async function moveCassette(cassetteId, direction = 0) {
  requireGM();
  const { result } = await mutateLibrary((library) => {
    const index = library.cassettes.findIndex((cassette) => cassette.id === cassetteId);
    if (index < 0) return null;
    const targetIndex = Math.max(0, Math.min(library.cassettes.length - 1, index + (Number(direction) < 0 ? -1 : 1)));
    if (targetIndex === index) return library.cassettes[index];
    const [cassette] = library.cassettes.splice(index, 1);
    library.cassettes.splice(targetIndex, 0, cassette);
    library.cassettes = library.cassettes.map((item, itemIndex) => ({ ...item, sort: (itemIndex + 1) * 10 }));
    return cassette;
  });
  return result;
}

export async function normalizeLibrarySort() {
  requireGM();
  const { library } = await mutateLibrary((value) => {
    value.cassettes = value.cassettes.map((cassette, index) => ({ ...cassette, sort: (index + 1) * 10 }));
  });
  return library;
}

function inspectNormalizedLibrary(normalized) {
  const cassetteIds = new Set();
  const issues = [];
  let trackCount = 0;
  for (const cassette of normalized.cassettes) {
    if (cassetteIds.has(cassette.id)) issues.push({ type: "duplicate-cassette-id", cassetteId: cassette.id, cassetteTitle: cassette.title });
    cassetteIds.add(cassette.id);
    const trackIds = new Set();
    for (const track of cassette.tracks ?? []) {
      trackCount += 1;
      if (trackIds.has(track.id)) issues.push({ type: "duplicate-track-id", cassetteId: cassette.id, trackId: track.id, trackTitle: track.title });
      trackIds.add(track.id);
      if (track.path && !isSafeAudioPath(track.path, { allowRemote: false })) issues.push({ type: "unsafe-audio-path", cassetteId: cassette.id, trackId: track.id, path: track.path });
    }
  }
  return {
    ok: issues.length === 0,
    cassetteCount: normalized.cassettes.length,
    trackCount,
    issueCount: issues.length,
    issues
  };
}

export function inspectLibrary(libraryData = null) {
  if (libraryData === null) requireGM();
  const normalized = libraryData === null ? getLibrarySnapshot().library : normalizeLibrary(libraryData);
  return inspectNormalizedLibrary(normalized);
}

export async function repairLibrary({ clearUnsafePaths = true, dedupeIds = true, normalizeSort = true } = {}) {
  requireGM();
  const library = readLibrary();
  const expectedRevision = library.revision;
  const fixes = [];
  const cassetteIds = new Set();
  for (const [cassetteIndex, cassette] of library.cassettes.entries()) {
    if (dedupeIds && cassetteIds.has(cassette.id)) {
      const oldId = cassette.id; cassette.id = foundry.utils.randomID(); fixes.push({ type: "cassette-id-regenerated", oldId, newId: cassette.id });
    }
    cassetteIds.add(cassette.id);
    const trackIds = new Set();
    for (const [trackIndex, track] of (cassette.tracks ?? []).entries()) {
      if (dedupeIds && trackIds.has(track.id)) {
        const oldId = track.id; track.id = foundry.utils.randomID(); fixes.push({ type: "track-id-regenerated", cassetteId: cassette.id, oldId, newId: track.id });
      }
      trackIds.add(track.id);
      if (clearUnsafePaths && track.path && !isSafeAudioPath(track.path, { allowRemote: false })) {
        fixes.push({ type: "audio-path-cleared", cassetteId: cassette.id, trackId: track.id, oldPath: track.path }); track.path = ""; track.duration = null;
      }
      if (!Number.isFinite(Number(track.duration)) || Number(track.duration) < 0) track.duration = null;
      if (!track.title) { track.title = `Дорожка ${trackIndex + 1}`; fixes.push({ type: "track-title-filled", cassetteId: cassette.id, trackId: track.id }); }
    }
    if (!cassette.title) { cassette.title = `Кассета ${cassetteIndex + 1}`; fixes.push({ type: "cassette-title-filled", cassetteId: cassette.id }); }
  }
  if (normalizeSort) library.cassettes = library.cassettes.map((cassette, index) => ({ ...cassette, sort: (index + 1) * 10 }));
  const saved = await writeLibrary(library, { expectedRevision });
  return { ok: true, changed: fixes.length > 0, fixCount: fixes.length, fixes, inspection: inspectLibrary(saved), library: saved };
}

export function previewLibraryImport(libraryData) {
  requireGM();
  const source = libraryData?.library ?? libraryData;
  const incoming = normalizeLibrary(source);
  assertLibraryValid(incoming);
  const current = readLibrary();
  const currentIds = new Set(current.cassettes.map((item) => item.id));
  const incomingIds = new Set(incoming.cassettes.map((item) => item.id));
  return {
    current,
    incoming,
    diff: {
      added: incoming.cassettes.filter((item) => !currentIds.has(item.id)).length,
      removed: current.cassettes.filter((item) => !incomingIds.has(item.id)).length,
      retained: incoming.cassettes.filter((item) => currentIds.has(item.id)).length,
      currentCassettes: current.cassettes.length,
      incomingCassettes: incoming.cassettes.length,
      incomingTracks: incoming.cassettes.reduce((sum, item) => sum + (item.tracks?.length ?? 0), 0)
    }
  };
}

export async function importLibrary(libraryData) {
  requireGM();
  const preview = previewLibraryImport(libraryData);
  const backup = foundry.utils.deepClone(preview.current);
  const library = await writeLibrary(preview.incoming, { expectedRevision: preview.current.revision });
  return { ok: true, library, backup, diff: preview.diff };
}

export async function rollbackLibrary(backup) {
  requireGM();
  const current = readLibrary();
  return writeLibrary(backup, { expectedRevision: current.revision });
}

export async function saveCassette(cassetteData, { expectedRevision = null } = {}) {
  requireGM();
  const cassette = normalizeCassette(cassetteData);
  assertSafeCassette(cassette);
  const library = readLibrary();
  const revision = expectedRevision ?? library.revision;
  const index = library.cassettes.findIndex((item) => item.id === cassette.id);
  if (index >= 0) library.cassettes[index] = cassette;
  else library.cassettes.push(cassette);
  await writeLibrary(library, { expectedRevision: revision });
  return cassette;
}

export async function deleteCassette(cassetteId, { expectedRevision = null } = {}) {
  requireGM();
  const library = readLibrary();
  const revision = expectedRevision ?? library.revision;
  const nextCassettes = library.cassettes.filter((cassette) => cassette.id !== cassetteId);
  if (nextCassettes.length === library.cassettes.length) return false;
  library.cassettes = nextCassettes;
  await writeLibrary(library, { expectedRevision: revision });
  return true;
}
