import { clampPercent, numberOrNull, volumeGainToPercent, volumePercentToGain } from "./widget-volume.mjs";

export class WidgetVolumeController {
  #getElement;
  #getDeckState;
  #transportVolume;
  #previewVolume;
  #isSilentResult;
  #dragState = null;
  #moveHandler = null;
  #endHandler = null;
  #uiPercent = null;

  constructor({ getElement, getDeckState, transportVolume, previewVolume, isSilentResult } = {}) {
    this.#getElement = getElement;
    this.#getDeckState = getDeckState;
    this.#transportVolume = transportVolume;
    this.#previewVolume = previewVolume;
    this.#isSilentResult = isSilentResult;
  }

  get dragging() {
    return Boolean(this.#dragState);
  }

  getUiPercent(deckState = null) {
    if (Number.isFinite(this.#uiPercent)) return clampPercent(this.#uiPercent);
    this.#uiPercent = this.#percentFromDeckState(deckState ?? this.#getDeckState?.());
    return this.#uiPercent;
  }

  syncFromDeckState(deckState = null) {
    const percent = this.#percentFromDeckState(deckState ?? this.#getDeckState?.());
    this.#uiPercent = percent;
    this.updateThumb(percent);
    return percent;
  }

  updateThumb(value) {
    const element = this.#getElement?.();
    if (!element) return;
    const track = element.querySelector("[data-cd-volume-track]");
    if (!track) return;

    const fallback = this.getUiPercent(this.#getDeckState?.());
    const explicitValue = numberOrNull(value);
    const datasetValue = numberOrNull(track.dataset.volumeValue);
    const clamped = clampPercent(explicitValue ?? datasetValue ?? fallback, fallback);
    const top = 100 - clamped;

    this.#uiPercent = clamped;
    track.dataset.volumeValue = String(clamped);
    track.setAttribute("aria-valuenow", String(clamped));

    const thumb = track.querySelector("[data-cd-volume-thumb]");
    if (thumb) thumb.style.top = `${top}%`;
  }

  attach() {
    this.#getElement?.()?.querySelectorAll?.("[data-cd-volume-track]").forEach((element) => {
      element.addEventListener("pointerdown", this.#onPointerDown);
      element.addEventListener("keydown", this.#onKeyDown);
    });
  }

  detach() {
    this.#getElement?.()?.querySelectorAll?.("[data-cd-volume-track]").forEach((element) => {
      element.removeEventListener("pointerdown", this.#onPointerDown);
      element.removeEventListener("keydown", this.#onKeyDown);
    });
    if (this.#moveHandler) document.removeEventListener("pointermove", this.#moveHandler);
    if (this.#endHandler) {
      document.removeEventListener("pointerup", this.#endHandler);
      document.removeEventListener("pointercancel", this.#endHandler);
    }
    try { this.#dragState?.track?.releasePointerCapture?.(this.#dragState.pointerId); } catch (_error) {}
    this.#moveHandler = null;
    this.#endHandler = null;
    this.#dragState = null;
  }

  async #commit(value, { silent = false, previousValue = null } = {}) {
    const rollbackValue = clampPercent(previousValue, this.getUiPercent(this.#getDeckState?.()));
    const clamped = clampPercent(value, rollbackValue);
    const gain = volumePercentToGain(clamped);

    this.updateThumb(clamped);
    this.#previewVolume?.(gain);

    const result = await this.#transportVolume?.(gain);
    if (result?.ok) return result;

    this.#uiPercent = rollbackValue;
    this.updateThumb(rollbackValue);
    this.#previewVolume?.(volumePercentToGain(rollbackValue));
    if (!silent && !this.#isSilentResult?.(result)) {
      ui.notifications.warn(`Cassette Deck: громкость нельзя изменить (${result?.reason ?? "unknown"}).`);
    }
    return result;
  }

  #onKeyDown = async (event) => {
    const track = event.currentTarget;
    if (!track || track.dataset.disabled === "true") return;
    const current = this.getUiPercent(this.#getDeckState?.());
    let next = null;
    if (["ArrowUp", "ArrowRight"].includes(event.key)) next = current + (event.shiftKey ? 10 : 5);
    else if (["ArrowDown", "ArrowLeft"].includes(event.key)) next = current - (event.shiftKey ? 10 : 5);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 100;
    else return;
    event.preventDefault();
    await this.#commit(clampPercent(next), { previousValue: current });
  };

  #onPointerDown = (event) => {
    const track = event.currentTarget;
    if (!track || track.dataset.disabled === "true") return;
    if (event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();

    const startValue = this.getUiPercent(this.#getDeckState?.());
    const value = this.#valueFromPointer(event.clientY, track);
    this.#dragState = { pointerId: event.pointerId, track, value, startValue };
    track.classList.add("is-dragging");
    try { track.setPointerCapture?.(event.pointerId); } catch (_error) {}
    this.updateThumb(value);
    this.#previewVolume?.(volumePercentToGain(value));

    this.#moveHandler = this.#onPointerMove;
    this.#endHandler = this.#onPointerUp;
    document.addEventListener("pointermove", this.#moveHandler, { passive: false });
    document.addEventListener("pointerup", this.#endHandler);
    document.addEventListener("pointercancel", this.#endHandler);
  };

  #onPointerMove = (event) => {
    const state = this.#dragState;
    if (!state || event.pointerId !== state.pointerId) return;
    event.preventDefault();

    const value = this.#valueFromPointer(event.clientY, state.track);
    state.value = value;
    this.updateThumb(value);
    this.#previewVolume?.(volumePercentToGain(value));
  };

  #onPointerUp = async (event) => {
    const state = this.#dragState;
    if (!state || event.pointerId !== state.pointerId) return;

    if (this.#moveHandler) document.removeEventListener("pointermove", this.#moveHandler);
    if (this.#endHandler) {
      document.removeEventListener("pointerup", this.#endHandler);
      document.removeEventListener("pointercancel", this.#endHandler);
    }
    try { state.track?.releasePointerCapture?.(state.pointerId); } catch (_error) {}
    this.#moveHandler = null;
    this.#endHandler = null;
    state.track?.classList?.remove("is-dragging");
    this.#dragState = null;

    await this.#commit(state.value, { silent: false, previousValue: state.startValue });
  };

  #valueFromPointer(clientY, track) {
    const rect = track.getBoundingClientRect();
    if (!rect?.height) return this.getUiPercent(this.#getDeckState?.());
    const ratio = 1 - ((clientY - rect.top) / rect.height);
    return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  }

  #percentFromDeckState(deckState = null) {
    return volumeGainToPercent(deckState?.volume);
  }
}
