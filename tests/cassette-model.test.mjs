import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCassette, normalizeCassetteLabel } from "../scripts/models/cassette.mjs";

function withFoundryStub(fn) {
  const previousFoundry = globalThis.foundry;
  globalThis.foundry = {
    utils: {
      deepClone: (value) => JSON.parse(JSON.stringify(value)),
      mergeObject: (target = {}, source = {}, { inplace = true } = {}) => {
        const output = inplace ? target : JSON.parse(JSON.stringify(target));
        for (const [key, value] of Object.entries(source ?? {})) {
          if (value && typeof value === "object" && !Array.isArray(value)) {
            output[key] = globalThis.foundry.utils.mergeObject(output[key] ?? {}, value, { inplace: false });
          } else {
            output[key] = value;
          }
        }
        return output;
      }
    }
  };

  try {
    return fn();
  } finally {
    globalThis.foundry = previousFoundry;
  }
}

test("cassette normalization removes unused cover and keeps only title font metadata", () => withFoundryStub(() => {
  const cassette = normalizeCassette({
    id: "c1",
    title: " Test ",
    cover: "icons/old-cover.webp",
    label: { font: "Bona Nova", text: "Old separate label text" },
    tracks: [{ id: "t1", title: " Track ", path: " worlds/foo.ogg ", tags: "a, b" }]
  });

  assert.equal(cassette.title, "Test");
  assert.equal(Object.hasOwn(cassette, "cover"), false);
  assert.deepEqual(cassette.label, { font: "Bona Nova" });
  assert.deepEqual(cassette.tracks[0].tags, ["a", "b"]);
  assert.equal(cassette.tracks[0].path, "worlds/foo.ogg");
}));

test("cassette label supports Foundry font names and normalizes legacy built-in ids", () => {
  assert.deepEqual(normalizeCassetteLabel({ font: "Alegreya Sans", text: "A\r\nB" }), { font: "Alegreya Sans" });
  assert.deepEqual(normalizeCassetteLabel({ font: "handwritten" }), { font: "" });
});
