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

test("library snapshot cache preserves copy-on-read semantics and invalidates by revision", async () => {
  let mergeCalls = 0;
  globalThis.foundry = {
    utils: {
      deepClone: structuredClone,
      mergeObject: (...args) => {
        mergeCalls += 1;
        return mergeObject(...args);
      },
      randomID: () => "generated-id"
    }
  };

  let library = {
    schemaVersion: 4,
    revision: 1,
    updatedAt: 100,
    cassettes: [{
      id: "cassette-1",
      title: "Original",
      description: "",
      discovered: true,
      sort: 10,
      access: { mode: "unlocked", users: [], roles: [] },
      tracks: [{ id: "track-1", title: "Track", path: "audio/track.ogg", duration: 12, transcript: "", tags: [] }],
      effects: { preset: "clean", intensity: 1 },
      label: { font: "" }
    }]
  };

  globalThis.game = {
    user: { isGM: true },
    settings: {
      get: () => library,
      set: async (_moduleId, _key, value) => {
        library = value;
        return value;
      }
    }
  };

  const service = await import(`../scripts/services/library-service.mjs?cache=${Date.now()}`);
  const first = service.getCassetteById("cassette-1");
  const callsAfterFirstRead = mergeCalls;
  first.title = "Mutated copy";

  const second = service.getCassetteById("cassette-1");
  assert.equal(second.title, "Original");
  assert.equal(mergeCalls, callsAfterFirstRead);

  library = {
    ...library,
    revision: 2,
    updatedAt: 200,
    cassettes: [{ ...library.cassettes[0], title: "Updated" }]
  };

  const third = service.getCassetteById("cassette-1");
  assert.equal(third.title, "Updated");
  assert.ok(mergeCalls > callsAfterFirstRead);
});


test("library summary projections stay bounded and respect player visibility", async () => {
  globalThis.foundry = {
    utils: {
      deepClone: structuredClone,
      mergeObject,
      randomID: () => "generated-id"
    }
  };

  const library = {
    schemaVersion: 4,
    revision: 7,
    updatedAt: 700,
    cassettes: [
      {
        id: "visible-1", title: "Visible A", description: "large text omitted from summary", discovered: true, sort: 10,
        access: { mode: "unlocked", users: [], roles: [] },
        tracks: [
          { id: "track-a", title: "A", path: "audio/a.ogg", duration: 10, transcript: "", tags: [] },
          { id: "track-b", title: "B", path: "audio/b.ogg", duration: 20, transcript: "", tags: [] }
        ],
        effects: { preset: "clean", intensity: 1 }, label: { font: "" }
      },
      {
        id: "hidden", title: "Hidden", description: "", discovered: false, sort: 20,
        access: { mode: "unlocked", users: [], roles: [] },
        tracks: [{ id: "track-hidden", title: "Hidden", path: "audio/hidden.ogg", duration: 30, transcript: "", tags: [] }],
        effects: { preset: "clean", intensity: 1 }, label: { font: "" }
      },
      {
        id: "visible-2", title: "Visible B", description: "", discovered: true, sort: 30,
        access: { mode: "users", users: ["player-1"], roles: [] },
        tracks: [
          { id: "track-duplicate", title: "Duplicate", path: "audio/a.ogg", duration: 99, transcript: "", tags: [] },
          { id: "track-c", title: "C", path: "audio/c.ogg", duration: 40, transcript: "", tags: [] }
        ],
        effects: { preset: "clean", intensity: 1 }, label: { font: "" }
      }
    ]
  };

  globalThis.game = {
    user: { id: "player-1", role: 1, isGM: false },
    settings: { get: () => library }
  };

  const service = await import(`../scripts/services/library-service.mjs?summary=${Date.now()}`);
  const cassettes = service.getCassetteSummaries({ visibleTo: game.user });
  assert.deepEqual(cassettes, [
    { id: "visible-1", title: "Visible A", trackCount: 2 },
    { id: "visible-2", title: "Visible B", trackCount: 2 }
  ]);

  const tracks = service.getVisibleTrackSummaries({ visibleTo: game.user, limit: 2 });
  assert.deepEqual(tracks, [
    { id: "track-a", path: "audio/a.ogg", duration: 10 },
    { id: "track-b", path: "audio/b.ogg", duration: 20 }
  ]);
});
