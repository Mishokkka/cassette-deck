import { SETTINGS, TEMPLATES } from "../core/constants.mjs";
import { canOpenWidget } from "../core/permissions.mjs";
import { CassetteSocket } from "../core/socket.mjs";
import { getDeckState, getSetting, getWidgetState, setSetting, updateWidgetState } from "../core/settings.mjs";
import { clampOffset, estimateOffset } from "../models/deck-state.mjs";
import { normalizeDuration } from "../core/utils.mjs";
import { AudioEngine } from "../services/audio-engine.mjs";
import { openLibraryApp } from "./cassette-library-app.mjs";
import { openPermissionsApp } from "./permissions-app.mjs";
import { openDiagnosticsApp } from "./diagnostics-app.mjs";
import { SyncService } from "../services/sync-service.mjs";
import { PreloadService } from "../services/preload-service.mjs";

import { getLayoutOverride } from "./widget/widget-layout.mjs";
import { WidgetVolumeController } from "./widget/widget-volume-controller.mjs";
import { WidgetDragController } from "./widget/widget-drag-controller.mjs";
import { WidgetResizeController } from "./widget/widget-resize-controller.mjs";
import { WidgetCalibrationController } from "./widget/widget-calibration-controller.mjs";
import { WidgetActionController } from "./widget/widget-action-controller.mjs";
import {
  effectiveDeckStateFromRuntime,
  formatTime,
  fixedTimeLabel,
  isPureVolumeDeckStateChange,
  preloadSummaryLabel
} from "./widget/widget-state.mjs";
import { buildWidgetContext } from "./widget/widget-context.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TRANSIENT_REEL_RENDER_MS = 560;

let widgetInstance = null;
export class CassetteWidget extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "cassette-deck-widget",
    classes: ["cassette-deck", "cd-widget-app"],
    tag: "aside",
    window: { frame: false },
    position: { width: 430, height: "auto" }
  };

  static PARTS = { body: { template: TEMPLATES.widget } };

  #progressTimer = null;
  #renderTimer = null;
  #momentaryTimers = new Set();
  #cachedDeckState = null;
  #lastStrategyWarmKey = null;
  #momentaryPressed = new Map();
  #currentPlayerCanvas = null;
  #scaleObserver = null;
  #scaleRaf = null;
  #titleMeasureCanvas = null;
  #timeSlotRefs = null;
  #lastTimeLabels = { current: null, duration: null };
  #currentSelectedTrack = null;
  #boundVisibilityChange = () => {
    if (document.visibilityState === "hidden") this.#stopProgressTimer();
    else this.#startProgressTimer();
  };
  #resizeController = new WidgetResizeController({
    getElement: () => this.element,
    isRendered: () => this.rendered,
    getSavedSize: () => getWidgetState().lastKnownSize,
    saveSize: (size) => updateWidgetState({ lastKnownSize: size }),
    setAppSize: (size) => this.#setApplicationSize(size),
    setAppPosition: (position) => this.#setApplicationPosition(position),
    savePosition: (position) => updateWidgetState({ lastKnownPosition: position })
  });
  #dragController = new WidgetDragController({
    getElement: () => this.element,
    isRendered: () => this.rendered,
    getSavedPosition: () => getWidgetState().lastKnownPosition,
    savePosition: (position) => updateWidgetState({ lastKnownPosition: position }),
    setAppPosition: (position) => this.#setApplicationPosition(position)
  });
  #calibrationController = new WidgetCalibrationController({
    getElement: () => this.element,
    canEdit: () => game.user?.isGM && getWidgetState().calibrationMode,
    getCanvas: () => this.#currentPlayerCanvas,
    saveArea: (id, area) => this.#saveLayoutArea(id, area)
  });
  #volumeController = new WidgetVolumeController({
    getElement: () => this.element,
    getDeckState: () => getDeckState(),
    transportVolume: (volume) => CassetteSocket.transport("volume", { volume }),
    previewVolume: (volume) => AudioEngine.previewVolume?.(volume),
    isSilentResult: (result) => this.#isSilentPermissionResult(result)
  });

  #actionController = new WidgetActionController({
    getElement: () => this.element,
    rememberPosition: () => this.#dragController.rememberCurrentPosition(),
    callbacks: {
      close: () => this.close(),
      openSettings: () => this.#openSettings(),
      requestSync: () => SyncService.requestSync({ reason: "widget", notify: true }),
      openLibrary: () => openLibraryApp(),
      openPermissions: () => openPermissionsApp(),
      openDiagnostics: () => openDiagnosticsApp(),
      toggleDebugOverlay: () => this.#toggleDebugOverlay(),
      toggleCalibrationMode: () => this.#toggleCalibrationMode(),
      resetLayoutOverride: () => this.#resetLayoutOverride(),
      exportLayoutOverride: () => this.#exportLayoutOverride(),
      toggleLibrary: () => this.#toggleLibrary(),
      openLid: () => this.#openLid(),
      closeLid: () => this.#closeLid(),
      selectCassette: (cassetteId) => this.#selectCassette(cassetteId),
      transport: (action, options = {}) => this.#transport(action, options),
      pulseMomentary: (id) => this.#pulseMomentaryButton(id)
    }
  });

  render(options = {}) {
    if (this.#renderTimer !== null) {
      window.clearTimeout(this.#renderTimer);
      this.#renderTimer = null;
    }
    this.#dragController.rememberCurrentPosition();
    this.#resizeController.rememberCurrentSize();
    return super.render(options);
  }

  requestRender({ delay = 35 } = {}) {
    if (!this.rendered) return;
    if (this.#renderTimer !== null) return;
    this.#renderTimer = window.setTimeout(() => {
      this.#renderTimer = null;
      if (this.rendered) void this.render({ force: true });
    }, Math.max(0, Number(delay) || 0));
  }

  #setApplicationPosition(position = {}) {
    const left = Math.round(Number(position.left));
    const top = Math.round(Number(position.top));
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;

    try {
      this.setPosition?.({ left, top });
    } catch (_error) {
      // Direct style assignment below is enough when ApplicationV2 rejects partial position updates.
    }

    const element = this.element;
    if (!element?.style) return;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.right = "auto";
    element.style.bottom = "auto";
  }

  #setApplicationSize(size = {}) {
    const width = Math.round(Number(size.width));
    if (!Number.isFinite(width) || width <= 0) return;

    try {
      this.setPosition?.({ width });
    } catch (_error) {
      // Direct style assignment below is enough when ApplicationV2 rejects partial size updates.
    }

    const element = this.element;
    if (!element?.style) return;
    element.style.width = `${width}px`;
    element.style.maxWidth = "calc(100vw - 16px)";
  }


  #isMomentaryPressed(id) {
    const expiresAt = this.#momentaryPressed.get(id);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.#momentaryPressed.delete(id);
      return false;
    }
    return true;
  }

  #pulseMomentaryButton(id, duration = 300) {
    this.#momentaryPressed.set(id, Date.now() + duration);
    this.#setButtonPressedDom(id, true);
    const timer = window.setTimeout(() => {
      this.#momentaryTimers.delete(timer);
      if (!this.#momentaryPressed.has(id)) return;
      this.#momentaryPressed.delete(id);
      if (!this.rendered) return;
      this.#setButtonPressedDom(id, this.#isPersistentButtonPressed(id));
    }, duration);
    this.#momentaryTimers.add(timer);
  }

  #isPersistentButtonPressed(id) {
    const state = this.#effectiveDeckState(AudioEngine.getRuntimeState());
    if (id === "play") return state.status === "playing";
    if (id === "pause") return state.status === "paused";
    if (id === "stop") return state.status === "stopped";
    if (id === "open") return Boolean(state.lidOpen);
    return false;
  }

  #setButtonPressedDom(id, pressed) {
    const button = this.element?.querySelector?.(`[data-button-id="${CSS.escape(String(id))}"]`);
    if (!button) return;
    button.classList.toggle("is-pressed", Boolean(pressed));
    const image = button.querySelector?.(".cd-shell-button__image");
    if (!image) return;
    const src = pressed ? button.dataset.pressedSrc : button.dataset.normalSrc;
    if (src && image.getAttribute("src") !== src) image.setAttribute("src", src);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const runtime = AudioEngine.getRuntimeState();
    this.#cachedDeckState ??= getDeckState();
    const deckState = this.#effectiveDeckState(runtime);
    const prepared = await buildWidgetContext({
      baseContext: context,
      deckState,
      runtime,
      resolveDuration: (track, currentRuntime) => this.#resolveDuration(track, currentRuntime),
      getVolumePercent: (state) => this.#volumeController.getUiPercent(state),
      isMomentaryPressed: (id) => this.#isMomentaryPressed(id),
      preloadSummary: () => this.#preloadSummary()
    });
    this.#currentPlayerCanvas = prepared.canvas;
    this.#currentSelectedTrack = prepared.selectedTrack ?? null;
    return prepared.context;
  }
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#resizeController.applySavedSize();
    this.#dragController.applySavedPosition();
    window.requestAnimationFrame?.(() => {
      this.#resizeController.applySavedSize();
      this.#dragController.applySavedPosition();
    });
    this.#dragController.attach();
    this.#resizeController.attach();
    this.#calibrationController.attach();

    this.#actionController.attach();
    this.#volumeController.attach();
    document.removeEventListener("visibilitychange", this.#boundVisibilityChange);
    document.addEventListener("visibilitychange", this.#boundVisibilityChange);

    this.#cacheProgressDom();
    this.#startProgressTimer();
    this.#ensureDurationPreload();
    this.#ensureStrategyPreload();
    this.#updateProgressDom();
    this.#volumeController.updateThumb();
    this.#attachScaleObserver();
  }

  async _preClose(options) {
    this.#stopProgressTimer();
    if (this.#renderTimer !== null) window.clearTimeout(this.#renderTimer);
    this.#renderTimer = null;
    document.removeEventListener("visibilitychange", this.#boundVisibilityChange);
    this.#detachScaleObserver();
    this.#timeSlotRefs = null;
    this.#currentSelectedTrack = null;
    for (const timer of this.#momentaryTimers) window.clearTimeout(timer);
    this.#momentaryTimers.clear();
    this.#momentaryPressed.clear();
    this.#dragController.detach();
    this.#resizeController.detach();
    this.#calibrationController.detach();
    this.#volumeController.detach();
    this.#actionController.detach();
    if (widgetInstance === this) widgetInstance = null;
    await super._preClose?.(options);
  }

  #attachScaleObserver() {
    this.#detachScaleObserver();
    const shell = this.element?.querySelector?.(".cd-player-shell");
    if (!shell) return;

    const schedule = () => this.#scheduleScaleUpdate(shell);
    schedule();

    if (typeof ResizeObserver === "function") {
      this.#scaleObserver = new ResizeObserver(schedule);
      this.#scaleObserver.observe(shell);
    }
  }

  #scheduleScaleUpdate(shell) {
    if (this.#scaleRaf !== null) return;
    const run = () => {
      this.#scaleRaf = null;
      if (!this.rendered || !shell?.isConnected) return;
      const rect = shell.getBoundingClientRect?.();
      const width = Number(rect?.width);
      if (Number.isFinite(width) && width > 0) {
        const scale = Math.min(3, Math.max(0.45, width / 430));
        shell.style.setProperty("--cd-player-scale", scale.toFixed(4));
      }
      this.#fitCassetteTitle();
    };
    if (typeof window.requestAnimationFrame === "function") this.#scaleRaf = window.requestAnimationFrame(run);
    else run();
  }

  #detachScaleObserver() {
    this.#scaleObserver?.disconnect?.();
    this.#scaleObserver = null;
    if (this.#scaleRaf !== null && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(this.#scaleRaf);
    this.#scaleRaf = null;
  }

  #fitCassetteTitle() {
    const box = this.element?.querySelector?.("[data-cd-cassette-title]");
    const label = box?.querySelector?.("[data-cd-cassette-title-text]");
    if (!box || !label) return;

    const original = String(label.dataset.cdOriginalText || label.textContent || "").replace(/\s+/g, " ").trim();
    if (!original) return;
    label.dataset.cdOriginalText = original;

    const rect = box.getBoundingClientRect?.();
    const width = Number(rect?.width);
    const height = Number(rect?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;

    const style = getComputedStyle(label);
    const family = style.fontFamily || "sans-serif";
    const weight = style.fontWeight || "700";
    const canvas = this.#titleMeasureCanvas ??= document.createElement("canvas");
    const context = canvas.getContext?.("2d");
    const measureAt = 100;
    if (context) context.font = `${weight} ${measureAt}px ${family}`;

    const measureLine = (line) => {
      if (context) {
        const measured = context.measureText(line).width;
        if (Number.isFinite(measured) && measured > 0) return measured;
      }
      return Math.max(1, String(line).length * 52);
    };

    const lineHeight = 1.06;
    const allowedWidth = Math.max(1, width * 0.92);
    const allowedHeight = Math.max(1, height * 0.86);
    const maxSize = 42;

    const scoreLines = (lines) => {
      const maxWidthAtMeasure = Math.max(1, ...lines.map(measureLine));
      const sizeByWidth = (allowedWidth * measureAt) / maxWidthAtMeasure;
      const sizeByHeight = allowedHeight / Math.max(1, lines.length * lineHeight);
      return Math.max(4, Math.min(sizeByWidth, sizeByHeight, maxSize));
    };

    let bestLines = [original];
    let bestSize = scoreLines(bestLines);

    const singleWidthAtMax = (measureLine(original) * maxSize) / measureAt;
    if (singleWidthAtMax > allowedWidth) {
      const words = original.split(/\s+/g).filter(Boolean);
      if (words.length > 1) {
        for (let index = 1; index < words.length; index += 1) {
          const candidate = [words.slice(0, index).join(" "), words.slice(index).join(" ")];
          const size = scoreLines(candidate);
          if (size > bestSize + 0.4) {
            bestSize = size;
            bestLines = candidate;
          }
        }
      }
    }

    label.textContent = bestLines.join("\n");
    let size = bestSize;
    label.style.fontSize = `${size.toFixed(2)}px`;

    // One verification read catches font/canvas measurement differences without a read/write layout loop.
    const labelRect = label.getBoundingClientRect?.();
    if (labelRect && (labelRect.width > width * 0.96 || labelRect.height > height * 0.94)) {
      const widthRatio = (width * 0.96) / Math.max(1, labelRect.width);
      const heightRatio = (height * 0.94) / Math.max(1, labelRect.height);
      const ratio = Math.min(1, widthRatio, heightRatio);
      const estimatedDecrease = Math.max(1, Math.ceil(size - (size * ratio)));
      size = Math.max(4, size - Math.min(12, estimatedDecrease));
      label.style.fontSize = `${size.toFixed(2)}px`;
    }
  }

  async #toggleLibrary() {
    const current = getWidgetState();
    await updateWidgetState({ browserOpen: !current.browserOpen });
    await this.render({ force: true });
  }

  async #openLid() {
    const result = await CassetteSocket.transport("open");
    if (!result?.ok) {
      if (!this.#isSilentPermissionResult(result)) {
        ui.notifications.warn(`Cassette Deck: крышку нельзя открыть (${result?.reason ?? "unknown"}).`);
      }
      return result;
    }

    await updateWidgetState({ browserOpen: true });
    await this.render({ force: true });
    return result;
  }

  async #closeLid() {
    const result = await CassetteSocket.transport("closeLid");
    if (!result?.ok && !this.#isSilentPermissionResult(result)) {
      ui.notifications.warn(`Cassette Deck: крышку нельзя закрыть (${result?.reason ?? "unknown"}).`);
    }
    await this.render({ force: true });
    return result;
  }

  async #toggleDebugOverlay() {
    const current = getWidgetState();
    await updateWidgetState({ debugOverlay: !current.debugOverlay });
    await this.render({ force: true });
  }

  async #toggleCalibrationMode() {
    const current = getWidgetState();
    const enabled = !current.calibrationMode;
    await updateWidgetState({ calibrationMode: enabled, debugOverlay: enabled ? true : current.debugOverlay });
    await this.render({ force: true });
  }

  async #resetLayoutOverride() {
    await setSetting(SETTINGS.playerLayoutOverride, {});
    ui.notifications.info("Cassette Deck: layout override сброшен.");
    await this.render({ force: true });
  }

  #exportLayoutOverride() {
    const override = getLayoutOverride();
    console.log("Cassette Deck layout override", JSON.stringify(override, null, 2));
    ui.notifications.info("Cassette Deck: layout override выведен в консоль браузера.");
  }

  async #openSettings() {
    const sheet = game.settings?.sheet;
    if (sheet?.render) {
      try {
        return sheet.render({ force: true });
      } catch (error) {
        return sheet.render(true);
      }
    }
    const SettingsConfig = foundry.applications?.settings?.SettingsConfig;
    if (SettingsConfig) return new SettingsConfig().render({ force: true });
    ui.notifications?.info?.("Открой Configure Settings → Module Settings → Cassette Deck.");
    return null;
  }

  async #selectCassette(cassetteId) {
    if (!cassetteId) return;
    const result = await CassetteSocket.selectCassette(cassetteId);
    if (result?.ok) {
      await this.render({ force: true });
      if (game.user.isGM) ui.notifications.info("Cassette Deck: кассета вставлена.");
    } else if (!this.#isSilentPermissionResult(result)) {
      ui.notifications.warn(`Cassette Deck: кассету нельзя выбрать (${result?.reason ?? "unknown"}).`);
    }
  }

  async #transport(action, options = {}) {
    const result = await CassetteSocket.transport(action, options);
    if (result?.ok) return;
    if (this.#isSilentPermissionResult(result)) return;
    ui.notifications.warn(`Cassette Deck: команда отклонена (${result?.reason ?? "unknown"}).`);
  }

  refreshFromTransportCommand(command = null) {
    this.#dragController.rememberCurrentPosition();
    this.#updateProgressDom();
    if (command?.action === "volume" && Number.isFinite(Number(command.volume))) {
      this.#volumeController.syncFromDeckState(command);
      return null;
    }
    if (command?.action === "noop") return null;

    this.requestRender();
    if (["seek", "cue"].includes(String(command?.action || ""))) {
      window.setTimeout(() => {
        if (!this.rendered) return;
        this.requestRender({ delay: 0 });
      }, Math.max(TRANSIENT_REEL_RENDER_MS, Number(command?.transportDelayMs ?? 0) + 60 || TRANSIENT_REEL_RENDER_MS));
    }
    return null;
  }

  #effectiveDeckState(runtime = AudioEngine.getRuntimeState(), baseState = this.#cachedDeckState) {
    return effectiveDeckStateFromRuntime({ runtime, baseState: baseState ?? getDeckState() });
  }

  #startProgressTimer() {
    this.#stopProgressTimer();
    const tick = () => {
      this.#progressTimer = null;
      if (!this.rendered || document.visibilityState === "hidden") return;
      this.#updateProgressDom();
      const state = this.#effectiveDeckState(AudioEngine.getRuntimeState());
      if (state.status === "playing") this.#progressTimer = window.setTimeout(tick, 200);
    };

    const state = this.#effectiveDeckState(AudioEngine.getRuntimeState());
    if (state.status !== "playing" || document.visibilityState === "hidden") return;
    this.#updateProgressDom();
    this.#progressTimer = window.setTimeout(tick, 200);
  }

  #stopProgressTimer() {
    if (this.#progressTimer !== null) window.clearTimeout(this.#progressTimer);
    this.#progressTimer = null;
  }

  #cacheProgressDom() {
    const build = (kind) => {
      const container = this.element?.querySelector?.(`[data-cd-time-slots="${kind}"]`);
      if (!container) return null;
      return { container, chars: Array.from(container.querySelectorAll?.("[data-cd-time-char]") ?? []) };
    };
    this.#timeSlotRefs = { current: build("current"), duration: build("duration") };
    this.#lastTimeLabels = { current: null, duration: null };
  }

  #updateProgressDom() {
    if (!this.rendered || !this.element) return;
    const runtime = AudioEngine.getRuntimeState();
    const deckState = this.#effectiveDeckState(runtime);
    const duration = normalizeDuration(deckState.duration)
      ?? PreloadService.getCachedDuration(deckState.trackPath)
      ?? normalizeDuration(runtime?.duration);
    const offset = clampOffset(estimateOffset(deckState), duration);

    this.#updateTimeSlots("current", formatTime(offset));
    this.#updateTimeSlots("duration", formatTime(duration));
  }

  #updateTimeSlots(kind, label) {
    const normalized = fixedTimeLabel(label);
    if (this.#lastTimeLabels[kind] === normalized) return;
    const refs = this.#timeSlotRefs?.[kind];
    if (!refs?.container) return;
    this.#lastTimeLabels[kind] = normalized;
    refs.container.setAttribute("aria-label", normalized);
    const chars = normalized.split("");
    refs.chars.forEach((node, index) => {
      const char = chars[index] ?? "-";
      if (node.textContent !== char) node.textContent = char;
      node.classList.toggle("is-digit", /\d/.test(char));
      node.classList.toggle("is-separator", char === ":");
      node.classList.toggle("is-blank", char === "-");
    });
  }

  #resolveDuration(track = null, runtime = null) {
    const trackDuration = normalizeDuration(track?.duration);
    if (trackDuration !== null) return trackDuration;
    const cachedDuration = PreloadService.getCachedDuration(track?.path);
    if (cachedDuration !== null) return cachedDuration;
    const runtimeDuration = normalizeDuration(runtime?.duration);
    if (runtimeDuration !== null) return runtimeDuration;
    return null;
  }

  #ensureDurationPreload() {
    const selectedTrack = this.#currentSelectedTrack;
    if (!selectedTrack?.path) return;
    void PreloadService.preloadTrack(selectedTrack).then(() => this.#updateProgressDom());
  }

  #ensureStrategyPreload() {
    const deckState = this.#effectiveDeckState(AudioEngine.getRuntimeState());
    const strategy = String(getSetting(SETTINGS.preloadStrategy) || "cassette");
    const key = `${strategy}:${deckState.cassetteId ?? "none"}:${deckState.trackId ?? "none"}`;
    if (key === this.#lastStrategyWarmKey) return;
    this.#lastStrategyWarmKey = key;
    void PreloadService.warmFromCurrentContext({ reason: "widget-render" }).then(() => this.#updateProgressDom());
  }

  #preloadSummary() {
    return preloadSummaryLabel(PreloadService.getSummary());
  }


  async #saveLayoutArea(id, area) {
    const current = getLayoutOverride();
    const next = foundry.utils.mergeObject(current, { areas: { [id]: area } }, { inplace: false });
    await setSetting(SETTINGS.playerLayoutOverride, next);
  }

  cacheDeckState(deckState) {
    const previous = this.#cachedDeckState ?? null;
    this.#cachedDeckState = foundry.utils.mergeObject(this.#cachedDeckState ?? getDeckState(), deckState ?? {}, { inplace: false });

    const pureVolumeChange = isPureVolumeDeckStateChange(previous, deckState);
    if (pureVolumeChange && !this.#volumeController.dragging && Number.isFinite(Number(deckState?.volume))) {
      this.#volumeController.syncFromDeckState(deckState);
      return false;
    }

    return true;
  }

  invalidatePreloadWarmKey() {
    this.#lastStrategyWarmKey = null;
  }

  #isSilentPermissionResult(result) {
    if (game.user?.isGM) return false;
    return ["PERMISSION_DENIED", "NOT_VISIBLE", "NOT_AVAILABLE", "NOT_PLAYING", "WIDGET_CLOSED"].includes(String(result?.code || ""));
  }
}

export function getWidget() {
  return widgetInstance;
}

export async function openWidget({ force = false, silent = true } = {}) {
  if (!canOpenWidget(game.user)) {
    if (!silent && game.user?.isGM) ui.notifications.warn("Cassette Deck: у этого пользователя нет доступа к виджету.");
    return null;
  }
  if (!widgetInstance) widgetInstance = new CassetteWidget();
  await widgetInstance.render({ force: true });
  if (force) widgetInstance.bringToFront();
  return widgetInstance;
}

export async function closeWidget() {
  if (!widgetInstance?.rendered) {
    widgetInstance = null;
    return;
  }
  await widgetInstance.close();
  widgetInstance = null;
}

export async function toggleWidget() {
  if (widgetInstance?.rendered) return closeWidget();
  return openWidget({ force: true, silent: false });
}
