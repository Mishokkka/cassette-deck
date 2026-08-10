import test from "node:test";
import assert from "node:assert/strict";
import { saveJsonFile } from "../scripts/core/file-utils.mjs";

test("saveJsonFile uses Foundry saveDataToFile when available", () => {
  const previousFoundry = globalThis.foundry;
  const previousSaveDataToFile = globalThis.saveDataToFile;
  let captured = null;
  globalThis.foundry = {
    utils: {
      saveDataToFile: (data, type, filename) => {
        captured = { data, type, filename };
      }
    }
  };
  delete globalThis.saveDataToFile;

  try {
    assert.equal(saveJsonFile({ ok: true }, "test.json"), true);
    assert.equal(captured.type, "application/json");
    assert.equal(captured.filename, "test.json");
    assert.deepEqual(JSON.parse(captured.data), { ok: true });
  } finally {
    globalThis.foundry = previousFoundry;
    if (previousSaveDataToFile === undefined) delete globalThis.saveDataToFile;
    else globalThis.saveDataToFile = previousSaveDataToFile;
  }
});
