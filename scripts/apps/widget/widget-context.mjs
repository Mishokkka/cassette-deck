import { MODULE_TITLE, SETTINGS } from "../../core/constants.mjs";
import { canUseControl } from "../../core/permissions.mjs";
import { normalizeCassetteLabel } from "../../models/cassette.mjs";
import { getSetting, getWidgetState } from "../../core/settings.mjs";
import { clampOffset, estimateOffset } from "../../models/deck-state.mjs";
import { getCassetteById, getCassetteSummaries } from "../../services/library-service.mjs";
import {
  BUTTON_ASSETS,
  CASSETTE_SRC,
  CASSETTE_WHEEL_SRC,
  PLAYER_BODY_SRC,
  PLAYER_LID_CLOSED_SRC,
  PLAYER_LID_OPEN_SRC,
  areaStyle,
  effectiveLayout,
  loadPlayerLayout
} from "./widget-layout.mjs";
import { formatTime, statusLabel, timeSlots } from "./widget-state.mjs";

const WIDGET_SKINS = new Set(["field", "amber", "green", "steel"]);

const CASSETTE_ART_SIZE = Object.freeze({ width: 608, height: 337 });
const CASSETTE_WHEEL_SIZE = Object.freeze({ width: 80, height: 80 });
const CASSETTE_WHEEL_POSITIONS = Object.freeze({
  left: { x: 138, y: 116 },
  right: { x: 387, y: 117 }
});
const DEFAULT_REEL_SPIN = Object.freeze({ active: false, fast: false, durationMs: 1600, direction: "forward" });

const OVERLAY_TOOL_DEFS = Object.freeze([
  { action: "open-settings", icon: "fa-solid fa-gear", title: "Настройки модуля" },
  { action: "open-permissions", icon: "fa-solid fa-user-lock", title: "Доступ игроков" },
  { action: "open-diagnostics", icon: "fa-solid fa-stethoscope", title: "Диагностика" },
  { action: "request-sync", icon: "fa-solid fa-arrows-rotate", title: "Синхронизировать" },
  { action: "toggle-debug-overlay", icon: "fa-solid fa-vector-square", title: "Показать / скрыть debug overlay" },
  { action: "toggle-calibration-mode", icon: "fa-solid fa-ruler-combined", title: "Ручная настройка зон" }
]);

export function widgetSkinClass(settingValue = "field") {
  const skin = String(settingValue || "field");
  return WIDGET_SKINS.has(skin) ? `cd-widget--skin-${skin}` : "cd-widget--skin-field";
}

export function buildWidgetControls(user = game.user) {
  return {
    play: canUseControl("play", user),
    pause: canUseControl("pause", user),
    stop: canUseControl("stop", user),
    seek: canUseControl("seek", user),
    next: canUseControl("next", user),
    previous: canUseControl("previous", user),
    eject: canUseControl("eject", user),
    volume: canUseControl("volume", user)
  };
}

export function buttonAsset(id, pressed = false) {
  const entry = BUTTON_ASSETS[id];
  if (!entry) return null;
  return pressed ? entry.pressed : entry.normal;
}

export function cassetteLabelText(cassette = null) {
  return cassette?.title || "Кассета не выбрана";
}

export function cassetteLabelFontStyle(cassette = null) {
  const label = normalizeCassetteLabel(cassette?.label ?? {});
  const font = String(label.font || "").trim();
  if (!font) return "";
  const safe = font.replace(/[;{}]/g, "").replace(/"/g, '\\"');
  return `--cd-cassette-label-font:"${safe}";`;
}

function cassetteRelativeStyle(area = {}, size = CASSETTE_ART_SIZE) {
  if (!area || !size?.width || !size?.height) return "";
  const left = (Number(area.x || 0) / size.width) * 100;
  const top = (Number(area.y || 0) / size.height) * 100;
  const width = (Number(area.w || 0) / size.width) * 100;
  const height = (Number(area.h || 0) / size.height) * 100;
  return `left:${left.toFixed(3)}%;top:${top.toFixed(3)}%;width:${width.toFixed(3)}%;height:${height.toFixed(3)}%;`;
}

function buildWheelStyle(position = { x: 0, y: 0 }, wheel = CASSETTE_WHEEL_SIZE) {
  return cassetteRelativeStyle({ x: position.x, y: position.y, w: wheel.width, h: wheel.height }, CASSETTE_ART_SIZE);
}

function resolveReelSpin(runtime = null, deckState = {}) {
  const command = runtime?.command ?? null;
  const action = String(command?.action || "");
  const clickAction = String(command?.clickAction || "");
  const issuedAt = Number(command?.issuedAt ?? 0) || 0;
  const delayMs = Math.max(0, Number(command?.transportDelayMs ?? 0) || 0);
  const recentShuttle = Boolean(delayMs && issuedAt && (Date.now() - issuedAt) <= (delayMs + 80) && ["seek", "cue"].includes(action) && ["seekForward", "seekBackward", "next", "previous"].includes(clickAction));

  if (recentShuttle) {
    return {
      active: true,
      fast: true,
      durationMs: 260,
      direction: (clickAction === "seekBackward" || clickAction === "previous") ? "backward" : "forward"
    };
  }

  if (deckState?.status === "playing" && !deckState?.lidOpen) {
    return {
      active: true,
      fast: false,
      durationMs: 1650,
      direction: "forward"
    };
  }

  return DEFAULT_REEL_SPIN;
}

export function buildOverlayTools({ isGM = false, calibrationMode = false, debugOverlay = false } = {}) {
  if (!isGM) return [];
  const buttons = OVERLAY_TOOL_DEFS.map((entry) => ({
    ...entry,
    active: entry.action === "toggle-debug-overlay" ? debugOverlay : (entry.action === "toggle-calibration-mode" ? calibrationMode : false)
  }));

  if (calibrationMode) {
    buttons.push(
      { action: "reset-layout-override", icon: "fa-solid fa-rotate-left", title: "Сбросить ручную настройку зон", active: false },
      { action: "export-layout-override", icon: "fa-solid fa-code", title: "Вывести layout override в консоль", active: false }
    );
  }

  return buttons;
}

export function buildTransportButtons({ controls, deckState, canBrowseUnlocked, areas, canvas, isMomentaryPressed }) {
  const pressed = (id) => Boolean(isMomentaryPressed?.(id));
  const noAccessTitle = "Нет доступа к этой кнопке";
  const entries = [
    { id: "play", label: "PLAY", title: "Воспроизведение", action: "transport-play", allowed: controls.play, pressed: deckState.status === "playing" || pressed("play"), area: areas.buttonPlay },
    { id: "rewind", label: "REW", title: "Перемотка назад", action: "transport-seek-backward", allowed: controls.seek, pressed: pressed("rewind"), area: areas.buttonRewind },
    { id: "forward", label: "FWD", title: "Перемотка вперёд", action: "transport-seek-forward", allowed: controls.seek, pressed: pressed("forward"), area: areas.buttonForward },
    { id: "previous", label: "PREV", title: "Предыдущий трек", action: "transport-previous", allowed: controls.previous, pressed: pressed("previous"), area: areas.buttonPrevious },
    { id: "next", label: "NEXT", title: "Следующий трек", action: "transport-next", allowed: controls.next, pressed: pressed("next"), area: areas.buttonNext },
    { id: "stop", label: "STOP", title: "Стоп", action: "transport-stop", allowed: controls.stop, pressed: deckState.status === "stopped" || pressed("stop"), area: areas.buttonStop },
    { id: "pause", label: "PAUSE", title: "Пауза", action: "transport-pause", allowed: controls.pause, pressed: deckState.status === "paused" || pressed("pause"), area: areas.buttonPause },
    { id: "open", label: "OPEN", title: "Открыть крышку и показать библиотеку кассет", action: "open-lid", allowed: canBrowseUnlocked, pressed: Boolean(deckState.lidOpen || pressed("open")), area: areas.buttonOpen }
  ];

  return entries
    .map((entry) => ({
      ...entry,
      disabled: !entry.allowed,
      title: entry.allowed ? entry.title : `${entry.title} · ${noAccessTitle}`,
      style: areaStyle(entry.area, canvas),
      asset: buttonAsset(entry.id, entry.pressed),
      normalAsset: buttonAsset(entry.id, false),
      pressedAsset: buttonAsset(entry.id, true)
    }));
}

export function buildCalibrationZones(areas, canvas) {
  const entries = [
    ["cassetteBay", "BAY"],
    ["cassetteLayer", "CASSETTE IMG"],
    ["cassetteTitle", "CASSETTE TITLE"],
    ["lidClosed", "LID CLOSED"],
    ["lidOpen", "LID OPEN"],
    ["screen", "SCREEN"],
    ["volumeTrack", "VOLUME"],
    ["buttonPlay", "PLAY"],
    ["buttonRewind", "REW"],
    ["buttonForward", "FWD"],
    ["buttonPrevious", "PREV"],
    ["buttonNext", "NEXT"],
    ["buttonStop", "STOP"],
    ["buttonPause", "PAUSE"],
    ["buttonOpen", "OPEN"]
  ];

  return entries
    .filter(([id]) => Boolean(areas[id]))
    .map(([id, label]) => ({ id, label, style: areaStyle(areas[id], canvas) }));
}

export async function buildWidgetContext({
  baseContext = {},
  deckState,
  runtime,
  resolveDuration,
  getVolumePercent,
  isMomentaryPressed,
  preloadSummary
} = {}) {
  const widgetState = getWidgetState();
  const libraryOpen = Boolean(widgetState.browserOpen);
  const selectedCassette = deckState.cassetteId ? getCassetteById(deckState.cassetteId) : null;
  const selectedTrack = selectedCassette?.tracks?.find((track) => track.id === deckState.trackId) ?? null;
  const canBrowseUnlocked = game.user.isGM || canUseControl("browseUnlocked");
  const canSelectCassette = game.user.isGM || canUseControl("selectCassette");
  const controls = buildWidgetControls(game.user);
  const duration = resolveDuration?.(selectedTrack, runtime) ?? null;
  const reelSpin = resolveReelSpin(runtime, deckState);
  const currentOffset = clampOffset(estimateOffset(deckState), duration);
  const currentTimeLabel = formatTime(currentOffset);
  const durationLabel = formatTime(duration);
  const layout = effectiveLayout(await loadPlayerLayout());
  const { canvas, areas } = layout;
  const debugOverlay = game.user.isGM && Boolean(widgetState.debugOverlay);
  const calibrationMode = game.user.isGM && Boolean(widgetState.calibrationMode);
  const volumePercent = getVolumePercent?.(deckState) ?? 0;
  const visibleCassettes = libraryOpen && canBrowseUnlocked
    ? getCassetteSummaries({ visibleTo: game.user })
    : [];

  return {
    context: {
      ...baseContext,
      moduleTitle: MODULE_TITLE,
      headerTitle: "МСЭ · Музыка-24",
      isGM: game.user.isGM,
      libraryOpen,
      debugOverlay,
      calibrationMode,
      skinClass: widgetSkinClass(getSetting(SETTINGS.widgetSkin)),
      canSelectCassette,
      canBrowseUnlocked,
      canEjectCassette: Boolean(selectedCassette && controls.eject),
      showLibraryShelf: canBrowseUnlocked && libraryOpen,
      showLibraryButton: canBrowseUnlocked,
      playerBodySrc: PLAYER_BODY_SRC,
      cassetteSrc: CASSETTE_SRC,
      cassetteWheelSrc: CASSETTE_WHEEL_SRC,
      lidClosedSrc: PLAYER_LID_CLOSED_SRC,
      lidOpenSrc: PLAYER_LID_OPEN_SRC,
      lidOpen: Boolean(deckState.lidOpen),
      hasCassetteLayer: Boolean(selectedCassette),
      cassetteLayerStyle: areaStyle(areas.cassetteLayer, canvas),
      cassetteWheelLeftStyle: buildWheelStyle(CASSETTE_WHEEL_POSITIONS.left),
      cassetteWheelRightStyle: buildWheelStyle(CASSETTE_WHEEL_POSITIONS.right),
      cassetteWheelClass: reelSpin.active ? `is-spinning ${reelSpin.fast ? "is-fast" : ""} ${reelSpin.direction === "backward" ? "is-backward" : "is-forward"}`.trim() : "",
      cassetteWheelDurationMs: reelSpin.durationMs,
      cassetteTitleStyle: `${areaStyle(areas.cassetteTitle, canvas)}${cassetteLabelFontStyle(selectedCassette)}`,
      cassetteLabelText: cassetteLabelText(selectedCassette),
      lidClosedStyle: areaStyle(areas.lidClosed, canvas),
      lidOpenStyle: areaStyle(areas.lidOpen, canvas),
      playerAspect: `${canvas.width} / ${canvas.height}`,
      screenStyle: areaStyle(areas.screen, canvas),
      cassetteBayStyle: areaStyle(areas.cassetteBay, canvas),
      volumeTrackStyle: areaStyle(areas.volumeTrack, canvas),
      transportButtons: buildTransportButtons({ controls, deckState, canBrowseUnlocked, areas, canvas, isMomentaryPressed }),
      calibrationZones: buildCalibrationZones(areas, canvas),
      overlayTools: buildOverlayTools({ isGM: game.user.isGM, calibrationMode, debugOverlay }),
      status: deckState.status,
      cassetteTitle: selectedCassette?.title ?? "Кассета не выбрана",
      trackTitle: selectedTrack?.title ?? "Нет активного трека",
      currentTimeLabel,
      durationLabel,
      currentTimeSlots: timeSlots(currentTimeLabel),
      durationTimeSlots: timeSlots(durationLabel),
      volumePercent,
      volumeThumbTop: 100 - volumePercent,
      visibleCassettes: visibleCassettes.map((cassette) => ({
        ...cassette,
        selected: cassette.id === selectedCassette?.id
      })),
      hasVisibleCassettes: visibleCassettes.length > 0,
      controls,
      statusLabel: statusLabel(deckState.status),
      showScreen: true,
      showCassetteBayDebug: debugOverlay,
      showVolume: true,
      volumeCanAdjust: controls.volume,
      preloadSummary: preloadSummary?.() ?? ""
    },
    canvas,
    layout,
    selectedCassette,
    selectedTrack
  };
}
