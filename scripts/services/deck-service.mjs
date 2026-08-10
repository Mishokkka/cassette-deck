import { SETTINGS } from "../core/constants.mjs";
import { logger } from "../core/logger.mjs";
import { getDeckState, setSetting } from "../core/settings.mjs";
import { canOpenWidget, canUseControl } from "../core/permissions.mjs";
import { AuthorityService } from "../core/authority.mjs";
import { getCassetteById, getVisibleCassetteById, readLibrary } from "./library-service.mjs";
import { EffectsService } from "./effects-service.mjs";
import { PreloadService } from "./preload-service.mjs";
import {
  clampOffset,
  estimateOffset,
  expectedEndAt,
  hasTrackPathChanged,
  isActivePlaybackStatus,
  nextRevision,
  nextSequence,
  normalizePlaybackRate,
  shouldAcceptNaturalEnd,
  validateDeckStateInvariants,
  withTrackSnapshot
} from "../models/deck-state.mjs";
import { isSafeAudioPath } from "../models/validators.mjs";
import { codedError } from "../core/utils.mjs";

const SEEK_STEP_SECONDS = 10;
const SHUTTLE_DELAY_MS = 500;
const COMMAND_THROTTLE_MS = 300;
const SEEK_THROTTLE_MS = 500;
const SELECT_THROTTLE_MS = 500;
const USER_THROTTLES = new Map();

export function readDeckState() {
  return getDeckState();
}

function requireAuthority() {
  AuthorityService.assertLocalAuthority();
}

function requireRequester(requesterId) {
  const requester = game.users.get(String(requesterId || ""));
  if (!requester) throw codedError("Unknown requesting user.", "UNKNOWN_USER");
  return requester;
}

function assertNotThrottled(action, requester) {
  if (!requester || requester.isGM) return;
  const interval = action === "selectCassette"
    ? SELECT_THROTTLE_MS
    : (["seekBackward", "seekForward", "seek"].includes(action) ? SEEK_THROTTLE_MS : COMMAND_THROTTLE_MS);
  const key = `${requester.id}:${action}`;
  const now = Date.now();
  const last = Number(USER_THROTTLES.get(key) ?? 0);
  if (now - last < interval) throw codedError("Transport command throttled. Try again in a moment.", "THROTTLED");
  USER_THROTTLES.set(key, now);
}

function assertUserCan(action, requester) {
  if (requester?.isGM) return;
  if (!canUseControl(action, requester)) throw codedError(`This user cannot use '${action}'.`, "PERMISSION_DENIED");
}

function getVisibleCassetteForRequester(cassetteId, requester) {
  return requester?.isGM ? getCassetteById(cassetteId) : getVisibleCassetteById(cassetteId, requester);
}

function resolveTrack(cassette, trackId = null, { fallback = true } = {}) {
  if (!cassette) return null;
  if (trackId) return cassette.tracks?.find((track) => track.id === trackId) ?? null;
  return fallback ? (cassette.tracks?.[0] ?? null) : null;
}

function getTrackIndex(cassette, trackId) {
  return (cassette?.tracks ?? []).findIndex((track) => track.id === trackId);
}

function getNextTrack(cassette, trackId) {
  const tracks = cassette?.tracks ?? [];
  const currentIndex = getTrackIndex(cassette, trackId);
  if (currentIndex < 0) return tracks[0] ?? null;
  return tracks[currentIndex + 1] ?? null;
}

function getKnownDuration(track) {
  const own = Number(track?.duration);
  if (Number.isFinite(own) && own > 0) return own;
  const cached = PreloadService.getCachedDuration?.(track?.path);
  return Number.isFinite(Number(cached)) && Number(cached) > 0 ? Number(cached) : null;
}

function isPlayableTrack(track) {
  return Boolean(track?.path && isSafeAudioPath(track.path, { allowRemote: false }));
}

function assertPlayableTrack(track) {
  if (!track) throw codedError("Cassette has no selected track.", "NOT_AVAILABLE");
  if (!track.path) throw codedError("Selected track has no audio file.", "NOT_AVAILABLE");
  if (!isSafeAudioPath(track.path, { allowRemote: false })) throw codedError("Selected track path is unsafe or unsupported.", "UNSAFE_AUDIO_PATH");
}

function nextCommandSequence(current = {}, { playback = false } = {}) {
  const seq = nextSequence(current);
  const previousPlaybackSeq = Number(current.playbackSeq ?? 0);
  return {
    seq,
    playbackSeq: playback ? seq : (Number.isFinite(previousPlaybackSeq) && previousPlaybackSeq >= 0 ? previousPlaybackSeq : 0)
  };
}

function claimAuthority(current = {}) {
  const authorityUserId = AuthorityService.authorityUserId;
  const changed = current.authorityUserId !== authorityUserId;
  return {
    authorityUserId,
    authorityEpoch: changed ? Math.max(0, Number(current.authorityEpoch ?? 0)) + 1 : Math.max(1, Number(current.authorityEpoch ?? 1)),
    authorityHeartbeatAt: Date.now()
  };
}

function makeCommandId() {
  return foundry.utils.randomID(24);
}

function effectSeed(deckState, cassette, track) {
  return `${deckState.authorityEpoch}:${deckState.playbackSeq}:${cassette?.id ?? "none"}:${track?.id ?? "none"}`;
}

function buildClientCommand({
  deckState,
  action,
  cassette = null,
  track = null,
  offset = 0,
  suppressClick = false,
  clickAction = null,
  transportDelayMs = 0,
  shuttleFromOffset = null,
  shuttleToOffset = null,
  shuttleSourceTrackId = null,
  syncReason = null
}) {
  const effects = EffectsService.getPlaybackOptions(cassette?.effects ?? {});
  const playbackRate = normalizePlaybackRate(deckState.playbackRate ?? effects.playbackRate);
  const seed = effectSeed(deckState, cassette, track);
  return {
    commandId: makeCommandId(),
    revision: deckState.revision,
    seq: deckState.seq,
    playbackSeq: deckState.playbackSeq ?? deckState.seq ?? 0,
    authorityEpoch: deckState.authorityEpoch,
    authorityUserId: deckState.authorityUserId,
    action,
    status: deckState.status,
    cassetteId: deckState.cassetteId,
    trackId: deckState.trackId,
    path: track?.path ?? deckState.trackPath ?? null,
    duration: getKnownDuration(track) ?? deckState.duration ?? null,
    offset: clampOffset(offset, getKnownDuration(track) ?? deckState.duration ?? null),
    volume: deckState.volume ?? 0.8,
    lidOpen: Boolean(deckState.lidOpen),
    issuedAt: Date.now(),
    controllerUserId: game.user.id,
    effectPreset: effects.preset,
    playbackRate,
    volumeMultiplier: effects.volumeMultiplier,
    fadeInMs: effects.fadeInMs,
    fadeOutMs: ["pause", "stop", "eject", "select", "open"].includes(action) ? effects.fadeOutMs : 0,
    clickSfx: !suppressClick && effects.clickSfx,
    clickAction: clickAction || action,
    nativeEffects: { ...(effects.nativeEffects ?? {}), seed },
    transportDelayMs: Math.max(0, Number(transportDelayMs ?? 0) || 0),
    shuttleFromOffset: Number.isFinite(Number(shuttleFromOffset)) ? Number(shuttleFromOffset) : null,
    shuttleToOffset: Number.isFinite(Number(shuttleToOffset)) ? Number(shuttleToOffset) : null,
    shuttleSourceTrackId: shuttleSourceTrackId ? String(shuttleSourceTrackId) : null,
    syncReason
  };
}

function assertValidState(next, { cassette = null, track = null } = {}) {
  const withSnapshot = withTrackSnapshot(next, track);
  const result = validateDeckStateInvariants(withSnapshot, { cassette, track });
  if (!result.ok) throw codedError(`Invalid deck state: ${result.issues.join("; ")}.`, "BAD_STATE");
  return withSnapshot;
}

async function commitTransport({ current, statePatch = {}, action, cassette = null, track = null, playback = false, commandOptions = {} }) {
  requireAuthority();
  const now = Date.now();
  const effects = EffectsService.getPlaybackOptions(cassette?.effects ?? {});
  let next = assertValidState({
    ...current,
    ...statePatch,
    ...nextCommandSequence(current, { playback }),
    ...claimAuthority(current),
    revision: nextRevision(current),
    schemaVersion: current.schemaVersion,
    playbackRate: normalizePlaybackRate(statePatch.playbackRate ?? current.playbackRate ?? effects.playbackRate),
    command: null
  }, { cassette, track });

  next.duration = getKnownDuration(track) ?? next.duration ?? null;
  next.expectedEndAt = expectedEndAt(next, next.duration, now);
  const command = buildClientCommand({
    deckState: next,
    action,
    cassette,
    track,
    offset: commandOptions.offset ?? next.offset ?? 0,
    ...commandOptions
  });
  next = { ...next, command };
  await setSetting(SETTINGS.deckState, next);
  warmTrack(track, action);
  return { ok: true, deckState: next, command };
}

function warmTrack(track, reason = "transport") {
  if (!track?.path) return;
  void PreloadService.preloadTrack(track, { reason, kind: "metadata", retryFailed: true }).catch((error) => {
    logger.warn("Audio metadata preload failed after transport command.", error);
  });
}

export async function ensureAuthorityState({ reason = "authority-heartbeat", force = false } = {}) {
  requireAuthority();
  const current = readDeckState();
  const authorityChanged = current.authorityUserId !== AuthorityService.authorityUserId;
  const heartbeatOld = Date.now() - Number(current.authorityHeartbeatAt ?? 0) > 5_000;
  if (!force && !authorityChanged && !heartbeatOld) return { ok: true, ignored: true, reason: "authority lease current", deckState: current };

  const cassette = current.cassetteId ? getCassetteById(current.cassetteId) : null;
  const track = resolveTrack(cassette, current.trackId, { fallback: false });
  return commitTransport({
    current,
    statePatch: {},
    action: "sync",
    cassette,
    track,
    playback: false,
    commandOptions: { offset: estimateOffset(current), suppressClick: true, syncReason: reason }
  });
}

export async function gmSelectCassette({ requesterId, cassetteId, trackId = null } = {}) {
  requireAuthority();
  const requester = requireRequester(requesterId);
  if (!requester.isGM && !canUseControl("browseUnlocked", requester)) throw codedError("This user cannot browse unlocked cassettes.", "PERMISSION_DENIED");
  if (!requester.isGM && !canUseControl("selectCassette", requester)) throw codedError("This user cannot select cassettes.", "PERMISSION_DENIED");
  assertNotThrottled("selectCassette", requester);

  const cassette = getVisibleCassetteForRequester(cassetteId, requester);
  if (!cassette) throw codedError("Cassette is not available to this user.", "NOT_VISIBLE");
  const track = resolveTrack(cassette, trackId, { fallback: !trackId });
  if (trackId && !track) throw codedError("Requested track does not exist on this cassette.", "TRACK_NOT_FOUND");
  const effects = EffectsService.getPlaybackOptions(cassette.effects ?? {});

  return commitTransport({
    current: readDeckState(),
    statePatch: {
      status: "idle",
      cassetteId: cassette.id,
      trackId: track?.id ?? null,
      offset: 0,
      startedAt: null,
      pausedAt: null,
      lidOpen: true,
      playbackRate: effects.playbackRate
    },
    action: "select",
    cassette,
    track,
    playback: true,
    commandOptions: { offset: 0, clickAction: "select" }
  });
}

export async function gmHandleTransportRequest(payload = {}) {
  requireAuthority();
  const requester = requireRequester(payload.requesterId);
  const action = String(payload.action || "");
  if (!action) throw codedError("Missing transport action.", "BAD_REQUEST");
  const current = readDeckState();

  if (action === "open") {
    if (!requester.isGM && !canUseControl("browseUnlocked", requester)) throw codedError("This user cannot open the cassette lid.", "PERMISSION_DENIED");
    assertNotThrottled(action, requester);
    return gmOpenTransport(current);
  }
  if (action === "closeLid") {
    if (!requester.isGM && !canOpenWidget(requester)) throw codedError("This user cannot close the cassette lid.", "PERMISSION_DENIED");
    assertNotThrottled(action, requester);
    return gmCloseLidTransport(current);
  }

  const permissionAction = ["seekBackward", "seekForward"].includes(action) ? "seek" : action;
  assertUserCan(permissionAction, requester);
  assertNotThrottled(action, requester);

  if (current.lidOpen && ["play", "pause", "stop", "seekBackward", "seekForward", "next", "previous"].includes(action)) {
    return gmNoopTransport(current, action, "lid is open");
  }
  if (action === "stop") return isActivePlaybackStatus(current.status) ? gmStopTransport(current) : gmNoopTransport(current, action, "nothing to stop");
  if (action === "pause") return current.status === "playing" ? gmPauseTransport(current) : gmNoopTransport(current, action, "nothing to pause");
  if (action === "eject") return gmEjectTransport(current);
  if (action === "volume") return gmSetVolumeTransport(current, payload.volume);

  const cassetteId = payload.cassetteId ?? current.cassetteId;
  const cassette = getVisibleCassetteForRequester(cassetteId, requester);
  if (!cassette) return gmNoopTransport(current, action, "no cassette selected");

  const currentTrack = resolveTrack(cassette, current.trackId, { fallback: false });
  let track = resolveTrack(cassette, payload.trackId ?? current.trackId, { fallback: !(payload.trackId ?? current.trackId) });
  if (payload.trackId && !track) throw codedError("Requested track does not exist on this cassette.", "TRACK_NOT_FOUND");

  if (["next", "previous"].includes(action) && cassette.tracks?.length) {
    let currentIndex = getTrackIndex(cassette, track?.id ?? current.trackId);
    if (currentIndex < 0) currentIndex = 0;
    const delta = action === "next" ? 1 : -1;
    const nextIndex = (currentIndex + delta + cassette.tracks.length) % cassette.tracks.length;
    track = cassette.tracks[nextIndex];
  }

  if (["seekBackward", "seekForward"].includes(action)) {
    if (!isPlayableTrack(track)) return gmNoopTransport(current, action, "selected track is not playable");
    if (!isActivePlaybackStatus(current.status)) return gmNoopTransport(current, action, "seek requires active playback");
    const baseOffset = estimateOffset(current);
    const step = Number(payload.seconds ?? SEEK_STEP_SECONDS) || SEEK_STEP_SECONDS;
    const offset = clampOffset(baseOffset + (action === "seekForward" ? 1 : -1) * step, getKnownDuration(track));
    return gmSeekTransport({ current, cassette, track, offset, clickAction: action, transportDelayMs: SHUTTLE_DELAY_MS, shuttleFromOffset: baseOffset });
  }

  if (action === "play") {
    if (!isPlayableTrack(track)) return gmNoopTransport(current, action, "selected track is not playable");
    const sameTrack = current.cassetteId === cassette.id && current.trackId === track.id;
    const offset = current.status === "paused" && sameTrack
      ? clampOffset(current.offset, getKnownDuration(track))
      : clampOffset(payload.offset ?? (sameTrack ? current.offset : 0) ?? 0, getKnownDuration(track));
    return gmPlayTransport({ current, cassette, track, offset, action: "play" });
  }

  if (["next", "previous"].includes(action)) {
    if (!isPlayableTrack(track)) return gmNoopTransport(current, action, "selected track is not playable");
    if (isActivePlaybackStatus(current.status) && currentTrack && currentTrack.id !== track.id) {
      const knownDuration = getKnownDuration(currentTrack);
      const baseOffset = clampOffset(estimateOffset(current), knownDuration);
      const shuttleToOffset = action === "next"
        ? (Number.isFinite(knownDuration) && knownDuration > baseOffset ? knownDuration : baseOffset + SEEK_STEP_SECONDS)
        : 0;
      const shuttlePayload = { current, cassette, track, offset: 0, clickAction: action, transportDelayMs: SHUTTLE_DELAY_MS, shuttleFromOffset: baseOffset, shuttleToOffset, shuttleSourceTrackId: currentTrack.id };
      return current.status === "playing" ? gmPlayTransport({ ...shuttlePayload, action: "seek" }) : gmCueTransport(shuttlePayload);
    }
    if (current.status === "playing") return gmPlayTransport({ current, cassette, track, offset: 0, action: "play", clickAction: action });
    if (current.status === "paused") return gmCueTransport({ current, cassette, track, offset: 0, clickAction: action });
    return gmSelectTrackTransport({ current, cassette, track, clickAction: action });
  }

  throw codedError(`Unsupported transport action: ${action}`, "BAD_REQUEST");
}

async function gmNoopTransport(current, clickAction = "click", reason = "no-op") {
  const cassette = current.cassetteId ? getCassetteById(current.cassetteId) : null;
  const track = resolveTrack(cassette, current.trackId, { fallback: false });
  const result = await commitTransport({
    current,
    statePatch: {},
    action: "noop",
    cassette,
    track,
    playback: false,
    commandOptions: { offset: estimateOffset(current), clickAction }
  });
  return { ...result, ignored: true, reason };
}

async function gmOpenTransport(current) {
  const cassette = current.cassetteId ? getCassetteById(current.cassetteId) : null;
  const track = resolveTrack(cassette, current.trackId, { fallback: false });
  return commitTransport({ current, statePatch: { status: "stopped", offset: 0, startedAt: null, pausedAt: null, lidOpen: true }, action: "open", cassette, track, playback: true, commandOptions: { offset: 0 } });
}

async function gmCloseLidTransport(current) {
  const cassette = current.cassetteId ? getCassetteById(current.cassetteId) : null;
  const track = resolveTrack(cassette, current.trackId, { fallback: false });
  return commitTransport({ current, statePatch: { lidOpen: false }, action: "closeLid", cassette, track, playback: false, commandOptions: { offset: estimateOffset(current) } });
}

async function gmSetVolumeTransport(current, requestedVolume) {
  const volume = Math.min(1, Math.max(0, Number(requestedVolume) || 0));
  const cassette = current.cassetteId ? getCassetteById(current.cassetteId) : null;
  const track = resolveTrack(cassette, current.trackId, { fallback: false });
  return commitTransport({ current, statePatch: { volume }, action: "volume", cassette, track, playback: false, commandOptions: { offset: estimateOffset(current), suppressClick: true } });
}

async function gmPlayTransport({ current, cassette, track, offset = 0, action = "play", clickAction = null, transportDelayMs = 0, shuttleFromOffset = null, shuttleToOffset = null, shuttleSourceTrackId = null, suppressClick = false }) {
  assertPlayableTrack(track);
  const now = Date.now();
  const effects = EffectsService.getPlaybackOptions(cassette.effects ?? {});
  return commitTransport({
    current,
    statePatch: { status: "playing", cassetteId: cassette.id, trackId: track.id, offset: clampOffset(offset, getKnownDuration(track)), startedAt: now, pausedAt: null, lidOpen: false, playbackRate: effects.playbackRate },
    action,
    cassette,
    track,
    playback: true,
    commandOptions: { offset, clickAction, transportDelayMs, shuttleFromOffset, shuttleToOffset, shuttleSourceTrackId, suppressClick }
  });
}

async function gmSeekTransport(payload) {
  return payload.current.status === "playing" ? gmPlayTransport({ ...payload, action: "seek" }) : gmCueTransport(payload);
}

async function gmCueTransport({ current, cassette, track, offset = 0, clickAction = null, transportDelayMs = 0, shuttleFromOffset = null, shuttleToOffset = null, shuttleSourceTrackId = null }) {
  assertPlayableTrack(track);
  const effects = EffectsService.getPlaybackOptions(cassette.effects ?? {});
  return commitTransport({
    current,
    statePatch: { status: "paused", cassetteId: cassette.id, trackId: track.id, offset: clampOffset(offset, getKnownDuration(track)), startedAt: null, pausedAt: Date.now(), lidOpen: false, playbackRate: effects.playbackRate },
    action: "cue",
    cassette,
    track,
    playback: true,
    commandOptions: { offset, clickAction, transportDelayMs, shuttleFromOffset, shuttleToOffset, shuttleSourceTrackId }
  });
}

async function gmSelectTrackTransport({ current, cassette, track, clickAction = null }) {
  if (!cassette || !track) throw codedError("No track is selected.", "NOT_AVAILABLE");
  const effects = EffectsService.getPlaybackOptions(cassette.effects ?? {});
  return commitTransport({
    current,
    statePatch: { status: "idle", cassetteId: cassette.id, trackId: track.id, offset: 0, startedAt: null, pausedAt: null, playbackRate: effects.playbackRate },
    action: "select",
    cassette,
    track,
    playback: true,
    commandOptions: { offset: 0, clickAction }
  });
}

async function gmPauseTransport(current) {
  const cassette = current.cassetteId ? getCassetteById(current.cassetteId) : null;
  const track = resolveTrack(cassette, current.trackId, { fallback: false });
  assertPlayableTrack(track);
  const offset = clampOffset(estimateOffset(current), getKnownDuration(track));
  return commitTransport({ current, statePatch: { status: "paused", offset, startedAt: null, pausedAt: Date.now() }, action: "pause", cassette, track, playback: true, commandOptions: { offset } });
}

async function gmStopTransport(current) {
  const cassette = current.cassetteId ? getCassetteById(current.cassetteId) : null;
  const track = resolveTrack(cassette, current.trackId, { fallback: false });
  return commitTransport({ current, statePatch: { status: "stopped", offset: 0, startedAt: null, pausedAt: null }, action: "stop", cassette, track, playback: true, commandOptions: { offset: 0 } });
}

async function gmEjectTransport(current) {
  return commitTransport({ current, statePatch: { status: "idle", cassetteId: null, trackId: null, trackPath: null, duration: null, offset: 0, startedAt: null, pausedAt: null, lidOpen: true, expectedEndAt: null }, action: "eject", cassette: null, track: null, playback: true, commandOptions: { offset: 0 } });
}

export async function gmHandleNaturalEnd(payload = {}) {
  requireAuthority();
  const current = readDeckState();
  const acceptance = shouldAcceptNaturalEnd(payload, current, Date.now(), payload.authoritativeTimer ? 1750 : 1000);
  if (!acceptance.ok) return { ok: true, ignored: true, reason: acceptance.reason };
  const cassette = current.cassetteId ? getCassetteById(current.cassetteId) : null;
  const nextTrack = getNextTrack(cassette, current.trackId);
  if (isPlayableTrack(nextTrack)) return gmPlayTransport({ current, cassette, track: nextTrack, offset: 0, action: "play", suppressClick: true });
  return gmStopTransport(current);
}

export async function gmReconcileDeckStateWithLibrary({ reason = "library-changed" } = {}) {
  requireAuthority();
  const current = readDeckState();
  if (!current.cassetteId) return { ok: true, ignored: true, reason: "no selected cassette" };
  const library = readLibrary();
  const cassette = library.cassettes.find((item) => item.id === current.cassetteId) ?? null;
  if (!cassette) return { ...(await gmEjectTransport(current)), reason };

  const track = resolveTrack(cassette, current.trackId, { fallback: false });
  const activePlayback = isActivePlaybackStatus(current.status);
  const invalidTrack = !track || (activePlayback && !isPlayableTrack(track));
  const pathChanged = Boolean(track) && hasTrackPathChanged(current, track);
  if (!invalidTrack && activePlayback && pathChanged) return { ...(await gmStopTransport(current)), reason: `${reason}: active track path changed` };
  if (!invalidTrack && pathChanged) {
    return commitTransport({ current, statePatch: {}, action: current.status === "stopped" ? "stop" : "select", cassette, track, playback: false, commandOptions: { offset: estimateOffset(current), suppressClick: true } });
  }
  if (!invalidTrack) return { ok: true, ignored: true, reason: "selection is still valid" };
  if (activePlayback) return { ...(await gmStopTransport(current)), reason };
  const fallbackTrack = cassette.tracks?.[0] ?? null;
  return commitTransport({ current, statePatch: { status: "idle", cassetteId: cassette.id, trackId: fallbackTrack?.id ?? null, offset: 0, startedAt: null, pausedAt: null }, action: "select", cassette, track: fallbackTrack, playback: true, commandOptions: { offset: 0, suppressClick: true } });
}

export async function gmCommitSync({ requesterId = null, reason = "manual" } = {}) {
  requireAuthority();
  const requester = requesterId ? requireRequester(requesterId) : game.user;
  if (!requester.isGM && !canOpenWidget(requester)) throw codedError("This user cannot open the cassette deck widget.", "PERMISSION_DENIED");
  return ensureAuthorityState({ reason, force: true });
}

export async function selectCassetteLocal(cassetteId, trackId = null) {
  requireAuthority();
  return gmSelectCassette({ requesterId: game.user.id, cassetteId, trackId });
}
