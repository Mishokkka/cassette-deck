import { areaStyle, roundedArea } from "./widget-layout.mjs";

export class WidgetCalibrationController {
  #getElement;
  #canEdit;
  #getCanvas;
  #saveArea;
  #state = null;
  #moveHandler = null;
  #endHandler = null;

  constructor({ getElement, canEdit, getCanvas, saveArea } = {}) {
    this.#getElement = getElement;
    this.#canEdit = canEdit;
    this.#getCanvas = getCanvas;
    this.#saveArea = saveArea;
  }

  attach() {
    if (!this.#canEdit?.()) return;
    this.#getElement?.()?.querySelectorAll?.("[data-cd-cal-zone]").forEach((element) => {
      element.addEventListener("pointerdown", this.#onStart);
    });
  }

  detach() {
    this.#getElement?.()?.querySelectorAll?.("[data-cd-cal-zone]").forEach((element) => {
      element.removeEventListener("pointerdown", this.#onStart);
    });
    if (this.#moveHandler) document.removeEventListener("pointermove", this.#moveHandler);
    if (this.#endHandler) {
      document.removeEventListener("pointerup", this.#endHandler);
      document.removeEventListener("pointercancel", this.#endHandler);
    }
    try { this.#state?.zone?.releasePointerCapture?.(this.#state.pointerId); } catch (_error) {}
    this.#moveHandler = null;
    this.#endHandler = null;
    this.#state = null;
  }

  #onStart = (event) => {
    if (event.button !== 0) return;
    const zone = event.currentTarget;
    const shell = this.#getElement?.()?.querySelector?.(".cd-player-shell");
    const canvas = this.#getCanvas?.();
    if (!zone || !shell || !canvas?.width || !canvas?.height) return;

    event.preventDefault();
    event.stopPropagation();

    const shellRect = shell.getBoundingClientRect();
    const zoneRect = zone.getBoundingClientRect();
    const scaleX = canvas.width / shellRect.width;
    const scaleY = canvas.height / shellRect.height;
    const startArea = {
      x: (zoneRect.left - shellRect.left) * scaleX,
      y: (zoneRect.top - shellRect.top) * scaleY,
      w: zoneRect.width * scaleX,
      h: zoneRect.height * scaleY
    };

    this.#state = {
      pointerId: event.pointerId,
      zone,
      id: zone.dataset.cdCalZone,
      mode: event.target?.closest?.("[data-cd-cal-resize]") ? "resize" : "move",
      startX: event.clientX,
      startY: event.clientY,
      shellRect,
      canvas,
      startArea
    };

    zone.classList.add("is-editing");
    try { zone.setPointerCapture?.(event.pointerId); } catch (_error) {}
    this.#moveHandler = this.#onMove;
    this.#endHandler = this.#onEnd;
    document.addEventListener("pointermove", this.#moveHandler, { passive: false });
    document.addEventListener("pointerup", this.#endHandler);
    document.addEventListener("pointercancel", this.#endHandler);
  };

  #onMove = (event) => {
    const state = this.#state;
    if (!state || event.pointerId !== state.pointerId) return;
    event.preventDefault();

    const scaleX = state.canvas.width / state.shellRect.width;
    const scaleY = state.canvas.height / state.shellRect.height;
    const dx = (event.clientX - state.startX) * scaleX;
    const dy = (event.clientY - state.startY) * scaleY;
    const area = { ...state.startArea };

    if (state.mode === "resize") {
      area.w = Math.max(8, state.startArea.w + dx);
      area.h = Math.max(8, state.startArea.h + dy);
    } else {
      area.x = state.startArea.x + dx;
      area.y = state.startArea.y + dy;
    }

    area.x = Math.max(0, Math.min(state.canvas.width - area.w, area.x));
    area.y = Math.max(0, Math.min(state.canvas.height - area.h, area.y));
    area.w = Math.min(state.canvas.width - area.x, area.w);
    area.h = Math.min(state.canvas.height - area.y, area.h);
    state.zone.style.cssText = `${areaStyle(area, state.canvas)} ${state.zone.dataset.baseStyle ?? ""}`;
  };

  #onEnd = async (event) => {
    const state = this.#state;
    if (!state || event.pointerId !== state.pointerId) return;

    if (this.#moveHandler) document.removeEventListener("pointermove", this.#moveHandler);
    if (this.#endHandler) {
      document.removeEventListener("pointerup", this.#endHandler);
      document.removeEventListener("pointercancel", this.#endHandler);
    }
    try { state.zone?.releasePointerCapture?.(state.pointerId); } catch (_error) {}
    this.#moveHandler = null;
    this.#endHandler = null;
    state.zone.classList.remove("is-editing");

    const shell = this.#getElement?.()?.querySelector?.(".cd-player-shell");
    if (shell && state.id) {
      const shellRect = shell.getBoundingClientRect();
      const zoneRect = state.zone.getBoundingClientRect();
      const area = roundedArea({
        x: ((zoneRect.left - shellRect.left) / shellRect.width) * state.canvas.width,
        y: ((zoneRect.top - shellRect.top) / shellRect.height) * state.canvas.height,
        w: (zoneRect.width / shellRect.width) * state.canvas.width,
        h: (zoneRect.height / shellRect.height) * state.canvas.height
      });
      await this.#saveArea?.(state.id, area);
    }

    this.#state = null;
  };
}
