const VOLUME_CURVE_EXPONENT = 2.5;
export const DEFAULT_VOLUME_PERCENT = 80;
export const DEFAULT_VOLUME_GAIN = Math.pow(DEFAULT_VOLUME_PERCENT / 100, VOLUME_CURVE_EXPONENT);

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value, fallback = DEFAULT_VOLUME_PERCENT) {
  const raw = numberOrNull(value);
  const fallbackRaw = numberOrNull(fallback);
  const resolved = raw ?? fallbackRaw ?? DEFAULT_VOLUME_PERCENT;
  return Math.min(100, Math.max(0, Math.round(resolved)));
}

function volumePercentToGain(percent) {
  const normalized = clampPercent(percent, DEFAULT_VOLUME_PERCENT) / 100;
  if (normalized <= 0) return 0;
  return Math.min(1, Math.max(0, Math.pow(normalized, VOLUME_CURVE_EXPONENT)));
}

function volumeGainToPercent(gain) {
  const value = numberOrNull(gain);
  const normalized = value !== null ? Math.min(1, Math.max(0, value)) : DEFAULT_VOLUME_GAIN;
  if (normalized <= 0) return 0;
  return clampPercent(Math.pow(normalized, 1 / VOLUME_CURVE_EXPONENT) * 100, DEFAULT_VOLUME_PERCENT);
}

export { numberOrNull, clampPercent, volumePercentToGain, volumeGainToPercent };
