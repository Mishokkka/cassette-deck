export function resolveWidgetPositionCandidate({ saved = null, volatile = null } = {}) {
  const savedLeft = Number(saved?.left);
  const savedTop = Number(saved?.top);
  if (Number.isFinite(savedLeft) && Number.isFinite(savedTop)) return { left: savedLeft, top: savedTop, source: "saved" };

  const volatileLeft = Number(volatile?.left);
  const volatileTop = Number(volatile?.top);
  if (Number.isFinite(volatileLeft) && Number.isFinite(volatileTop)) return { left: volatileLeft, top: volatileTop, source: "volatile" };

  return null;
}

export class WidgetDragController {
  #getElement;
  #isRendered;
  #getSavedPosition;
  #savePosition;
  #setAppPosition;
  #dragState = null;
  #dragMoveHandler = null;
  #dragEndHandler = null;
  #volatilePosition = null;
  #moveRaf = null;
  #pendingPoint = null;

  constructor({ getElement, isRendered, getSavedPosition, savePosition, setAppPosition } = {}) {
    this.#getElement = getElement;
    this.#isRendered = isRendered;
    this.#getSavedPosition = getSavedPosition;
    this.#savePosition = savePosition;
    this.#setAppPosition = setAppPosition;
  }

  rememberCurrentPosition() {
    const element = this.#getElement?.();
    if (!this.#isRendered?.() || !element) return;
    const rect = element.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    this.#volatilePosition = { left: Math.round(rect.left), top: Math.round(rect.top) };
  }

  attach() {
    const handle = this.#getElement?.()?.querySelector?.("[data-cd-drag-handle]");
    if (!handle) return;
    handle.addEventListener("pointerdown", this.#onDragStart);
  }

  detach() {
    const handle = this.#getElement?.()?.querySelector?.("[data-cd-drag-handle]");
    handle?.removeEventListener?.("pointerdown", this.#onDragStart);
    if (this.#dragMoveHandler) document.removeEventListener("pointermove", this.#dragMoveHandler);
    if (this.#dragEndHandler) {
      document.removeEventListener("pointerup", this.#dragEndHandler);
      document.removeEventListener("pointercancel", this.#dragEndHandler);
    }
    try { this.#dragState?.captureTarget?.releasePointerCapture?.(this.#dragState.pointerId); } catch (_error) {}
    this.#dragMoveHandler = null;
    this.#dragEndHandler = null;
    if (this.#moveRaf !== null && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(this.#moveRaf);
    this.#moveRaf = null;
    this.#pendingPoint = null;
    this.#dragState = null;
  }

  applySavedPosition() {
    const position = resolveWidgetPositionCandidate({
      saved: this.#getSavedPosition?.(),
      volatile: this.#volatilePosition
    });
    if (!position) return;
    const element = this.#getElement?.();
    const rect = element?.getBoundingClientRect?.();
    const width = rect?.width || 860;
    const height = rect?.height || 420;
    const point = this.#clampPosition(Number(position.left), Number(position.top), width, height);
    this.#volatilePosition = { left: Math.round(point.left), top: Math.round(point.top) };
    this.#setPosition(point.left, point.top);
  }

  #onDragStart = (event) => {
    if (event.button !== 0) return;
    if (event.target?.closest?.("button, a, input, select, textarea, [data-no-drag]")) return;
    const app = this.#getElement?.();
    if (!app) return;
    const rect = app.getBoundingClientRect();
    this.#dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      captureTarget: event.currentTarget
    };
    app.classList.add("is-dragging");
    app.style.right = "auto";
    app.style.bottom = "auto";
    app.style.left = `${Math.round(rect.left)}px`;
    app.style.top = `${Math.round(rect.top)}px`;
    try { event.currentTarget?.setPointerCapture?.(event.pointerId); } catch (_error) {}
    this.#dragMoveHandler = this.#onDragMove;
    this.#dragEndHandler = this.#onDragEnd;
    document.addEventListener("pointermove", this.#dragMoveHandler, { passive: false });
    document.addEventListener("pointerup", this.#dragEndHandler);
    document.addEventListener("pointercancel", this.#dragEndHandler);
    event.preventDefault();
  };

  #onDragMove = (event) => {
    if (!this.#dragState || event.pointerId !== this.#dragState.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - this.#dragState.startX;
    const dy = event.clientY - this.#dragState.startY;
    const point = this.#clampPosition(this.#dragState.left + dx, this.#dragState.top + dy, this.#dragState.width, this.#dragState.height);
    this.#volatilePosition = { left: Math.round(point.left), top: Math.round(point.top) };
    this.#pendingPoint = point;
    this.#scheduleMove();
  };

  #onDragEnd = async (event) => {
    if (!this.#dragState || event.pointerId !== this.#dragState.pointerId) return;
    if (this.#dragMoveHandler) document.removeEventListener("pointermove", this.#dragMoveHandler);
    if (this.#dragEndHandler) {
      document.removeEventListener("pointerup", this.#dragEndHandler);
      document.removeEventListener("pointercancel", this.#dragEndHandler);
    }
    try { this.#dragState.captureTarget?.releasePointerCapture?.(this.#dragState.pointerId); } catch (_error) {}
    this.#dragMoveHandler = null;
    this.#dragEndHandler = null;
    const element = this.#getElement?.();
    element?.classList?.remove("is-dragging");
    if (this.#moveRaf !== null && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(this.#moveRaf);
    this.#moveRaf = null;
    if (this.#pendingPoint) this.#setPosition(this.#pendingPoint.left, this.#pendingPoint.top, { syncApp: false });
    this.#pendingPoint = null;
    const rect = element?.getBoundingClientRect?.();
    this.#dragState = null;
    if (!rect) return;
    const point = this.#clampPosition(rect.left, rect.top, rect.width, rect.height);
    this.#volatilePosition = { left: Math.round(point.left), top: Math.round(point.top) };
    this.#setPosition(point.left, point.top, { syncApp: true });
    await this.#savePosition?.({ left: Math.round(point.left), top: Math.round(point.top) });
  };

  #scheduleMove() {
    if (this.#moveRaf !== null) return;
    const run = () => {
      this.#moveRaf = null;
      const point = this.#pendingPoint;
      this.#pendingPoint = null;
      if (point) this.#setPosition(point.left, point.top, { syncApp: false });
    };
    if (typeof window.requestAnimationFrame === "function") this.#moveRaf = window.requestAnimationFrame(run);
    else run();
  }

  #setPosition(left, top, { syncApp = true } = {}) {
    const roundedLeft = Math.round(left);
    const roundedTop = Math.round(top);
    const element = this.#getElement?.();
    if (element) {
      element.style.left = `${roundedLeft}px`;
      element.style.top = `${roundedTop}px`;
      element.style.right = "auto";
      element.style.bottom = "auto";
    }
    if (syncApp) this.#setAppPosition?.({ left: roundedLeft, top: roundedTop });
  }

  #clampPosition(left, top, width, height) {
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    return {
      left: Math.min(maxLeft, Math.max(margin, Number(left) || margin)),
      top: Math.min(maxTop, Math.max(margin, Number(top) || margin))
    };
  }
}
