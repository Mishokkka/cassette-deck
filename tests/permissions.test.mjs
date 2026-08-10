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

test("unconfigured users inherit later default permission changes", async () => {
  globalThis.foundry = { utils: { deepClone: structuredClone, mergeObject } };
  let stored = {
    schemaVersion: 3,
    defaultPlayer: { openWidget: true, browseUnlocked: true, selectCassette: true, play: false },
    users: { player1: { openWidget: true, browseUnlocked: true, selectCassette: true, play: false } }
  };
  globalThis.game = {
    user: { id: "gm", isGM: true },
    settings: {
      get: () => stored,
      set: async (_module, _key, value) => { stored = value; return value; }
    }
  };

  const permissions = await import(`../scripts/core/permissions.mjs?inherit=${Date.now()}`);
  const normalized = permissions.normalizePermissions(stored);
  assert.deepEqual(normalized.users, {});

  stored = normalized;
  stored.defaultPlayer.play = true;
  const effective = permissions.getEffectivePermissions({ id: "player1", isGM: false });
  assert.equal(effective.play, true);
});

test("user permission overrides remain sparse and override defaults", async () => {
  globalThis.foundry = { utils: { deepClone: structuredClone, mergeObject } };
  globalThis.game = { user: { id: "gm", isGM: true }, settings: { get: () => ({}) } };
  const permissions = await import(`../scripts/core/permissions.mjs?sparse=${Date.now()}`);
  const defaults = permissions.normalizePermissionSet({ openWidget: true, play: false });
  const overrides = permissions.normalizePermissionOverrides({ ...defaults, play: true }, defaults);
  assert.deepEqual(overrides, { play: true });
  assert.equal(permissions.normalizePermissionSet(overrides, defaults).play, true);
  assert.equal(permissions.normalizePermissionSet(overrides, defaults).openWidget, true);
});
