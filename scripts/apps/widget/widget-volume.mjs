const VOLUME_CURVE_EXPONENT = 2.5;

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value, fallback = 80) {
  const raw = numberOrNull(value);
  const fallbackRaw = numberOrNull(fallback);
  const resolved = raw ?? fallbackRaw ?? 80;
  return Math.min(100, Math.max(0, Math.round(resolved)));
}

function volumePercentToGain(percent) {
  const normalized = clampPercent(percent, 80) / 100;
  if (normalized <= 0) return 0;
  return Math.min(1, Math.max(0, Math.pow(normalized, VOLUME_CURVE_EXPONENT)));
}

function volumeGainToPercent(gain) {
  const value = numberOrNull(gain);
  const normalized = value !== null ? Math.min(1, Math.max(0, value)) : 0.8;
  if (normalized <= 0) return 0;
  return clampPercent(Math.pow(normalized, 1 / VOLUME_CURVE_EXPONENT) * 100, 80);
}

export { numberOrNull, clampPercent, volumePercentToGain, volumeGainToPercent };
