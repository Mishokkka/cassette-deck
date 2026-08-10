import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

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

test("socket session issuance is bound to socketlib caller identity without secure-context crypto", async () => {
  globalThis.window = globalThis;
  globalThis.Hooks = { callAll: () => {} };
  globalThis.ui = { notifications: { warn: () => {}, error: () => {}, info: () => {} } };
  let randomCounter = 0;
  globalThis.foundry = {
    utils: {
      deepClone: structuredClone,
      mergeObject,
      randomID: () => `rid-${++randomCounter}`,
      getRoute: (value) => value
    }
  };

  const gm = { id: "gm", name: "GM", isGM: true, active: true, role: 4 };
  const player = { id: "player", name: "Player", isGM: false, active: true, role: 1 };
  const attacker = { id: "attacker", name: "Attacker", isGM: false, active: true, role: 1 };
  const users = [gm, player, attacker];
  const handlers = new Map();
  const deliveries = [];
  const channel = {
    register: (name, fn) => handlers.set(name, fn),
    executeAsUser: async (name, userId, payload) => {
      deliveries.push({ name, userId, payload });
      return { ok: true };
    },
    executeForOthers: async () => ({ ok: true })
  };

  globalThis.game = {
    user: gm,
    users: { contents: users, get: (id) => users.find((user) => user.id === id) ?? null },
    modules: { get: (id) => id === "socketlib" ? { active: true } : { active: false } },
    settings: { get: () => ({}) }
  };
  globalThis.socketlib = { registerModule: () => channel };

  const { CassetteSocket } = await import(`../scripts/core/socket.mjs?security=${Date.now()}`);
  assert.equal(CassetteSocket.init(), true);

  const issueSession = handlers.get("gmIssueSession");
  assert.equal(typeof issueSession, "function");
  await assert.rejects(
    issueSession.call({ socketdata: { userId: attacker.id } }, { requestedUserId: player.id, requestId: "req-1" }),
    (error) => error?.code === "SESSION_REQUESTER_MISMATCH"
  );
  assert.equal(deliveries.length, 0);

  await issueSession.call({ socketdata: { userId: player.id } }, { requestedUserId: player.id, requestId: "req-2" });
  const delivery = deliveries.find((entry) => entry.name === "clientReceiveSession" && entry.userId === player.id);
  assert.ok(delivery?.payload?.token);

  const ping = handlers.get("gmPing");
  assert.throws(
    () => ping.call({ socketdata: { userId: attacker.id } }, { sessionToken: delivery.payload.token }),
    (error) => error?.code === "SESSION_CALLER_MISMATCH"
  );

  const source = await fs.readFile(new URL("../scripts/core/socket.mjs", import.meta.url), "utf8");
  assert.match(source, /socketdata\?\.userId/);
  assert.doesNotMatch(source, /crypto\.subtle|crypto\.randomUUID|crypto\.getRandomValues|isSecureContext/);
});
