import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeLocalPath, isSafeAudioPath, normalizeAudioPath } from "../scripts/models/validators.mjs";

test("audio path validation accepts safe Foundry-relative paths", () => {
  assert.equal(canonicalizeLocalPath(" My Audio\\music.OGG?cache=1 "), "My Audio/music.OGG");
  assert.equal(isSafeAudioPath("My Audio/music.OGG?cache=1"), true);
  assert.equal(isSafeAudioPath("worlds/test/audio/tape.flac"), true);
  assert.equal(normalizeAudioPath("/uploads/tape.mp3"), "uploads/tape.mp3");
});

test("audio path validation rejects traversal, protocols and unsupported formats", () => {
  assert.equal(isSafeAudioPath("../secrets.ogg"), false);
  assert.equal(isSafeAudioPath("uploads/%2e%2e/secrets.ogg"), false);
  assert.equal(isSafeAudioPath("C:/music/tape.ogg"), false);
  assert.equal(isSafeAudioPath("javascript:alert.ogg"), false);
  assert.equal(isSafeAudioPath("//host.example/audio.mp3"), false);
  assert.equal(isSafeAudioPath("\\\\host.example\\audio.mp3"), false);
  assert.equal(isSafeAudioPath("%2F%2Fhost.example/audio.mp3"), false);
  assert.equal(isSafeAudioPath("https://example.com/tape.ogg"), false);
  assert.equal(isSafeAudioPath("https://example.com/tape.ogg", { allowRemote: true }), true);
  assert.equal(isSafeAudioPath("uploads/tape.exe"), false);
});
