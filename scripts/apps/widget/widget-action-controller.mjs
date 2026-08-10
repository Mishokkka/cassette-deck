const MOMENTARY_TRANSPORTS = Object.freeze({
  "transport-seek-backward": { id: "rewind", action: "seekBackward", options: { seconds: 10 }, duration: 520 },
  "transport-seek-forward": { id: "forward", action: "seekForward", options: { seconds: 10 }, duration: 520 },
  "transport-next": { id: "next", action: "next", options: {} },
  "transport-previous": { id: "previous", action: "previous", options: {} }
});

const SIMPLE_TRANSPORTS = Object.freeze({
  "transport-play": { id: "play", action: "play", duration: 300 },
  "transport-pause": { id: "pause", action: "pause", duration: 300 },
  "transport-stop": { id: "stop", action: "stop", duration: 300 },
  "transport-eject": { id: "open", action: "eject", duration: 300 }
});

export class WidgetActionController {
  #getElement;
  #rememberPosition;
  #callbacks;
  #logger;
  #boundOnClick = (event) => this.#onClick(event);
  #attachedRoot = null;
  #pendingSeekClicks = new Map();

  constructor({ getElement, rememberPosition, callbacks = {}, logger = console } = {}) {
    this.#getElement = getElement;
    this.#rememberPosition = rememberPosition;
    this.#callbacks = callbacks;
    this.#logger = logger;
  }

  attach() {
    this.detach();
    const element = this.#getElement?.();
    if (!element) return;
    element.addEventListener("click", this.#boundOnClick);
    this.#attachedRoot = element;
  }

  detach() {
    for (const timer of this.#pendingSeekClicks.values()) window.clearTimeout?.(timer);
    this.#pendingSeekClicks.clear();
    this.#attachedRoot?.removeEventListener?.("click", this.#boundOnClick);
    this.#attachedRoot = null;
  }

  async #onClick(event) {
    const root = this.#attachedRoot ?? this.#getElement?.();
    const target = event.target?.closest?.("[data-action]");
    if (!root || !target || !root.contains?.(target)) return;
    const action = target.dataset?.action;
    if (!action) return;
    event.preventDefault();
    this.#rememberPosition?.();
    return this.#dispatch(action, target, event);
  }


  #dispatchSeekClick(momentary, event = null) {
    const callbacks = this.#callbacks;
    const key = momentary.action;
    const pending = this.#pendingSeekClicks.get(key);
    const detail = Number(event?.detail ?? 1) || 1;

    if (pending || detail > 1) {
      if (pending) window.clearTimeout?.(pending);
      this.#pendingSeekClicks.delete(key);
      callbacks.pulseMomentary?.(momentary.id, Math.max(momentary.duration ?? 520, 560));
      return callbacks.transport?.(momentary.action, { ...(momentary.options ?? {}), seconds: 30 });
    }

    const timer = window.setTimeout(() => {
      this.#pendingSeekClicks.delete(key);
      callbacks.pulseMomentary?.(momentary.id, momentary.duration);
      void callbacks.transport?.(momentary.action, { ...(momentary.options ?? {}), seconds: 10 });
    }, 220);
    this.#pendingSeekClicks.set(key, timer);
    return null;
  }

  async #dispatch(action, target, event = null) {
    const callbacks = this.#callbacks;

    const simple = Object.hasOwn(SIMPLE_TRANSPORTS, action) ? SIMPLE_TRANSPORTS[action] : null;
    if (simple) {
      callbacks.pulseMomentary?.(simple.id, simple.duration);
      return callbacks.transport?.(simple.action);
    }

    const momentary = Object.hasOwn(MOMENTARY_TRANSPORTS, action) ? MOMENTARY_TRANSPORTS[action] : null;
    if (momentary) {
      if (momentary.action === "seekBackward" || momentary.action === "seekForward") {
        return this.#dispatchSeekClick(momentary, event);
      }
      callbacks.pulseMomentary?.(momentary.id, momentary.duration);
      return callbacks.transport?.(momentary.action, momentary.options);
    }

    switch (action) {
      case "close-widget":
        return callbacks.close?.();
      case "open-settings":
        return callbacks.openSettings?.();
      case "request-sync":
        return callbacks.requestSync?.();
      case "open-library":
        return callbacks.openLibrary?.();
      case "open-permissions":
        return callbacks.openPermissions?.();
      case "open-diagnostics":
        return callbacks.openDiagnostics?.();
      case "toggle-debug-overlay":
        return callbacks.toggleDebugOverlay?.();
      case "toggle-calibration-mode":
        return callbacks.toggleCalibrationMode?.();
      case "reset-layout-override":
        return callbacks.resetLayoutOverride?.();
      case "export-layout-override":
        return callbacks.exportLayoutOverride?.();
      case "toggle-widget-library":
        return callbacks.toggleLibrary?.();
      case "open-lid":
        return callbacks.openLid?.();
      case "close-lid":
        return callbacks.closeLid?.();
      case "select-cassette":
        return callbacks.selectCassette?.(target?.dataset?.cassetteId);
      default:
        this.#logger?.warn?.(`Unknown widget action: ${action}`);
        return null;
    }
  }
}
