import { logger } from "../../core/logger.mjs";

export const SHUTTLE_PREVIEW_GAIN = 1.65;
const SHUTTLE_SCAN_RATE = 4;

export function normalizeShuttleSourceVolume(volume = 0.8, fallback = 0.8) {
  const raw = Number(volume);
  if (Number.isFinite(raw)) return Math.min(1, Math.max(0, raw));
  const fallbackValue = Number(fallback);
  return Math.min(1, Math.max(0, Number.isFinite(fallbackValue) ? fallbackValue : 0.8));
}

export function resolveShuttlePreviewVolume(volume = 0.8, fallback = 0.8) {
  const base = normalizeShuttleSourceVolume(volume, fallback);
  if (base <= 0) return 0;
  return Math.min(1, base * SHUTTLE_PREVIEW_GAIN);
}

export function createShuttleAudio(src = "") {
  const audio = new Audio(src);
  audio.preload = "metadata";
  audio.loop = false;
  audio.preservesPitch = false;
  audio.mozPreservesPitch = false;
  audio.webkitPreservesPitch = false;
  return audio;
}

export function releaseShuttleAudio(audio) {
  if (!audio) return;
  try {
    audio.pause();
    audio.removeAttribute("src");
    audio.load?.();
  } catch (_error) {
    // Browser media cleanup is best effort.
  }
}

export async function playHtmlShuttleScan({
  audio,
  start = 0,
  target = 0,
  previewMs = 500,
  volume = 0.8,
  isCurrent = () => true
} = {}) {
  const segmentStart = Math.min(start, target);
  const segmentEnd = Math.max(start, target);
  const distance = Math.max(0, segmentEnd - segmentStart);
  if (!audio || distance < 0.05) return false;

  const sliceCount = Math.max(2, Math.min(6, Math.floor(previewMs / 85)));
  const sliceMs = Math.max(55, previewMs / sliceCount);
  const sliceSeconds = Math.max(0.12, (sliceMs / 1000) * SHUTTLE_SCAN_RATE * 0.9);
  const forward = target >= start;
  const previewVolume = resolveShuttlePreviewVolume(volume);
  let playedAny = false;

  audio.pause();
  audio.loop = false;
  audio.volume = previewVolume;
  audio.playbackRate = SHUTTLE_SCAN_RATE;
  audio.preservesPitch = false;
  audio.mozPreservesPitch = false;
  audio.webkitPreservesPitch = false;

  await waitForMediaReady(audio, 180);
  if (!isCurrent()) return false;

  for (let index = 0; index < sliceCount; index += 1) {
    if (!isCurrent()) break;

    const fraction = sliceCount === 1 ? 0 : index / (sliceCount - 1);
    const scanPosition = forward
      ? segmentStart + distance * fraction
      : segmentEnd - distance * fraction;
    const offset = forward
      ? Math.min(Math.max(segmentStart, scanPosition), Math.max(segmentStart, segmentEnd - 0.04))
      : Math.max(segmentStart, Math.min(segmentEnd, scanPosition) - sliceSeconds);

    try {
      audio.pause();
      audio.currentTime = Math.max(0, offset);
      audio.playbackRate = SHUTTLE_SCAN_RATE;
      audio.volume = previewVolume;
      const playPromise = audio.play();
      if (playPromise instanceof Promise) {
        const started = await Promise.race([
          playPromise.then(() => ({ ok: true }), (error) => ({ ok: false, error })),
          wait(70).then(() => ({ pending: true }))
        ]);
        if (started?.ok === false) throw started.error;
        if (started?.pending) {
          void playPromise.catch((error) => logger.log("Shuttle scan preview play promise rejected after startup.", error));
        }
      }
      playedAny = true;
    } catch (error) {
      logger.log("Shuttle scan slice failed.", error);
      break;
    }

    await wait(sliceMs);
  }

  audio.pause();
  return playedAny;
}

function waitForMediaReady(audio, timeoutMs = 180) {
  if (!audio) return Promise.resolve(false);
  if (Number(audio.readyState ?? 0) >= 1) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    let timeout = null;
    const cleanup = () => {
      audio.removeEventListener?.("loadedmetadata", done);
      audio.removeEventListener?.("canplay", done);
      audio.removeEventListener?.("error", done);
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = null;
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Number(audio.readyState ?? 0) >= 1);
    };
    audio.addEventListener?.("loadedmetadata", done, { once: true });
    audio.addEventListener?.("canplay", done, { once: true });
    audio.addEventListener?.("error", done, { once: true });
    timeout = window.setTimeout(done, Math.max(20, Number(timeoutMs) || 180));
    try { audio.load?.(); } catch (_error) {}
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
