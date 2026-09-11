export function resolveWidgetSizeCandidate({ saved = null, volatile = null } = {}) {
  const volatileWidth = Number(volatile?.width);
  if (Number.isFinite(volatileWidth) && volatileWidth > 0) return { width: volatileWidth, source: "volatile" };

  const savedWidth = Number(saved?.width);
  if (Number.isFinite(savedWidth) && savedWidth > 0) return { width: savedWidth, source: "saved" };

  return null;
}

export class WidgetResizeController {
  #getElement;
  #isRendered;
  #getSavedSize;
  #saveSize;
  #setAppPosition;
  #savePosition;
  #volatileSize = null;
  #resizeState = null;
  #moveHandler = null;
  #endHandler = null;
  #moveRaf = null;
  #pendingWidth = null;

  constructor({ getElement, isRendered, getSavedSize, saveSize, setAppPosition, savePosition } = {}) {
    this.#getElement = getElement;
    this.#isRendered = isRendered;
    this.#getSavedSize = getSavedSize;
    this.#saveSize = saveSize;
    this.#setAppPosition = setAppPosition;
    this.#savePosition = savePosition;
  }

  getPreferredSize() {
    const size = resolveWidgetSizeCandidate({
      saved: this.#getSavedSize?.(),
      volatile: this.#volatileSize
    });
    if (!size) return null;
    return { width: Math.round(size.width), source: size.source };
  }

  getEffectiveSize() {
    const size = this.getPreferredSize();
    if (!size) return null;
    return { width: this.#clampWidth(size.width), source: size.source };
  }

  attach() {
    const handle = this.#getElement?.()?.querySelector?.('[data-cd-resize-handle]');
    if (!handle) return;
    handle.addEventListener('pointerdown', this.#onResizeStart);
  }

  detach() {
    const handle = this.#getElement?.()?.querySelector?.('[data-cd-resize-handle]');
    handle?.removeEventListener?.('pointerdown', this.#onResizeStart);
    if (this.#moveHandler) document.removeEventListener('pointermove', this.#moveHandler);
    if (this.#endHandler) {
      document.removeEventListener('pointerup', this.#endHandler);
      document.removeEventListener('pointercancel', this.#endHandler);
    }
    try { this.#resizeState?.captureTarget?.releasePointerCapture?.(this.#resizeState.pointerId); } catch (_error) {}
    this.#moveHandler = null;
    this.#endHandler = null;
    if (this.#moveRaf !== null && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(this.#moveRaf);
    this.#moveRaf = null;
    this.#pendingWidth = null;
    this.#resizeState = null;
  }

  applySavedSize() {
    const size = this.getEffectiveSize();
    if (!size) return;
    this.#applyWidth(size.width);
  }

  #onResizeStart = (event) => {
    if (event.button !== 0) return;
    const app = this.#getElement?.();
    if (!app) return;
    const rect = app.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;

    const startWidth = this.#clampWidth(rect.width);
    this.#resizeState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      startLeft: rect.left,
      startTop: rect.top,
      startHeight: rect.height,
      captureTarget: event.currentTarget
    };
    this.#volatileSize = { width: startWidth };
    this.#pendingWidth = startWidth;
    app.classList.add('is-resizing');
    try { event.currentTarget?.setPointerCapture?.(event.pointerId); } catch (_error) {}
    this.#moveHandler = this.#onResizeMove;
    this.#endHandler = this.#onResizeEnd;
    document.addEventListener('pointermove', this.#moveHandler, { passive: false });
    document.addEventListener('pointerup', this.#endHandler);
    document.addEventListener('pointercancel', this.#endHandler);
    event.preventDefault();
    event.stopPropagation();
  };

  #onResizeMove = (event) => {
    const state = this.#resizeState;
    if (!state || event.pointerId !== state.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - state.startX;
    const width = this.#clampWidth(state.startWidth + dx);
    this.#volatileSize = { width };
    this.#pendingWidth = width;
    this.#scheduleResize();
  };

  #onResizeEnd = async (event) => {
    const state = this.#resizeState;
    if (!state || event.pointerId !== state.pointerId) return;

    if (this.#moveHandler) document.removeEventListener('pointermove', this.#moveHandler);
    if (this.#endHandler) {
      document.removeEventListener('pointerup', this.#endHandler);
      document.removeEventListener('pointercancel', this.#endHandler);
    }
    try { state.captureTarget?.releasePointerCapture?.(state.pointerId); } catch (_error) {}
    this.#moveHandler = null;
    this.#endHandler = null;

    const element = this.#getElement?.();
    element?.classList?.remove('is-resizing');
    if (this.#moveRaf !== null && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(this.#moveRaf);
    this.#moveRaf = null;

    // Do not read the final width back from the DOM here. A render or AppV2
    // positioning pass can happen between the last pointermove and pointerup.
    // The last explicit pointer-derived width is the user's actual choice.
    const requestedWidth = Number(this.#pendingWidth ?? this.#volatileSize?.width ?? state.startWidth);
    const width = this.#clampWidth(requestedWidth);
    this.#pendingWidth = null;
    this.#resizeState = null;
    this.#volatileSize = { width };
    this.#applyWidth(width);
    await this.#saveSize?.({ width });

    const rect = element?.getBoundingClientRect?.();
    if (!rect) return;
    const position = this.#clampPositionAfterResize(rect.left, rect.top, width, rect.height);
    this.#setPosition(position.left, position.top);
    await this.#savePosition?.({ left: position.left, top: position.top });
  };

  #scheduleResize() {
    if (this.#moveRaf !== null) return;
    const run = () => {
      this.#moveRaf = null;
      const width = this.#pendingWidth;
      if (Number.isFinite(Number(width))) this.#applyWidth(width);
    };
    if (typeof window.requestAnimationFrame === "function") this.#moveRaf = window.requestAnimationFrame(run);
    else run();
  }

  #applyWidth(width) {
    const roundedWidth = Math.round(width);
    const element = this.#getElement?.();
    if (!element?.style) return;

    // Width is deliberately CSS-owned. ApplicationV2 remains width:auto and
    // therefore cannot restore an old numeric width on a later re-render.
    element.style.setProperty?.('--cd-widget-width', `${roundedWidth}px`);
    element.style.width = `${roundedWidth}px`;
    element.style.maxWidth = 'calc(100vw - 16px)';
  }

  #setPosition(left, top) {
    const position = { left: Math.round(left), top: Math.round(top) };
    const element = this.#getElement?.();
    if (element) {
      element.style.left = `${position.left}px`;
      element.style.top = `${position.top}px`;
      element.style.right = 'auto';
      element.style.bottom = 'auto';
    }
    this.#setAppPosition?.(position);
  }

  #clampWidth(width) {
    const min = 320;
    const max = Math.max(min, Math.min(1100, window.innerWidth - 16));
    return Math.min(max, Math.max(min, Math.round(Number(width) || min)));
  }

  #clampPositionAfterResize(left, top, width, height) {
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    return {
      left: Math.min(maxLeft, Math.max(margin, Math.round(Number(left) || margin))),
      top: Math.min(maxTop, Math.max(margin, Math.round(Number(top) || margin)))
    };
  }
}
