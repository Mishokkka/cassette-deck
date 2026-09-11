import test from "node:test";
import assert from "node:assert/strict";
import { resolveWidgetPositionCandidate } from "../scripts/apps/widget/widget-drag-controller.mjs";
import { WidgetResizeController, resolveWidgetSizeCandidate } from "../scripts/apps/widget/widget-resize-controller.mjs";
import {
  effectiveDeckStateFromRuntime,
  formatTime,
  fixedTimeLabel,
  timeSlots,
  isPureVolumeDeckStateChange,
  preloadSummaryLabel,
  statusFromTransportAction,
  statusLabel
} from "../scripts/apps/widget/widget-state.mjs";

test("widget effective deck state prefers fresh transport commands", () => {
  const base = { seq: 10, status: "paused", cassetteId: "c1", trackId: "t1", offset: 15, volume: 0.5 };
  const result = effectiveDeckStateFromRuntime({
    baseState: base,
    now: 20_000,
    runtime: {
      command: {
        seq: 11,
        action: "play",
        cassetteId: "c2",
        trackId: "t9",
        offset: 4,
        volume: 0.7,
        issuedAt: 18_000
      }
    }
  });

  assert.equal(result.status, "playing");
  assert.equal(result.cassetteId, "c2");
  assert.equal(result.trackId, "t9");
  assert.equal(result.startedAt, 18_000);
  assert.equal(result.pausedAt, null);
});

test("widget effective deck state ignores stale transport commands", () => {
  const base = { seq: 10, status: "playing", volume: 0.5 };
  const result = effectiveDeckStateFromRuntime({ baseState: base, runtime: { command: { seq: 9, action: "stop" } } });
  assert.equal(result, base);
});

test("widget volume-only command only updates volume", () => {
  const base = { seq: 10, status: "playing", cassetteId: "c1", trackId: "t1", offset: 5, volume: 0.5 };
  const result = effectiveDeckStateFromRuntime({ baseState: base, runtime: { command: { seq: 12, action: "volume", volume: 0.8 } } });
  assert.equal(result.status, "playing");
  assert.equal(result.volume, 0.8);
  assert.equal(result.seq, 12);
});

test("widget labels and formatting are stable", () => {
  assert.equal(statusFromTransportAction("cue"), "paused");
  assert.equal(statusFromTransportAction("eject"), "idle");
  assert.equal(statusLabel("stopped"), "Остановлено");
  assert.equal(formatTime(65.9), "01:05");
  assert.equal(formatTime(-1), "--:--");
  assert.equal(fixedTimeLabel("1:2"), "--:--");
  assert.deepEqual(timeSlots("00:01").map((slot) => slot.char), ["0", "0", ":", "0", "1"]);
  assert.equal(preloadSummaryLabel({ strategy: "cassette", cacheSize: 2, maxEntries: 12, ready: 1 }), "preload: cassette · cache 2/12 · ready 1");
});

test("widget pure volume change detection ignores transport-only volume updates", () => {
  const previous = { status: "playing", cassetteId: "c1", trackId: "t1", startedAt: 100, pausedAt: null, offset: 4, volume: 0.5 };
  const next = { ...previous, volume: 0.8 };
  assert.equal(isPureVolumeDeckStateChange(previous, next), true);
  assert.equal(isPureVolumeDeckStateChange(previous, { ...next, offset: 5 }), false);
});


test("widget position candidate prefers saved position over volatile render fallback", () => {
  const result = resolveWidgetPositionCandidate({
    saved: { left: 320, top: 180 },
    volatile: { left: 24, top: 96 }
  });

  assert.deepEqual(result, { left: 320, top: 180, source: "saved" });
  assert.equal(resolveWidgetPositionCandidate({ saved: null, volatile: null }), null);
});
import { buildTransportButtons, buttonAsset, widgetSkinClass } from "../scripts/apps/widget/widget-context.mjs";

test("widget skin class validates known skins and falls back to field", () => {
  assert.equal(widgetSkinClass("amber"), "cd-widget--skin-amber");
  assert.equal(widgetSkinClass("bad-value"), "cd-widget--skin-field");
});

test("widget transport button builder applies visibility, press state and assets", () => {
  const canvas = { width: 100, height: 100 };
  const areas = {
    buttonPlay: { x: 10, y: 20, w: 30, h: 40 },
    buttonRewind: { x: 1, y: 2, w: 3, h: 4 },
    buttonForward: { x: 5, y: 6, w: 7, h: 8 },
    buttonPrevious: { x: 9, y: 10, w: 11, h: 12 },
    buttonNext: { x: 13, y: 14, w: 15, h: 16 },
    buttonStop: { x: 17, y: 18, w: 19, h: 20 },
    buttonPause: { x: 21, y: 22, w: 23, h: 24 },
    buttonOpen: { x: 25, y: 26, w: 27, h: 28 }
  };
  const buttons = buildTransportButtons({
    controls: { play: true, pause: false, stop: true, seek: true, next: false, previous: true, eject: false },
    deckState: { status: "playing", cassetteId: "c1" },
    canBrowseUnlocked: true,
    areas,
    canvas,
    isMomentaryPressed: (id) => id === "rewind"
  });

  assert.deepEqual(buttons.map((button) => button.id), ["play", "rewind", "forward", "previous", "next", "stop", "pause", "open"]);
  assert.equal(buttons.find((button) => button.id === "play").pressed, true);
  assert.equal(buttons.find((button) => button.id === "rewind").pressed, true);
  assert.equal(buttons.find((button) => button.id === "open").pressed, false);
  assert.equal(buttons.find((button) => button.id === "open").action, "open-lid");
  assert.match(buttons.find((button) => button.id === "open").title, /Открыть крышку/);
  assert.equal(buttons.find((button) => button.id === "pause").disabled, true);
  assert.equal(buttons.find((button) => button.id === "next").disabled, true);
  assert.equal(buttons.find((button) => button.id === "open").disabled, false);
  assert.match(buttons.find((button) => button.id === "play").style, /left:10\.000%/);
  assert.equal(buttons.find((button) => button.id === "play").asset, buttonAsset("play", true));
  assert.equal(buttons.find((button) => button.id === "play").normalAsset, buttonAsset("play", false));
  assert.equal(buttons.find((button) => button.id === "play").pressedAsset, buttonAsset("play", true));
});


test("physical OPEN button reflects only the lid state", () => {
  const buttons = buildTransportButtons({
    controls: { play: true, pause: true, stop: true, seek: true, next: true, previous: true, eject: true },
    deckState: { status: "idle", lidOpen: true },
    canBrowseUnlocked: true,
    areas: {
      buttonPlay: {}, buttonRewind: {}, buttonForward: {}, buttonPrevious: {},
      buttonNext: {}, buttonStop: {}, buttonPause: {}, buttonOpen: {}
    },
    canvas: { width: 100, height: 100 },
    isMomentaryPressed: () => false
  });

  assert.equal(buttons.find((button) => button.id === "open").pressed, true);
  assert.equal(buttons.find((button) => button.id === "open").action, "open-lid");
});


test("widget size candidate keeps an explicit volatile width ahead of persisted state", () => {
  const result = resolveWidgetSizeCandidate({
    saved: { width: 320 },
    volatile: { width: 512 }
  });

  assert.deepEqual(result, { width: 512, source: "volatile" });
  assert.deepEqual(resolveWidgetSizeCandidate({ saved: { width: 476 }, volatile: null }), { width: 476, source: "saved" });
  assert.equal(resolveWidgetSizeCandidate({ saved: null, volatile: null }), null);
});

test("widget viewport clamping does not overwrite the preferred saved width", () => {
  const previousWindow = globalThis.window;
  const css = new Map();
  const style = {
    width: "",
    maxWidth: "",
    setProperty: (name, value) => css.set(name, value)
  };
  globalThis.window = { innerWidth: 336 };
  try {
    const controller = new WidgetResizeController({
      getElement: () => ({ style }),
      isRendered: () => true,
      getSavedSize: () => ({ width: 700 })
    });

    controller.applySavedSize();
    assert.equal(css.get("--cd-widget-width"), "320px");
    assert.deepEqual(controller.getPreferredSize(), { width: 700, source: "saved" });

    globalThis.window.innerWidth = 1200;
    assert.deepEqual(controller.getEffectiveSize(), { width: 700, source: "saved" });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("widget size controller publishes an authoritative CSS width variable", () => {
  const previousWindow = globalThis.window;
  const css = new Map();
  const style = {
    width: "",
    maxWidth: "",
    setProperty: (name, value) => css.set(name, value)
  };
  globalThis.window = { innerWidth: 1200 };
  try {
    const controller = new WidgetResizeController({
      getElement: () => ({ style }),
      isRendered: () => true,
      getSavedSize: () => ({ width: 684 })
    });

    controller.applySavedSize();
    assert.equal(css.get("--cd-widget-width"), "684px");
    assert.equal(style.width, "684px");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});


test("widget resize commit keeps the pointer-selected width even if the DOM is reset before pointerup", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;

  const documentHandlers = new Map();
  const handleHandlers = new Map();
  const css = new Map();
  let savedSize = null;
  let rectPhase = "start";

  const style = {
    width: "",
    maxWidth: "",
    left: "",
    top: "",
    right: "",
    bottom: "",
    setProperty: (name, value) => css.set(name, value)
  };
  const element = {
    style,
    classList: { add() {}, remove() {} },
    querySelector: () => handle,
    getBoundingClientRect: () => rectPhase === "start"
      ? { width: 430, height: 266, left: 24, top: 96 }
      : { width: 320, height: 198, left: 24, top: 96 }
  };
  const handle = {
    addEventListener: (type, fn) => handleHandlers.set(type, fn),
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {}
  };

  globalThis.window = {
    innerWidth: 1400,
    innerHeight: 900,
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame() {}
  };
  globalThis.document = {
    addEventListener: (type, fn) => documentHandlers.set(type, fn),
    removeEventListener() {}
  };

  try {
    const controller = new WidgetResizeController({
      getElement: () => element,
      isRendered: () => true,
      getSavedSize: () => ({ width: 320 }),
      saveSize: async (size) => { savedSize = size; },
      setAppPosition: () => {},
      savePosition: async () => {}
    });
    controller.attach();

    handleHandlers.get("pointerdown")({
      button: 0,
      pointerId: 1,
      clientX: 100,
      currentTarget: handle,
      preventDefault() {},
      stopPropagation() {}
    });

    documentHandlers.get("pointermove")({
      pointerId: 1,
      clientX: 370,
      preventDefault() {}
    });

    rectPhase = "reset";
    await documentHandlers.get("pointerup")({ pointerId: 1 });

    assert.deepEqual(savedSize, { width: 700 });
    assert.equal(css.get("--cd-widget-width"), "700px");
    assert.equal(style.width, "700px");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});


test("widget shuttle delay keeps source offset visible until preview completes", () => {
  const baseState = { seq: 10, status: "playing", cassetteId: "c1", trackId: "t1", offset: 12, startedAt: 1000, volume: 0.8, lidOpen: false };
  const runtime = {
    command: {
      seq: 11,
      action: "seek",
      status: "playing",
      cassetteId: "c1",
      trackId: "t1",
      offset: 22,
      shuttleFromOffset: 12,
      transportDelayMs: 500,
      issuedAt: 2000,
      volume: 0.8,
      lidOpen: false
    }
  };

  assert.equal(effectiveDeckStateFromRuntime({ runtime, baseState, now: 2200 }).offset, 12);
  assert.equal(effectiveDeckStateFromRuntime({ runtime, baseState, now: 2600 }).offset, 22);
});


test("widget shuttle can display source track during next-track shuttle", () => {
  const baseState = { seq: 10, status: "playing", cassetteId: "c1", trackId: "t1", offset: 90, startedAt: 1000, volume: 0.8, lidOpen: false };
  const runtime = {
    command: {
      seq: 11,
      action: "seek",
      status: "playing",
      cassetteId: "c1",
      trackId: "t2",
      offset: 0,
      shuttleFromOffset: 90,
      shuttleToOffset: 120,
      shuttleSourceTrackId: "t1",
      transportDelayMs: 500,
      issuedAt: 2000,
      volume: 0.8,
      lidOpen: false
    }
  };

  const during = effectiveDeckStateFromRuntime({ runtime, baseState, now: 2200 });
  assert.equal(during.trackId, "t1");
  assert.equal(during.offset, 90);

  const after = effectiveDeckStateFromRuntime({ runtime, baseState, now: 2600 });
  assert.equal(after.trackId, "t2");
  assert.equal(after.offset, 0);
  assert.equal(after.startedAt, 2500);
});
