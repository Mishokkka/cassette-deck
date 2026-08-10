import test from "node:test";
import assert from "node:assert/strict";
import {
  clampOffset,
  compareCommandOrder,
  estimateOffset,
  expectedEndAt,
  hasTrackPathChanged,
  isActivePlaybackStatus,
  nextSequence,
  normalizePlaybackSequence,
  normalizeTrackPath,
  shouldAcceptNaturalEnd,
  validateDeckStateInvariants,
  withTrackSnapshot
} from "../scripts/models/deck-state.mjs";
import { DEFAULT_DECK_STATE, DEFAULT_LIBRARY, DEFAULT_PERMISSIONS, DEFAULT_WIDGET_STATE, SCHEMA_VERSIONS } from "../scripts/core/constants.mjs";

test("schema versions are centralized and match defaults", () => {
  assert.equal(DEFAULT_LIBRARY.schemaVersion, SCHEMA_VERSIONS.library);
  assert.equal(DEFAULT_DECK_STATE.schemaVersion, SCHEMA_VERSIONS.deckState);
  assert.equal(DEFAULT_PERMISSIONS.schemaVersion, SCHEMA_VERSIONS.permissions);
  assert.equal(Object.hasOwn(DEFAULT_WIDGET_STATE, "lidOpen"), false);
  assert.equal(Object.hasOwn(DEFAULT_WIDGET_STATE, "libraryOpen"), false);
  assert.equal(DEFAULT_WIDGET_STATE.browserOpen, false);
});

test("deck sequence increments from invalid or valid values", () => {
  assert.equal(nextSequence({ seq: 4 }), 5);
  assert.equal(nextSequence({ seq: "9" }), 10);
  assert.equal(nextSequence({ seq: "bad" }), 1);
});

test("estimateOffset only advances while playing and respects tape speed", () => {
  const now = 10_000;
  assert.equal(estimateOffset({ status: "paused", offset: 12, startedAt: 1_000, playbackRate: 2 }, now), 12);
  assert.equal(estimateOffset({ status: "playing", offset: 12, startedAt: 7_000, playbackRate: 1 }, now), 15);
  assert.equal(estimateOffset({ status: "playing", offset: 12, startedAt: 7_000, playbackRate: 0.5 }, now), 13.5);
  assert.equal(expectedEndAt({ status: "playing", offset: 0, startedAt: 8_000, playbackRate: 0.5 }, 10, now), 28_000);
});

test("clampOffset respects known duration", () => {
  assert.equal(clampOffset(-5, 20), 0);
  assert.equal(clampOffset(25, 20), 20);
  assert.equal(clampOffset(25, null), 25);
});

test("track snapshots normalize and detect active path changes", () => {
  const track = { id: "t1", path: " worlds/foo/music.ogg " };
  const state = withTrackSnapshot({ status: "playing", trackId: "t1" }, track);

  assert.equal(normalizeTrackPath(track.path), "worlds/foo/music.ogg");
  assert.equal(state.trackPath, "worlds/foo/music.ogg");
  assert.equal(hasTrackPathChanged(state, { id: "t1", path: "worlds/foo/music.ogg" }), false);
  assert.equal(hasTrackPathChanged(state, { id: "t1", path: "worlds/foo/other.ogg" }), true);
});

test("deck invariant validation rejects playback without a selected track", () => {
  const invalid = validateDeckStateInvariants({ status: "paused", cassetteId: null, trackId: null, offset: 4 });
  assert.equal(invalid.ok, false);
  assert.match(invalid.issues.join(";"), /requires a selected cassette and track/);

  const valid = validateDeckStateInvariants(
    { status: "paused", cassetteId: "c1", trackId: "t1", offset: 4 },
    { cassette: { id: "c1" }, track: { id: "t1", path: "worlds/foo/music.ogg" } }
  );
  assert.equal(valid.ok, true);
});

test("active playback status helper is narrow", () => {
  assert.equal(isActivePlaybackStatus("playing"), true);
  assert.equal(isActivePlaybackStatus("paused"), true);
  assert.equal(isActivePlaybackStatus("stopped"), false);
  assert.equal(isActivePlaybackStatus("idle"), false);
});


test("playback sequence validates natural end only near the authoritative end", () => {
  const now = 100_000;
  const state = {
    status: "playing",
    seq: 12,
    playbackSeq: 7,
    authorityEpoch: 3,
    cassetteId: "c1",
    trackId: "t1",
    trackPath: "worlds/foo/music.ogg",
    duration: 20,
    offset: 0,
    startedAt: 81_000,
    playbackRate: 1
  };

  assert.equal(normalizePlaybackSequence("7"), 7);
  assert.equal(shouldAcceptNaturalEnd({ playbackSeq: 7, authorityEpoch: 3, cassetteId: "c1", trackId: "t1", path: "worlds/foo/music.ogg", endedAt: now }, state, now).ok, true);
  assert.equal(shouldAcceptNaturalEnd({ playbackSeq: 6, cassetteId: "c1", trackId: "t1", endedAt: now }, state, now).ok, false);
  assert.equal(shouldAcceptNaturalEnd({ playbackSeq: 7, cassetteId: "c1", trackId: "t1", path: "worlds/foo/other.ogg", endedAt: now }, state, now).ok, false);

  const premature = { ...state, startedAt: 95_000 };
  assert.equal(shouldAcceptNaturalEnd({ playbackSeq: 7, cassetteId: "c1", trackId: "t1", endedAt: now }, premature, now).ok, false);
});

test("command ordering ignores wall-clock timestamps and prioritizes authority epochs", () => {
  const base = { authorityEpoch: 2, playbackSeq: 7, seq: 12, revision: 9, issuedAt: 5000 };
  assert.equal(compareCommandOrder({ ...base, issuedAt: 9000 }, base), 0);
  assert.equal(compareCommandOrder({ ...base, revision: 10 }, base), 1);
  assert.equal(compareCommandOrder({ ...base, authorityEpoch: 1, seq: 999 }, base), -1);
});

test("natural end is ignored when deck is no longer playing", () => {
  const state = { status: "paused", seq: 8, playbackSeq: 8, cassetteId: "c1", trackId: "t1" };
  const result = shouldAcceptNaturalEnd({ playbackSeq: 8, cassetteId: "c1", trackId: "t1" }, state);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "deck is not playing");
});

import { commandMayMutatePlayback, normalizeVolume } from "../scripts/services/audio/command-generation.mjs";

test("audio command generation keeps volume and same-track sync non-mutating", () => {
  assert.equal(normalizeVolume(2, 1), 1);
  assert.equal(normalizeVolume(-1, 1), 0);
  assert.equal(normalizeVolume("bad", 1), 0.8);
  assert.equal(commandMayMutatePlayback({ action: "volume" }), false);
  assert.equal(commandMayMutatePlayback({ action: "sync", status: "playing", path: "a.ogg" }, { activePath: "a.ogg", hasActiveHandle: true }), false);
  assert.equal(commandMayMutatePlayback({ action: "sync", status: "playing", path: "b.ogg" }, { activePath: "a.ogg", hasActiveHandle: true }), true);
});


test("deck invariant validation rejects playing with an open lid", () => {
  const result = validateDeckStateInvariants(
    { status: "playing", cassetteId: "c1", trackId: "t1", offset: 0, startedAt: 100, lidOpen: true },
    { cassette: { id: "c1" }, track: { id: "t1", path: "worlds/foo/music.ogg" } }
  );

  assert.equal(result.ok, false);
  assert.match(result.issues.join(";"), /closed lid/);
});

test("close lid command is non-mutating for active playback epoch", () => {
  assert.equal(commandMayMutatePlayback({ action: "closeLid" }), false);
});
