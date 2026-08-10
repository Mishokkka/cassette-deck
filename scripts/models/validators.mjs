const SAFE_AUDIO_EXTENSIONS = new Set(["ogg", "oga", "mp3", "wav", "flac", "webm", "m4a", "aac"]);

export function canonicalizeLocalPath(path) {
  if (typeof path !== "string") return null;
  let value = path.trim();
  if (!value || value.includes("\0")) return null;

  try {
    value = decodeURIComponent(value);
  } catch (_error) {
    return null;
  }

  value = value.replace(/\\/g, "/");
  // Reject protocol-relative and UNC-style paths before stripping leading slashes.
  if (value.startsWith("//")) return null;
  value = value.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;

  const clean = value.split("?")[0].split("#")[0];
  const segments = clean.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) return null;
  if (/^[a-z]:$/i.test(segments[0])) return null;
  return segments.join("/");
}

export function isSafeAudioPath(path, { allowRemote = false } = {}) {
  if (typeof path !== "string" || !path.trim()) return false;
  const normalized = path.trim();
  if (/^https?:\/\//i.test(normalized)) return Boolean(allowRemote);

  const canonical = canonicalizeLocalPath(normalized);
  if (!canonical) return false;
  const extension = canonical.split(".").pop()?.toLowerCase();
  return SAFE_AUDIO_EXTENSIONS.has(extension);
}

export function normalizeAudioPath(path) {
  const canonical = canonicalizeLocalPath(path);
  return canonical && isSafeAudioPath(canonical) ? canonical : "";
}
