import { MODULE_PATH, SETTINGS } from "../../core/constants.mjs";
import { logger } from "../../core/logger.mjs";
import { getSetting } from "../../core/settings.mjs";
import { resolveFoundryAssetPath } from "../../core/utils.mjs";

export const PLAYER_BODY_SRC = resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/player-body.webp`);
export const CASSETTE_SRC = resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/cassette.webp`);
export const CASSETTE_WHEEL_SRC = resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/wheel.webp`);
export const PLAYER_LID_CLOSED_SRC = resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/player-lid.webp`);
export const PLAYER_LID_OPEN_SRC = resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/player-lid-open.webp`);
const PLAYER_LAYOUT_PATH = resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/layout.json`);
export const BUTTON_ASSETS = Object.freeze({
  play: {
    normal: resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/buttons/button-play.webp`),
    pressed: resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/buttons/button-play-pressed.webp`)
  },
  rewind: {
    normal: resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/buttons/button-rewind.webp`),
    pressed: resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/buttons/button-rewind-pressed.webp`)
  },
  forward: {
    normal: resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/buttons/button-forward.webp`),
    pressed: resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/buttons/button-forward-pressed.webp`)
  },
  previous: {
    normal: resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/buttons/button-prev.webp`),
    pressed: resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/buttons/button-prev-pressed.webp`)
  },
  next: {
    normal: resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/buttons/button-next.webp`),
    pressed: resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/buttons/button-next-pressed.webp`)
  },
  stop: {
    normal: resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/buttons/button-stop.webp`),
    pressed: resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/buttons/button-stop-pressed.webp`)
  },
  pause: {
    normal: resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/buttons/button-pause.webp`),
    pressed: resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/buttons/button-pause-pressed.webp`)
  },
  open: {
    normal: resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/buttons/button-open.webp`),
    pressed: resolveFoundryAssetPath(`${MODULE_PATH}/assets/ui/player-v2/buttons/button-open-pressed.webp`)
  }
});

const FALLBACK_LAYOUT = {
  canvas: { width: 1434, height: 887 },
  areas: {
    cassetteBay: { x: 126, y: 194, w: 767, h: 445 },
    cassetteLayer: { x: 210, y: 288, w: 600, h: 333 },
    cassetteTitle: { x: 246, y: 310, w: 528, h: 76 },
    lidClosed: { x: 126, y: 184, w: 768, h: 459 },
    lidOpen: { x: 84, y: -74, w: 860, h: 571 },
    screen: { x: 1066, y: 112, w: 255, h: 60 },
    volumeTrack: { x: 1005, y: 294, w: 36, h: 336 },
    buttonPlay: { x: 1213, y: 271, w: 111, h: 62 },
    buttonRewind: { x: 1210, y: 368, w: 115, h: 65 },
    buttonForward: { x: 1213, y: 467, w: 113, h: 65 },
    buttonPrevious: { x: 1213, y: 569, w: 109, h: 59 },
    buttonNext: { x: 1210, y: 663, w: 117, h: 63 },
    buttonStop: { x: 223, y: 760, w: 118, h: 70 },
    buttonPause: { x: 426, y: 762, w: 119, h: 69 },
    buttonOpen: { x: 647, y: 761, w: 117, h: 73 }
  }
};
let cachedPlayerLayout = null;

export async function loadPlayerLayout() {
  if (cachedPlayerLayout) return cachedPlayerLayout;
  try {
    const response = await fetch(PLAYER_LAYOUT_PATH);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    cachedPlayerLayout = await response.json();
  } catch (error) {
    logger.warn(`Cassette Deck | player layout fetch failed, using fallback. ${error?.message ?? error}`);
    cachedPlayerLayout = foundry.utils.deepClone(FALLBACK_LAYOUT);
  }
  return cachedPlayerLayout;
}


export function getLayoutOverride() {
  try {
    const value = getSetting(SETTINGS.playerLayoutOverride);
    return value && typeof value === "object" ? value : {};
  } catch (_error) {
    return {};
  }
}

export function effectiveLayout(baseLayout) {
  const base = baseLayout ?? FALLBACK_LAYOUT;
  const override = getLayoutOverride();
  const canvas = base.canvas ?? FALLBACK_LAYOUT.canvas;
  const areas = foundry.utils.mergeObject(
    foundry.utils.deepClone(base.areas ?? FALLBACK_LAYOUT.areas),
    override.areas ?? {},
    { inplace: false }
  );
  return { canvas, areas };
}

export function roundedArea(area) {
  return {
    x: Math.round(Number(area.x) || 0),
    y: Math.round(Number(area.y) || 0),
    w: Math.round(Number(area.w) || 1),
    h: Math.round(Number(area.h) || 1)
  };
}

export function areaStyle(area, canvas) {
  if (!area || !canvas?.width || !canvas?.height) return "";
  const left = (area.x / canvas.width) * 100;
  const top = (area.y / canvas.height) * 100;
  const width = (area.w / canvas.width) * 100;
  const height = (area.h / canvas.height) * 100;
  return `left:${left.toFixed(3)}%;top:${top.toFixed(3)}%;width:${width.toFixed(3)}%;height:${height.toFixed(3)}%;`;
}
