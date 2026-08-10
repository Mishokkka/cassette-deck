import test from "node:test";
import assert from "node:assert/strict";
import { normalizeShuttleSourceVolume, resolveShuttlePreviewVolume, SHUTTLE_PREVIEW_GAIN } from "../scripts/services/audio/shuttle-preview.mjs";

test("audible shuttle preview is boosted without breaking mute or clipping", () => {
  assert.equal(SHUTTLE_PREVIEW_GAIN, 1.65);
  assert.equal(normalizeShuttleSourceVolume(0, 0.8), 0);
  assert.equal(resolveShuttlePreviewVolume(0), 0);
  assert.equal(resolveShuttlePreviewVolume(0.4), 0.66);
  assert.equal(resolveShuttlePreviewVolume(0.8), 1);
  assert.equal(resolveShuttlePreviewVolume(5), 1);
});
