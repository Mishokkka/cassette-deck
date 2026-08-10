import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TRANSPORT_SFX } from "../scripts/core/constants.mjs";
import { EFFECT_PRESETS, getEffectPreset } from "../scripts/models/effect-preset.mjs";
import { normalizeTransportSfxAction, normalizeTransportSfxSettings, resolveTransportSfxVolume, TRANSPORT_SFX_ACTIONS } from "../scripts/services/effects-service.mjs";

test("transport SFX settings normalize all final button actions", () => {
  const settings = normalizeTransportSfxSettings({
    volume: 3,
    fallbackSynth: false,
    actions: {
      play: " sounds/play.ogg ",
      closeLid: "sounds/close.ogg"
    }
  });

  assert.equal(settings.volume, 1);
  assert.equal(settings.fallbackSynth, false);
  assert.equal(settings.actions.play, "sounds/play.ogg");
  assert.equal(settings.actions.closeLid, "sounds/close.ogg");
  for (const id of Object.keys(DEFAULT_TRANSPORT_SFX.actions)) {
    assert.equal(typeof settings.actions[id], "string");
  }
});

test("transport SFX actions include lid, cassette and shuttle controls", () => {
  const ids = TRANSPORT_SFX_ACTIONS.map((entry) => entry.id);
  assert.deepEqual(["seekBackward", "seekForward", "open", "closeLid", "eject", "select"].every((id) => ids.includes(id)), true);
  assert.equal(normalizeTransportSfxAction("rewind"), "seekBackward");
  assert.equal(normalizeTransportSfxAction("forward"), "seekForward");
  assert.equal(normalizeTransportSfxAction("closeLid"), "closeLid");
});


test("shuttle button SFX receives a bounded gain boost", () => {
  assert.equal(resolveTransportSfxVolume("play", 0.5), 0.5);
  assert.equal(resolveTransportSfxVolume("seekForward", 0.5), 0.675);
  assert.equal(resolveTransportSfxVolume("rewind", 0.8), 1);
  assert.equal(resolveTransportSfxVolume("seekBackward", 0), 0);
});


test("effect preset lookup is prototype-safe and presets are immutable", () => {
  assert.equal(getEffectPreset("constructor").id, "clean");
  assert.equal(getEffectPreset("toString").id, "clean");
  assert.equal(getEffectPreset("damaged").id, "damaged");
  assert.equal(Object.getPrototypeOf(EFFECT_PRESETS), null);
  assert.equal(Object.isFrozen(EFFECT_PRESETS), true);
  assert.equal(Object.isFrozen(EFFECT_PRESETS.damaged), true);
});
