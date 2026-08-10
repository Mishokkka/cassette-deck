import { SETTINGS } from "../core/constants.mjs";
import { getDeckState, getSetting } from "../core/settings.mjs";
import { logger } from "../core/logger.mjs";
import { normalizeDuration, resolveFoundryAudioPath } from "../core/utils.mjs";
import { getCassetteById, getVisibleTrackSummaries } from "./library-service.mjs";

const DEFAULT_METADATA_TIMEOUT_MS = 4500;
const DEFAULT_MAX_ENTRIES = 40;
const DEFAULT_PRELOAD_CONCURRENCY = 4;

export class PreloadService {
  static #cache = new Map();
  static #warmInfo = null;
  static #lastWarmSummary = null;
  static #warmGeneration = 0;
  static #stats = { hits: 0, misses: 0, timeouts: 0, errors: 0, evicted: 0, cancelled: 0, obsolete: 0 };

  static async preloadTrack(track, options = {}) {
    if (!track?.path) return { ok: false, reason: "track has no audio path" };
    const path = String(track.path).trim();
    if (!path) return { ok: false, reason: "track has empty audio path" };

    const cached = this.#cache.get(path);
    if (cached) {
      cached.lastAccessed = Date.now();
      if (cached.promise && cached.status === "loading") await cached.promise.catch(() => null);
      const failed = ["error", "timeout", "cancelled", "obsolete"].includes(cached.status) || cached.ok === false;
      const retryFailed = options.retryFailed !== false;
      if (!failed || !retryFailed) {
        this.#stats.hits += 1;
        return cached;
      }
      this.#releaseEntry(cached);
      this.#cache.delete(path);
    }

    this.#stats.misses += 1;
    this.#enforceCacheLimit({ reserve: 1 });

    const result = {
      ok: true,
      path,
      src: resolveFoundryAudioPath(path),
      timestamp: Date.now(),
      lastAccessed: Date.now(),
      duration: normalizeDuration(track.duration),
      status: "loading",
      kind: options.kind ?? "metadata",
      reason: options.reason ?? null,
      warmGeneration: Number.isFinite(Number(options.warmGeneration)) ? Number(options.warmGeneration) : null,
      nativeAudio: null,
      promise: null,
      cancel: null,
      error: null
    };

    this.#cache.set(path, result);

    try {
      const audio = new Audio();
      audio.preload = "metadata";
      audio.src = result.src;
      result.nativeAudio = audio;
      result.promise = loadAudioMetadata(audio, result, options.timeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS);
      audio.load();
      await result.promise.catch(() => null);
      result.promise = null;
      result.cancel = null;
      if (result.status === "timeout") this.#stats.timeouts += 1;
      if (result.status === "error") this.#stats.errors += 1;
      if (result.status === "cancelled") this.#stats.cancelled += 1;
      logger.log("Preloaded audio metadata.", { path, duration: result.duration, status: result.status });
    } catch (error) {
      result.ok = false;
      result.status = "error";
      result.error = error?.message ?? "audio metadata preload failed";
      result.reason = result.error;
      this.#releaseMediaReference(result);
      result.promise = null;
      result.cancel = null;
      this.#stats.errors += 1;
      logger.warn("Audio metadata preload failed.", error);
    }

    return result;
  }

  static async preloadTracks(tracks = [], options = {}) {
    const startedAt = Date.now();
    const max = Number.isFinite(Number(options.max)) ? Math.max(0, Number(options.max)) : this.#getMaxEntries();
    const concurrency = Number.isFinite(Number(options.concurrency))
      ? Math.max(1, Math.floor(Number(options.concurrency)))
      : this.#getConcurrency();
    const warmGeneration = Number.isFinite(Number(options.warmGeneration)) ? Number(options.warmGeneration) : null;
    const shouldContinue = typeof options.shouldContinue === "function"
      ? options.shouldContinue
      : () => warmGeneration === null || warmGeneration === this.#warmGeneration;
    const unique = uniqueTracks(tracks, max);
    const results = new Array(unique.length);
    let cursor = 0;
    let cancelled = 0;

    const worker = async () => {
      while (cursor < unique.length) {
        if (!shouldContinue()) {
          cancelled += 1;
          return;
        }
        const index = cursor;
        cursor += 1;
        if (!shouldContinue()) {
          results[index] = { ok: true, status: "obsolete", reason: "warm invalidated before preload" };
          this.#stats.obsolete += 1;
          continue;
        }
        results[index] = await this.preloadTrack(unique[index], { ...options, warmGeneration });
      }
    };

    const workerCount = Math.min(concurrency, unique.length);
    if (workerCount > 0) await Promise.all(Array.from({ length: workerCount }, () => worker()));

    this.#lastWarmSummary = {
      timestamp: Date.now(),
      requested: tracks.length,
      attempted: unique.length,
      ready: results.filter((entry) => entry?.status === "ready").length,
      loading: results.filter((entry) => entry?.status === "loading").length,
      timeout: results.filter((entry) => entry?.status === "timeout").length,
      errors: results.filter((entry) => entry?.status === "error").length,
      obsolete: results.filter((entry) => entry?.status === "obsolete").length + cancelled,
      strategy: options.strategy ?? null,
      concurrency: workerCount,
      durationMs: Date.now() - startedAt
    };

    return results;
  }

  static async warmFromCurrentContext({ reason = "manual", force = false } = {}) {
    const strategy = String(getSetting(SETTINGS.preloadStrategy) || "cassette");
    if (strategy === "none" && !force) {
      this.#lastWarmSummary = { timestamp: Date.now(), reason, strategy, attempted: 0, ready: 0, errors: 0 };
      return this.#lastWarmSummary;
    }

    if (force) this.#warmGeneration += 1;
    if (this.#warmInfo && this.#warmInfo.generation === this.#warmGeneration) return this.#warmInfo.promise;

    const startedAt = Date.now();
    const generation = this.#warmGeneration;
    const promise = (async () => {
      try {
        const maxEntries = this.#getMaxEntries();
        const tracks = this.#resolveTracksForStrategy(strategy, { max: maxEntries });
        const concurrency = this.#getConcurrency();
        const results = await this.preloadTracks(tracks, {
          strategy,
          reason,
          max: maxEntries,
          kind: "metadata",
          concurrency,
          warmGeneration: generation,
          shouldContinue: () => generation === this.#warmGeneration
        });

        const summary = {
          timestamp: Date.now(),
          reason,
          strategy,
          attempted: results.length,
          ready: results.filter((entry) => entry?.status === "ready").length,
          timeout: results.filter((entry) => entry?.status === "timeout").length,
          errors: results.filter((entry) => entry?.status === "error").length,
          cacheSize: this.#cache.size,
          concurrency: Math.min(concurrency, results.length),
          durationMs: Date.now() - startedAt,
          generation,
          obsolete: generation !== this.#warmGeneration
        };

        if (generation === this.#warmGeneration) this.#lastWarmSummary = summary;
        return summary;
      } finally {
        if (this.#warmInfo?.promise === promise) this.#warmInfo = null;
      }
    })();

    this.#warmInfo = { promise, generation, startedAt, reason, strategy };
    return promise;
  }

  static async warmSelectedCassette({ includeNext = getSetting(SETTINGS.preloadNextTrack), reason = "selected-cassette" } = {}) {
    const deckState = getDeckState();
    const cassette = deckState.cassetteId ? getCassetteById(deckState.cassetteId) : null;
    if (!cassette) return [];

    const tracks = includeNext ? getCurrentAndNextTracks(cassette, deckState.trackId) : [getCurrentTrack(cassette, deckState.trackId)];
    return this.preloadTracks(tracks.filter(Boolean), { strategy: "selected", reason, max: this.#getMaxEntries(), concurrency: this.#getConcurrency() });
  }

  static getCached(path) {
    const key = String(path || "").trim();
    if (!key) return null;
    const cached = this.#cache.get(key) ?? null;
    if (cached) cached.lastAccessed = Date.now();
    return cached;
  }

  static getCachedDuration(path) {
    const cached = this.getCached(path);
    return normalizeDuration(cached?.duration);
  }

  static getState() {
    return Array.from(this.#cache.values()).map((entry) => ({
      ok: entry.ok,
      path: entry.path,
      status: entry.status,
      duration: normalizeDuration(entry.duration),
      error: entry.error ?? null,
      timestamp: entry.timestamp,
      lastAccessed: entry.lastAccessed,
      kind: entry.kind ?? "metadata",
      reason: entry.reason ?? null,
      warmGeneration: entry.warmGeneration ?? null
    }));
  }

  static getSummary() {
    const entries = this.getState();
    return {
      strategy: String(getSetting(SETTINGS.preloadStrategy) || "cassette"),
      preloadNextTrack: Boolean(getSetting(SETTINGS.preloadNextTrack)),
      maxEntries: this.#getMaxEntries(),
      cacheSize: entries.length,
      ready: entries.filter((entry) => entry.status === "ready").length,
      loading: entries.filter((entry) => entry.status === "loading").length,
      timeout: entries.filter((entry) => entry.status === "timeout").length,
      errors: entries.filter((entry) => entry.status === "error").length,
      warming: Boolean(this.#warmInfo),
      warmReason: this.#warmInfo?.reason ?? null,
      warmAgeMs: this.#warmInfo ? Date.now() - this.#warmInfo.startedAt : null,
      warmGeneration: this.#warmGeneration,
      concurrency: this.#getConcurrency(),
      stats: { ...this.#stats },
      lastWarmSummary: this.#lastWarmSummary,
      entries
    };
  }

  static clear() {
    for (const entry of this.#cache.values()) this.#releaseEntry(entry);

    this.#cache.clear();
    this.#lastWarmSummary = null;
    this.#warmInfo = null;
    this.#warmGeneration += 1;
  }

  static #resolveTracksForStrategy(strategy, { max = this.#getMaxEntries() } = {}) {
    const deckState = getDeckState();
    const cassette = deckState.cassetteId ? getCassetteById(deckState.cassetteId) : null;
    const includeNext = Boolean(getSetting(SETTINGS.preloadNextTrack));

    if (strategy === "current") {
      return [getCurrentTrack(cassette, deckState.trackId)].filter(Boolean);
    }

    if (strategy === "cassette") {
      if (!cassette) return [];
      const tracks = Array.isArray(cassette.tracks) ? [...cassette.tracks] : [];
      if (includeNext) {
        for (const track of getCurrentAndNextTracks(cassette, deckState.trackId)) {
          if (track && !tracks.some((item) => item.id === track.id)) tracks.unshift(track);
        }
      }
      return tracks;
    }

    if (strategy === "visible") {
      return getVisibleTrackSummaries({ visibleTo: game.user, limit: max });
    }

    return [];
  }

  static #getMaxEntries() {
    const value = Number(getSetting(SETTINGS.preloadMaxEntries));
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_ENTRIES;
  }

  static #getConcurrency() {
    const value = Number(getSetting(SETTINGS.preloadConcurrency));
    return Number.isFinite(value) && value > 0 ? Math.min(8, Math.max(1, Math.floor(value))) : DEFAULT_PRELOAD_CONCURRENCY;
  }

  static #enforceCacheLimit({ reserve = 0 } = {}) {
    const max = this.#getMaxEntries();
    if (!Number.isFinite(max) || max <= 0) return;

    while (this.#cache.size + reserve > max) {
      let oldestKey = null;
      let oldestEntry = null;
      let oldestTime = Infinity;

      for (const [key, entry] of this.#cache.entries()) {
        const time = Number(entry.lastAccessed ?? entry.timestamp ?? 0);
        if (time >= oldestTime) continue;
        oldestTime = time;
        oldestKey = key;
        oldestEntry = entry;
      }

      if (!oldestKey || !oldestEntry) break;
      this.#releaseEntry(oldestEntry);
      this.#cache.delete(oldestKey);
    }
  }

  static invalidateWarm(reason = "invalidated") {
    const previousGeneration = this.#warmGeneration;
    this.#warmGeneration += 1;
    const cancelled = this.#cancelLoadingWarmEntries(previousGeneration);
    this.#lastWarmSummary = {
      timestamp: Date.now(),
      reason,
      invalidated: true,
      generation: this.#warmGeneration,
      previousGeneration,
      cancelled
    };
  }

  static #cancelLoadingWarmEntries(generation = null) {
    let count = 0;
    for (const entry of this.#cache.values()) {
      if (entry?.status !== "loading") continue;
      if (generation !== null && entry.warmGeneration !== generation) continue;
      try {
        entry.cancel?.();
        count += 1;
      } catch (_error) {
        // Cancellation is best effort.
      }
    }
    return count;
  }

  static #releaseEntry(entry) {
    try {
      entry?.cancel?.();
      this.#stats.evicted += 1;
    } catch (_error) {
      // Cancellation is best effort.
    }
    this.#releaseMediaReference(entry);
    if (entry) {
      entry.promise = null;
      entry.cancel = null;
    }
  }

  static #releaseMediaReference(entry) {
    const audio = entry?.nativeAudio;
    if (!audio) return;
    try {
      audio.removeAttribute("src");
      audio.load?.();
    } catch (_error) {
      // Browser cleanup is best effort.
    }
    entry.nativeAudio = null;
  }
}

function loadAudioMetadata(audio, result, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (status = "ready", error = null) => {
      if (settled) return;
      settled = true;
      audio.removeEventListener("loadedmetadata", onReady);
      audio.removeEventListener("durationchange", onReady);
      audio.removeEventListener("canplay", onReady);
      audio.removeEventListener("error", onError);
      window.clearTimeout(timeout);

      const duration = normalizeDuration(audio.duration);
      if (duration !== null) result.duration = duration;
      result.status = duration !== null ? "ready" : status;
      if (error) {
        result.ok = false;
        result.error = error;
        result.reason = error;
      }
      try {
        audio.removeAttribute("src");
        audio.load?.();
      } catch (_error) {
        // Browser cleanup is best effort.
      }
      result.nativeAudio = null;
      result.cancel = null;
      resolve(result);
    };

    const onReady = () => {
      const duration = normalizeDuration(audio.duration);
      if (duration === null) return;
      result.duration = duration;
      finish("ready");
    };

    const onError = () => {
      const code = audio.error?.code ? `HTMLMediaError ${audio.error.code}` : "audio metadata error";
      finish("error", code);
    };

    result.cancel = () => finish("cancelled");

    audio.addEventListener("loadedmetadata", onReady);
    audio.addEventListener("durationchange", onReady);
    audio.addEventListener("canplay", onReady);
    audio.addEventListener("error", onError);

    const timeout = window.setTimeout(() => finish("timeout"), Math.max(1000, Number(timeoutMs) || DEFAULT_METADATA_TIMEOUT_MS));

    // Metadata may already be available from the browser cache.
    onReady();
  });
}

function uniqueTracks(tracks = [], limit = Infinity) {
  const seen = new Set();
  const result = [];
  const max = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : Infinity;
  if (max === 0) return result;

  for (const track of tracks) {
    const path = String(track?.path || "").trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push(track);
    if (result.length >= max) break;
  }

  return result;
}

function getCurrentTrack(cassette, trackId = null) {
  if (!cassette) return null;
  if (trackId) return cassette.tracks?.find((track) => track.id === trackId) ?? null;
  return cassette.tracks?.[0] ?? null;
}

function getCurrentAndNextTracks(cassette, trackId = null) {
  const tracks = Array.isArray(cassette?.tracks) ? cassette.tracks.filter((track) => track?.path) : [];
  if (!tracks.length) return [];

  const foundIndex = trackId ? tracks.findIndex((track) => track.id === trackId) : 0;
  if (foundIndex < 0) return [];
  const currentIndex = foundIndex;
  const current = tracks[currentIndex] ?? null;
  const next = tracks.length > 1 ? tracks[(currentIndex + 1) % tracks.length] : null;
  return [current, next].filter(Boolean);
}
