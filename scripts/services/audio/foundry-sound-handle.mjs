import { logger } from "../../core/logger.mjs";
import { resolveFoundryAudioPath } from "../../core/utils.mjs";
import { createShuttleAudio, normalizeShuttleSourceVolume, playHtmlShuttleScan, releaseShuttleAudio } from "./shuttle-preview.mjs";

export class FoundrySoundHandle {
  kind = "foundry";

  constructor(sound, path) {
    this.sound = sound;
    this.path = path;
    this.volume = 0.8;
    this._fadeToken = 0;
    this._shuttleAudio = null;
    this.effectsState = { supported: false, reason: "Foundry Sound diagnostic mode" };
  }

  get playing() {
    return Boolean(this.sound?.playing ?? this.sound?.isPlaying ?? false);
  }

  get currentTime() {
    const value = this.sound?.currentTime ?? this.sound?.time ?? 0;
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  get duration() {
    const value = this.sound?.duration ?? this.sound?.buffer?.duration ?? null;
    return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
  }

  async play({ offset = 0, volume = 0.8, playbackRate = 1, loop = false, fadeInMs = 0, isCurrent = () => true } = {}) {
    this.volume = volume;
    this._fadeToken += 1;

    if (typeof this.sound.load === "function" && !this.sound.loaded) {
      await this.sound.load({ autoplay: false });
      if (!isCurrent()) return { ok: true, ignored: true };
    }

    try {
      if ("volume" in this.sound) this.sound.volume = fadeInMs > 0 ? 0 : volume;
      if ("playbackRate" in this.sound) this.sound.playbackRate = playbackRate;
    } catch (error) {
      logger.log("Could not assign Foundry sound playback properties.", error);
    }

    if (typeof this.sound.stop === "function") await this.sound.stop();
    if (!isCurrent()) return { ok: true, ignored: true };

    const result = this.sound.play?.({ offset, volume: fadeInMs > 0 ? 0 : volume, loop });
    if (result instanceof Promise) await result;
    if (!isCurrent()) return { ok: true, ignored: true };

    if (fadeInMs > 0) await this.#fadeTo(volume, fadeInMs, { isCurrent });
  }

  setVolume(volume = 0.8) {
    this._fadeToken += 1;
    const value = Math.min(1, Math.max(0, Number(volume) || 0));
    this.volume = value;
    if (this.sound && "volume" in this.sound) this.sound.volume = value;
  }

  async pause({ fadeOutMs = 0, isCurrent = () => true } = {}) {
    this._fadeToken += 1;
    if (fadeOutMs > 0) await this.#fadeTo(0, fadeOutMs, { isCurrent });
    if (!isCurrent()) return;

    if (typeof this.sound.pause === "function") {
      const result = this.sound.pause();
      if (result instanceof Promise) await result;
      return;
    }

    if (typeof this.sound.stop === "function") await this.sound.stop();
  }

  async stop({ fadeOutMs = 0, isCurrent = () => true } = {}) {
    this._fadeToken += 1;
    if (fadeOutMs > 0) await this.#fadeTo(0, fadeOutMs, { isCurrent });
    if (!isCurrent()) return;
    if (typeof this.sound.stop !== "function") return;
    const result = this.sound.stop();
    if (result instanceof Promise) await result;
  }


  async shuttlePreview({ fromOffset = this.currentTime, toOffset = this.currentTime, durationMs = 500, volume = this.volume, playbackRate = 1, isCurrent = () => true } = {}) {
    this._fadeToken += 1;
    const token = this._fadeToken;
    const previewMs = Math.max(80, Number(durationMs) || 500);
    const start = Math.max(0, Number(fromOffset) || 0);
    const target = Math.max(0, Number(toOffset) || 0);
    const distance = Math.abs(target - start);
    if (distance < 0.05) return { ok: true, skipped: true, reason: "no shuttle distance" };

    try {
      if (typeof this.sound.stop === "function") await this.sound.stop();
      this._shuttleAudio ??= createShuttleAudio(resolveFoundryAudioPath(this.path));
      const previewed = await playHtmlShuttleScan({
        audio: this._shuttleAudio,
        start,
        target,
        previewMs,
        volume: normalizeShuttleSourceVolume(volume, this.volume),
        isCurrent: () => token === this._fadeToken && isCurrent()
      });
      if (token !== this._fadeToken || !isCurrent()) return { ok: true, ignored: true };
      if ("playbackRate" in this.sound) this.sound.playbackRate = Math.max(0.1, Number(playbackRate) || 1);
      if ("currentTime" in this.sound) this.sound.currentTime = target;
      return { ok: true, previewed, mode: previewed ? "html-scan" : "silent-delay", fromOffset: start, toOffset: target };
    } catch (error) {
      logger.log("Foundry shuttle preview failed; falling back to delayed seek.", error);
      return { ok: false, reason: error?.message ?? "foundry shuttle preview failed" };
    }
  }

  async cue({ offset = 0, volume = this.volume, isCurrent = () => true } = {}) {
    this._fadeToken += 1;
    this.setVolume(volume);
    try {
      if (typeof this.sound.stop === "function") await this.sound.stop();
      if ("currentTime" in this.sound) this.sound.currentTime = Math.max(0, Number(offset) || 0);
    } catch (_error) {
      // Foundry Sound cue is best-effort diagnostic mode.
    }
    if (!isCurrent()) return { ok: true, ignored: true };
    return { ok: true };
  }

  destroy() {
    this._fadeToken += 1;
    releaseShuttleAudio(this._shuttleAudio);
    this._shuttleAudio = null;
    this.sound?.destroy?.();
  }

  async #fadeTo(volume, durationMs, { isCurrent = () => true } = {}) {
    const token = this._fadeToken;
    if (typeof this.sound?.fade === "function") {
      const result = this.sound.fade(volume, { duration: durationMs });
      if (result instanceof Promise) await result;
      else await wait(durationMs);
      return token === this._fadeToken && isCurrent();
    }

    try {
      if (token === this._fadeToken && isCurrent() && "volume" in this.sound) this.sound.volume = volume;
    } catch (_error) {
      // Diagnostic mode only.
    }
    await wait(durationMs);
    return token === this._fadeToken && isCurrent();
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
