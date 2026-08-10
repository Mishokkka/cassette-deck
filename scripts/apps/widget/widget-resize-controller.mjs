export function resolveWidgetSizeCandidate({ saved = null, volatile = null } = {}) {
  const savedWidth = Number(saved?.width);
  if (Number.isFinite(savedWidth) && savedWidth > 0) return { width: savedWidth, source: "saved" };

  const volatileWidth = Number(volatile?.width);
  if (Number.isFinite(volatileWidth) && volatileWidth > 0) return { width: volatileWidth, source: "volatile" };

  return null;
}

export class WidgetResizeController {
  #getElement;
  #isRendered;
  #getSavedSize;
  #saveSize;
  #setAppSize;
   #setAppPosition;
  #savePosition;
  #volatileSize = null;
  #resizeState = null;
  #moveHandler = null;
  #endHandler = null;
  #moveRaf = null;
  #pendingWidth = null;

  constructor({ getElement, isRendered, getSavedSize, saveSize, setAppSize, setAppPosition, savePosition } = {}) {
    this.#getElement = getElement;
    this.#isRendered = isRendered;
    this.#getSavedSize = getSavedSize;
    this.#saveSize = saveSize;
    this.#setAppSize = setAppSize;
    this.#setAppPosition = setAppPosition;
    this.#savePosition = savePosition;
  }

  rememberCurrentSize() {
    const element = this.#getElement?.();
    if (!this.#isRendered?.() || !element) return;
    const rect = element.getBoundingClientRect?.();
    if (!rect || rect.width <= 0) return;
    this.#volatileSize = { width: Math.round(rect.width) };
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
    if (this.#endHandler) document.removeEventListener('pointerup', this.#endHandler);
    this.#moveHandler = null;
    this.#endHandler = null;
    if (this.#moveRaf !== null && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(this.#moveRaf);
    this.#moveRaf = null;
    this.#pendingWidth = null;
    this.#resizeState = null;
  }

  applySavedSize() {
    const size = resolveWidgetSizeCandidate({
      saved: this.#getSavedSize?.(),
      volatile: this.#volatileSize
    });
    if (!size) return;
    const width = this.#clampWidth(size.width);
    this.#volatileSize = { width };
    this.#setSize(width);
  }

  #onResizeStart = (event) => {
    if (event.button !== 0) return;
    const app = this.#getElement?.();
    if (!app) return;
    const rect = app.getBoundingClientRect();
    this.#resizeState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: rect.width,
      startLeft: rect.left,
      startTop: rect.top,
      startHeight: rect.height
    };
    app.classList.add('is-resizing');
    this.#moveHandler = this.#onResizeMove;
    this.#endHandler = this.#onResizeEnd;
    document.addEventListener('pointermove', this.#moveHandler, { passive: false });
    document.addEventListener('pointerup', this.#endHandler, { once: true });
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
    this.#moveHandler = null;
    this.#endHandler = null;
    const element = this.#getElement?.();
    element?.classList?.remove('is-resizing');
    if (this.#moveRaf !== null && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(this.#moveRaf);
    this.#moveRaf = null;
    if (Number.isFinite(Number(this.#pendingWidth))) this.#setSize(this.#pendingWidth, { syncApp: false });
    this.#pendingWidth = null;
    const rect = element?.getBoundingClientRect?.();
    this.#resizeState = null;
    if (!rect) return;

    const width = this.#clampWidth(rect.width);
    this.#volatileSize = { width };
    this.#setSize(width, { syncApp: true });
    await this.#saveSize?.({ width });

    const position = this.#clampPositionAfterResize(rect.left, rect.top, width, rect.height);
    this.#setPosition(position.left, position.top);
    await this.#savePosition?.({ left: position.left, top: position.top });
  };

  #scheduleResize() {
    if (this.#moveRaf !== null) return;
    const run = () => {
      this.#moveRaf = null;
      const width = this.#pendingWidth;
      this.#pendingWidth = null;
      if (Number.isFinite(Number(width))) this.#setSize(width, { syncApp: false });
    };
    if (typeof window.requestAnimationFrame === "function") this.#moveRaf = window.requestAnimationFrame(run);
    else run();
  }

  #setSize(width, { syncApp = true } = {}) {
    const roundedWidth = Math.round(width);
    const element = this.#getElement?.();
    if (element) {
      element.style.width = `${roundedWidth}px`;
      element.style.maxWidth = 'calc(100vw - 16px)';
    }
    if (syncApp) this.#setAppSize?.({ width: roundedWidth });
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
