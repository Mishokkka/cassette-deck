export function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function resolveMaybeNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function resolveFoundryAssetPath(path) {
  const value = String(path || "").trim();
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) return value;

  try {
    return foundry.utils.getRoute(value);
  } catch (_error) {
    return value;
  }
}

export function resolveFoundryAudioPath(path) {
  return resolveFoundryAssetPath(path);
}

export function codedError(message, code = "UNKNOWN", details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export function getErrorCode(error, fallback = "UNKNOWN") {
  return String(error?.code || error?.data?.code || fallback);
}

export function formatErrorResult(error, fallbackReason = "operation failed", fallbackCode = "UNKNOWN") {
  return {
    ok: false,
    reason: error?.message ?? fallbackReason,
    code: getErrorCode(error, fallbackCode)
  };
}
