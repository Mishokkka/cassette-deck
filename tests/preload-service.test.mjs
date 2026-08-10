import test from "node:test";
import assert from "node:assert/strict";

function mergeObject(base, source, { inplace = true } = {}) {
  const target = inplace ? base : structuredClone(base);
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] = mergeObject(target[key] && typeof target[key] === "object" ? target[key] : {}, value, { inplace: false });
    } else {
      target[key] = structuredClone(value);
    }
  }
  return target;
}

class CachedMetadataAudio {
  constructor() {
    this.duration = 12;
    this.readyState = 1;
    this.listeners = new Map();
    this.src = "";
  }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  removeEventListener(type, handler) { if (this.listeners.get(type) === handler) this.listeners.delete(type); }
  removeAttribute(name) { if (name === "src") this.src = ""; }
  load() {}
}

function installEnvironment({ library, deckState, settings = {} }) {
  globalThis.window = globalThis;
  globalThis.Audio = CachedMetadataAudio;
  globalThis.foundry = {
    utils: {
      deepClone: structuredClone,
      mergeObject,
      randomID: () => "generated-id",
      getRoute: (value) => value
    }
  };
  const values = {
    library,
    deckState,
    preloadStrategy: "cassette",
    preloadNextTrack: true,
    preloadMaxEntries: 2,
    preloadConcurrency: 1,
    ...settings
  };
  globalThis.game = {
    user: { id: "gm", isGM: true, role: 4 },
    settings: { get: (_module, key) => values[key] },
    users: { contents: [{ id: "gm", isGM: true, active: true }], get: (id) => id === "gm" ? { id: "gm", isGM: true, active: true } : null }
  };
}

const cassette = {
  id: "cassette-1",
  title: "Tape",
  description: "",
  discovered: true,
  sort: 10,
  access: { mode: "unlocked", users: [], roles: [] },
  tracks: [
    { id: "t1", title: "One", path: "audio/one.ogg", duration: null, transcript: "", tags: [] },
    { id: "t2", title: "Two", path: "audio/two.ogg", duration: null, transcript: "", tags: [] },
    { id: "t3", title: "Three", path: "audio/three.ogg", duration: null, transcript: "", tags: [] },
    { id: "t4", title: "Four", path: "audio/four.ogg", duration: null, transcript: "", tags: [] }
  ],
  effects: { preset: "clean", intensity: 1 },
  label: { font: "" }
};

const library = { schemaVersion: 4, revision: 1, updatedAt: 1, cassettes: [cassette] };
const deckState = { cassetteId: "cassette-1", trackId: "t3", status: "playing" };

test("metadata preload succeeds when duration is synchronously available from browser cache", async () => {
  installEnvironment({ library, deckState });
  const { PreloadService } = await import(`../scripts/services/preload-service.mjs?cached=${Date.now()}`);
  const result = await PreloadService.preloadTrack(cassette.tracks[0], { timeoutMs: 1000 });
  assert.equal(result.status, "ready");
  assert.equal(result.duration, 12);
  assert.equal(result.nativeAudio, null);
  assert.equal(result.cancel, null);
  PreloadService.clear();
});

test("cassette preload prioritizes current and next tracks before max-entry truncation", async () => {
  installEnvironment({ library, deckState });
  const { PreloadService } = await import(`../scripts/services/preload-service.mjs?priority=${Date.now()}`);
  await PreloadService.warmFromCurrentContext({ reason: "test", force: true });
  const paths = PreloadService.getState().map((entry) => entry.path);
  assert.deepEqual(paths, ["audio/three.ogg", "audio/four.ogg"]);
  const summary = PreloadService.getSummary().lastWarmSummary;
  assert.equal(typeof summary.obsolete, "number");
  assert.equal(typeof summary.superseded, "boolean");
  PreloadService.invalidateWarm("test-invalidate");
  const invalidated = PreloadService.getSummary().lastWarmSummary;
  assert.equal(typeof invalidated.obsolete, "number");
  assert.equal(typeof invalidated.superseded, "boolean");
  assert.equal(invalidated.invalidated, true);
  PreloadService.clear();
});
