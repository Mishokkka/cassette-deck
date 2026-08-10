export function nextSequence(deckState) {
  const seq = Number(deckState?.seq ?? 0);
  return Number.isFinite(seq) ? seq + 1 : 1;
}

export function nextRevision(deckState) {
  const revision = Number(deckState?.revision ?? 0);
  return Number.isFinite(revision) && revision >= 0 ? revision + 1 : 1;
}

export function normalizePlaybackSequence(value) {
  const seq = Number(value ?? 0);
  return Number.isFinite(seq) && seq >= 0 ? seq : 0;
}

export function normalizePlaybackRate(value) {
  const rate = Number(value ?? 1);
  return Number.isFinite(rate) ? Math.min(4, Math.max(0.1, rate)) : 1;
}

export function estimateOffset(deckState, now = Date.now()) {
  const baseOffset = Math.max(0, Number(deckState?.offset ?? 0) || 0);
  if (deckState?.status !== "playing" || !deckState.startedAt) return baseOffset;

  const elapsed = Math.max(0, (Number(now) - Number(deckState.startedAt)) / 1000);
  return baseOffset + elapsed * normalizePlaybackRate(deckState.playbackRate);
}

export function snapshotPlayback(deckState = {}, now = Date.now()) {
  const offset = estimateOffset(deckState, now);
  return {
    ...deckState,
    offset,
    startedAt: deckState.status === "playing" ? Number(now) : null
  };
}

export function expectedEndAt(deckState = {}, duration = deckState.duration, now = Date.now()) {
  const mediaDuration = Number(duration);
  if (deckState.status !== "playing" || !Number.isFinite(mediaDuration) || mediaDuration <= 0) return null;
  const remaining = Math.max(0, mediaDuration - estimateOffset(deckState, now));
  return Number(now) + (remaining / normalizePlaybackRate(deckState.playbackRate)) * 1000;
}

export function shouldAcceptNaturalEnd(payload = {}, deckState = {}, now = Date.now(), toleranceMs = 1000) {
  if (deckState?.status !== "playing") return { ok: false, reason: "deck is not playing" };

  const currentPlaybackSeq = normalizePlaybackSequence(deckState.playbackSeq ?? deckState.seq);
  const eventPlaybackSeq = normalizePlaybackSequence(payload.playbackSeq ?? payload.seq);
  const hasPlaybackSequence = Object.hasOwn(payload, "playbackSeq") || Object.hasOwn(payload, "seq");
  if (hasPlaybackSequence && eventPlaybackSeq !== currentPlaybackSeq) {
    return { ok: false, reason: "playback sequence changed" };
  }

  if (Object.hasOwn(payload, "authorityEpoch") && Number(payload.authorityEpoch) !== Number(deckState.authorityEpoch ?? 0)) {
    return { ok: false, reason: "authority epoch changed" };
  }

  if (payload.cassetteId && payload.cassetteId !== deckState.cassetteId) return { ok: false, reason: "cassette changed" };
  if (payload.trackId && payload.trackId !== deckState.trackId) return { ok: false, reason: "track changed" };

  const eventPath = normalizeTrackPath(payload.path);
  const statePath = normalizeTrackPath(deckState.trackPath);
  if (eventPath && statePath && eventPath !== statePath) return { ok: false, reason: "track path changed" };

  const duration = Number(deckState.duration ?? payload.duration);
  if (!Number.isFinite(duration) || duration <= 0) return { ok: false, reason: "duration is unknown" };

  const estimated = estimateOffset(deckState, now);
  const remainingMs = Math.max(0, duration - estimated) / normalizePlaybackRate(deckState.playbackRate) * 1000;
  if (remainingMs > Math.max(250, Number(toleranceMs) || 1000)) return { ok: false, reason: "track has not reached its expected end" };

  const endedAt = Number(payload.endedAt ?? now);
  if (!Number.isFinite(endedAt) || Math.abs(Number(now) - endedAt) > 10_000) return { ok: false, reason: "ended event is stale" };

  return { ok: true };
}

export function clampOffset(value, duration = null) {
  const offset = Math.max(0, Number(value ?? 0) || 0);
  if (!Number.isFinite(Number(duration)) || Number(duration) <= 0) return offset;
  return Math.min(offset, Number(duration));
}

export function isActivePlaybackStatus(status) {
  return status === "playing" || status === "paused";
}

export function normalizeTrackPath(path) {
  const value = String(path ?? "").trim();
  return value || null;
}

export function withTrackSnapshot(deckState = {}, track = null) {
  return {
    ...deckState,
    trackPath: normalizeTrackPath(track?.path),
    duration: Number.isFinite(Number(track?.duration)) && Number(track.duration) > 0 ? Number(track.duration) : (Number.isFinite(Number(deckState.duration)) && Number(deckState.duration) > 0 ? Number(deckState.duration) : null)
  };
}

export function hasTrackPathChanged(deckState = {}, track = null) {
  const previous = normalizeTrackPath(deckState.trackPath);
  const next = normalizeTrackPath(track?.path);
  if (!previous && !next) return false;
  return previous !== next;
}

export function commandOrderTuple(command = {}) {
  return [
    Number(command.authorityEpoch ?? 0) || 0,
    normalizePlaybackSequence(command.playbackSeq),
    Number(command.seq ?? 0) || 0,
    Number(command.revision ?? 0) || 0
  ];
}

export function compareCommandOrder(a = {}, b = {}) {
  const left = commandOrderTuple(a);
  const right = commandOrderTuple(b);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

export function validateCommandAgainstState(command = {}, deckState = {}) {
  if (!command || typeof command !== "object") return { ok: false, reason: "missing command" };
  if (Number(command.authorityEpoch ?? 0) !== Number(deckState.authorityEpoch ?? 0)) return { ok: false, reason: "authority epoch mismatch" };
  if (Number(command.revision ?? 0) !== Number(deckState.revision ?? 0)) return { ok: false, reason: "state revision mismatch" };
  if (Number(command.seq ?? 0) !== Number(deckState.seq ?? 0)) return { ok: false, reason: "sequence mismatch" };
  if (normalizePlaybackSequence(command.playbackSeq) !== normalizePlaybackSequence(deckState.playbackSeq)) return { ok: false, reason: "playback sequence mismatch" };
  if ((command.cassetteId ?? null) !== (deckState.cassetteId ?? null)) return { ok: false, reason: "cassette mismatch" };
  if ((command.trackId ?? null) !== (deckState.trackId ?? null)) return { ok: false, reason: "track mismatch" };
  if (normalizeTrackPath(command.path) !== normalizeTrackPath(deckState.trackPath)) return { ok: false, reason: "track path mismatch" };
  return { ok: true };
}

export function validateDeckStateInvariants(deckState = {}, { cassette = null, track = null } = {}) {
  const status = String(deckState.status ?? "idle");
  const issues = [];

  if (isActivePlaybackStatus(status) && (!deckState.cassetteId || !deckState.trackId || !cassette || !track)) {
    issues.push(`${status} requires a selected cassette and track`);
  }
  if (status === "playing" && !Number.isFinite(Number(deckState.startedAt))) issues.push("playing requires startedAt");
  if (status === "playing" && deckState.lidOpen) issues.push("playing requires a closed lid");
  if (status === "paused" && !Number.isFinite(Number(deckState.offset))) issues.push("paused requires a numeric offset");
  if (!Number.isFinite(normalizePlaybackRate(deckState.playbackRate))) issues.push("playbackRate must be finite");

  return { ok: issues.length === 0, issues };
}
