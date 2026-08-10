import { DEFAULT_TRANSPORT_SFX, MODULE_ID, SETTINGS } from "../core/constants.mjs";
import { logger } from "../core/logger.mjs";
import { clampNumber, resolveFoundryAudioPath, resolveMaybeNumber } from "../core/utils.mjs";
import { EFFECT_PRESETS, getEffectPreset, getEffectPresetChoices } from "../models/effect-preset.mjs";

export { getEffectPresetChoices };

export const TRANSPORT_SFX_ACTIONS = Object.freeze([
  { id: "play", label: "Воспроизведение" },
  { id: "pause", label: "Пауза" },
  { id: "stop", label: "Стоп" },
  { id: "seekBackward", label: "Перемотка назад" },
  { id: "seekForward", label: "Перемотка вперёд" },
  { id: "previous", label: "Предыдущий трек" },
  { id: "next", label: "Следующий трек" },
  { id: "open", label: "Открыть крышку" },
  { id: "closeLid", label: "Закрыть крышку" },
  { id: "eject", label: "Извлечь кассету" },
  { id: "select", label: "Вставить кассету" }
]);

const TRANSPORT_SFX_IDS = new Set(TRANSPORT_SFX_ACTIONS.map((action) => action.id));
const MAX_EFFECT_INTENSITY = 5;

let clickAudioContext = null;

export class EffectsService {
  static getPlaybackOptions(effects = {}) {
    const presetId = String(effects?.preset || "clean");
    const base = getEffectPreset(presetId);
    const intensity = clampNumber(effects?.intensity, 0, MAX_EFFECT_INTENSITY, 1);

    const effectsEnabled = getSettingSafe(SETTINGS.effectsEnabled, true);
    const fadeMs = Math.max(0, Number(getSettingSafe(SETTINGS.fadeMs, 160)) || 0);
    const clickSfx = Boolean(getSettingSafe(SETTINGS.deckClickSfx, true));
    const profile = buildNativeEffectProfile({ base, effects, intensity, effectsEnabled });

    return {
      preset: base.id,
      playbackRate: resolvePlaybackRate({ base, effects, intensity }),
      volumeMultiplier: clampNumber(effects?.volumeMultiplier, 0, 2, base.volumeMultiplier),
      fadeInMs: fadeMs,
      fadeOutMs: fadeMs,
      clickSfx,
      nativeEffects: profile
    };
  }

  static async playTransportClick(action = "click", { enabled = true, settingsOverride = null } = {}) {
    if (!enabled) return false;
    if (!settingsOverride && !getSettingSafe(SETTINGS.deckClickSfx, true)) return false;

    const clickAction = normalizeTransportSfxAction(action);
    const sfx = settingsOverride ? normalizeTransportSfxSettings(settingsOverride) : readTransportSfxSettings();
    const path = sfx.actions?.[clickAction] ?? "";

    if (path) {
      const played = await playAudioFile(path, resolveTransportSfxVolume(clickAction, sfx.volume));
      if (played) return true;
    }

    if (!sfx.fallbackSynth) return false;
    return playSynthClick(clickAction, resolveTransportSfxVolume(clickAction, sfx.volume));
  }

  static getPresetOptions() {
    return EFFECT_PRESETS;
  }
}

export function normalizeTransportSfxAction(action = "click") {
  const value = String(action || "click");
  if (TRANSPORT_SFX_IDS.has(value)) return value;
  if (value === "seek") return "seekForward";
  if (value === "cue") return "seekForward";
  if (value === "seekBack" || value === "rewind") return "seekBackward";
  if (value === "forward") return "seekForward";
  return value;
}


export function resolveTransportSfxVolume(action = "click", volume = DEFAULT_TRANSPORT_SFX.volume) {
  const normalized = clampNumber(volume, 0, 1, DEFAULT_TRANSPORT_SFX.volume);
  const clickAction = normalizeTransportSfxAction(action);
  if (clickAction !== "seekBackward" && clickAction !== "seekForward") return normalized;
  if (normalized <= 0) return 0;
  return Math.min(1, normalized * 1.35);
}

export function normalizeTransportSfxSettings(source = {}) {
  const foundryUtils = globalThis.foundry?.utils ?? null;
  const base = foundryUtils?.deepClone?.(DEFAULT_TRANSPORT_SFX) ?? JSON.parse(JSON.stringify(DEFAULT_TRANSPORT_SFX));
  const merged = foundryUtils?.mergeObject
    ? foundryUtils.mergeObject(base, source ?? {}, { inplace: false })
    : { ...base, ...(source ?? {}), actions: { ...base.actions, ...((source ?? {}).actions ?? {}) } };

  merged.volume = clampNumber(merged.volume, 0, 1, DEFAULT_TRANSPORT_SFX.volume);
  merged.fallbackSynth = Boolean(merged.fallbackSynth);
  merged.actions = merged.actions && typeof merged.actions === "object" ? merged.actions : {};

  for (const id of Object.keys(DEFAULT_TRANSPORT_SFX.actions)) {
    merged.actions[id] = String(merged.actions[id] || "").trim();
  }

  return merged;
}

function readTransportSfxSettings() {
  return normalizeTransportSfxSettings(getSettingSafe(SETTINGS.transportSfx, DEFAULT_TRANSPORT_SFX));
}

async function playAudioFile(path, volume = DEFAULT_TRANSPORT_SFX.volume) {
  const audio = new Audio(resolveFoundryAudioPath(path));
  const release = () => {
    try {
      audio.pause();
      audio.removeAttribute("src");
      audio.load?.();
    } catch (_error) {
      // Browser media cleanup is best effort.
    }
  };

  try {
    audio.volume = clampNumber(volume, 0, 1, DEFAULT_TRANSPORT_SFX.volume);
    audio.preload = "auto";
    audio.addEventListener?.("ended", release, { once: true });
    audio.addEventListener?.("error", release, { once: true });
    await audio.play();
    return true;
  } catch (error) {
    release();
    logger.log("Custom transport SFX failed; falling back if enabled.", error);
    return false;
  }
}

async function playSynthClick(action = "click", volume = DEFAULT_TRANSPORT_SFX.volume) {
  try {
    const context = getClickAudioContext();
    if (!context) return false;
    if (context.state === "suspended") await context.resume();

    const now = context.currentTime;
    const isSeek = action === "seekBackward" || action === "seekForward";
    const repeats = isSeek ? 9 : 1;
    const baseFrequency = resolveClickFrequency(action);
    const gainScale = clampNumber(volume, 0, 1, DEFAULT_TRANSPORT_SFX.volume);

    for (let index = 0; index < repeats; index += 1) {
      const start = now + index * (isSeek ? 0.05 : 0.055);
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = "square";
      oscillator.frequency.setValueAtTime(baseFrequency + index * 180, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, (isSeek ? 0.1 : 0.08) * gainScale), start + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + (isSeek ? 0.04 : 0.032));

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + (isSeek ? 0.048 : 0.04));
    }

    return true;
  } catch (error) {
    logger.log("Transport click SFX failed.", error);
    return false;
  }
}

function resolveClickFrequency(action = "click") {
  switch (action) {
    case "stop":
    case "eject":
      return 360;
    case "pause":
      return 520;
    case "select":
      return 420;
    case "open":
      return 470;
    case "closeLid":
      return 390;
    case "previous":
      return 610;
    case "next":
      return 660;
    case "seekBackward":
      return 460;
    case "seekForward":
      return 740;
    case "play":
    default:
      return 740;
  }
}
function buildNativeEffectProfile({ base, effects, intensity, effectsEnabled }) {
  const lowpass = resolveLowpass(base, effects, intensity);
  const highpass = resolveHighpass(base, effects, intensity, lowpass);

  return {
    preset: base.id,
    enabled: Boolean(effectsEnabled && base.id !== "clean"),
    lowpass,
    highpass,
    noise: clampNumber(effects?.noise, 0, 0.32, scaleAmount(base.noise, intensity, 1.04)),
    wowFlutter: clampNumber(effects?.wowFlutter, 0, 1, scaleAmount(base.wowFlutter, intensity, 1.08)),
    toneWobble: clampNumber(effects?.toneWobble, 0, 1, scaleAmount(base.toneWobble, intensity, 1.12)),
    dropout: clampNumber(effects?.dropout, 0, 0.98, scaleAmount(base.dropout, intensity, 1.2)),
    dropoutDepth: clampNumber(effects?.dropoutDepth, 0, 0.995, scaleAmount(base.dropoutDepth, intensity, 0.55)),
    dropoutHoldMs: clampNumber(effects?.dropoutHoldMs, 0, 900, base.dropoutHoldMs * (1 + Math.max(0, intensity - 1) * 0.45)),
    saturation: clampNumber(effects?.saturation, 0, 2, scaleAmount(base.saturation, intensity, 0.92)),
    compression: clampNumber(effects?.compression, 0, 2, scaleAmount(base.compression, intensity, 0.72)),
    intensity
  };
}

function scaleAmount(baseValue, intensity, exponent = 1) {
  const base = Number(baseValue) || 0;
  if (base <= 0) return 0;
  const multiplier = Math.pow(Math.max(0, Number(intensity) || 0), exponent);
  return base * multiplier;
}

function resolveLowpass(base, effects, intensity) {
  const manual = resolveMaybeNumber(effects?.lowpass, null);
  if (manual !== null) return clampNumber(manual, 80, 22050, manual);
  if (!base.lowpass) return null;

  const overdrive = Math.max(0, Number(intensity) - 1);
  const divisor = 1 + overdrive * 0.34 + Math.pow(overdrive, 1.45) * 0.06;
  const floor = Number(base.lowpassFloor ?? 120) || 120;
  return Math.max(floor, Number(base.lowpass) / divisor);
}

function resolveHighpass(base, effects, intensity, lowpass) {
  const manual = resolveMaybeNumber(effects?.highpass, null);
  if (manual !== null) return clampNumber(manual, 10, 4000, manual);
  if (!base.highpass) return null;

  const overdrive = Math.max(0, Number(intensity) - 1);
  let value = Number(base.highpass) * (1 + overdrive * 0.28 + Math.pow(overdrive, 1.35) * 0.04);
  const ceil = Number(base.highpassCeil ?? value) || value;
  value = Math.min(ceil, value);

  if (Number.isFinite(Number(lowpass)) && Number(lowpass) > 0) value = Math.min(value, Math.max(20, Number(lowpass) * 0.72));
  return Math.max(10, value);
}

function resolvePlaybackRate({ base, effects, intensity }) {
  if (effects?.playbackRate !== null && effects?.playbackRate !== undefined && effects?.playbackRate !== "") {
    return clampNumber(effects.playbackRate, 0.25, 4, base.playbackRate);
  }

  const overdrive = Math.max(0, Number(intensity) - 1);
  const drift = Number(base.playbackRateDrift ?? 0) * overdrive;
  return clampNumber(Number(base.playbackRate ?? 1) - drift, 0.45, 4, 1);
}

function getSettingSafe(key, fallback) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch (_error) {
    return fallback;
  }
}

function getClickAudioContext() {
  const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!clickAudioContext || clickAudioContext.state === "closed") clickAudioContext = new AudioContextClass();
  return clickAudioContext;
}
