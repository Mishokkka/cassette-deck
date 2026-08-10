const EFFECT_PRESET_DEFINITIONS = {
  clean: {
    id: "clean",
    playbackRate: 1,
    volumeMultiplier: 1,
    lowpass: null,
    lowpassFloor: null,
    highpass: null,
    highpassCeil: null,
    noise: 0,
    wowFlutter: 0,
    toneWobble: 0,
    dropout: 0,
    dropoutDepth: 0,
    dropoutHoldMs: 0,
    saturation: 0,
    compression: 0,
    playbackRateDrift: 0
  },
  "old-tape": {
    id: "old-tape",
    playbackRate: 0.998,
    volumeMultiplier: 0.94,
    lowpass: 5600,
    lowpassFloor: 1200,
    highpass: 95,
    highpassCeil: 420,
    noise: 0.012,
    wowFlutter: 0.045,
    toneWobble: 0.04,
    dropout: 0.014,
    dropoutDepth: 0.28,
    dropoutHoldMs: 65,
    saturation: 0.16,
    compression: 0.2,
    playbackRateDrift: 0.006
  },
  damaged: {
    id: "damaged",
    playbackRate: 0.986,
    volumeMultiplier: 0.84,
    lowpass: 3300,
    lowpassFloor: 650,
    highpass: 150,
    highpassCeil: 620,
    noise: 0.026,
    wowFlutter: 0.115,
    toneWobble: 0.105,
    dropout: 0.065,
    dropoutDepth: 0.48,
    dropoutHoldMs: 110,
    saturation: 0.42,
    compression: 0.45,
    playbackRateDrift: 0.012
  },
  ruined: {
    id: "ruined",
    playbackRate: 0.955,
    volumeMultiplier: 0.76,
    lowpass: 1800,
    lowpassFloor: 360,
    highpass: 230,
    highpassCeil: 820,
    noise: 0.052,
    wowFlutter: 0.22,
    toneWobble: 0.22,
    dropout: 0.16,
    dropoutDepth: 0.72,
    dropoutHoldMs: 180,
    saturation: 0.78,
    compression: 0.78,
    playbackRateDrift: 0.022
  },
  unreadable: {
    id: "unreadable",
    playbackRate: 0.91,
    volumeMultiplier: 0.68,
    lowpass: 950,
    lowpassFloor: 180,
    highpass: 340,
    highpassCeil: 960,
    noise: 0.082,
    wowFlutter: 0.34,
    toneWobble: 0.38,
    dropout: 0.32,
    dropoutDepth: 0.92,
    dropoutHoldMs: 260,
    saturation: 1.2,
    compression: 1.0,
    playbackRateDrift: 0.038
  }
};

export const EFFECT_PRESETS = Object.freeze(Object.assign(
  Object.create(null),
  Object.fromEntries(
    Object.entries(EFFECT_PRESET_DEFINITIONS).map(([id, preset]) => [id, Object.freeze({ ...preset })])
  )
));

export function getEffectPreset(presetId) {
  const id = String(presetId || "clean");
  return Object.hasOwn(EFFECT_PRESETS, id) ? EFFECT_PRESETS[id] : EFFECT_PRESETS.clean;
}

const PRESET_LABELS = Object.freeze({
  clean: "Чистый звук",
  "old-tape": "Старая пленка",
  damaged: "Поврежденная пленка",
  ruined: "Разрушенная пленка",
  unreadable: "Нечитаемая запись"
});

export function getEffectPresetChoices() {
  return Object.values(EFFECT_PRESETS).map((preset) => ({
    id: preset.id,
    label: PRESET_LABELS[preset.id] ?? preset.id
  }));
}
