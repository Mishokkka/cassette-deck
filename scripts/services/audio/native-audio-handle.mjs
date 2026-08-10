import { logger } from "../../core/logger.mjs";
import { clampNumber, resolveFoundryAudioPath } from "../../core/utils.mjs";
import { createShuttleAudio, normalizeShuttleSourceVolume, playHtmlShuttleScan, releaseShuttleAudio } from "./shuttle-preview.mjs";

export class NativeAudioHandle {
  kind = "native";
  static #context = null;

  static async closeSharedContext() {
    const context = NativeAudioHandle.#context;
    NativeAudioHandle.#context = null;
    if (!context || context.state === "closed") return;
    try { await context.close(); } catch (_error) {}
  }

  constructor(path, { onEnded = null } = {}) {
    this.path = path;
    this.src = resolveFoundryAudioPath(path);
    this.audio = new Audio(this.src);
    this.audio.preload = "auto";
    this.#onEnded = typeof onEnded === "function" ? onEnded : null;
    this.#endedHandler = () => this.#emitEnded();
    this.audio.addEventListener("ended", this.#endedHandler);
    this.volume = 0.8;
    this._fadeToken = 0;
    this.effectsState = { enabled: false, preset: "clean" };

    this.#sourceNode = null;
    this.#highpassNode = null;
    this.#lowpassNode = null;
    this.#dropoutGain = null;
    this.#saturationNode = null;
    this.#compressorNode = null;
    this.#masterGain = null;
    this.#noiseHighpassNode = null;
    this.#noiseLowpassNode = null;
    this.#noiseGain = null;
    this.#noiseSource = null;
    this.#noiseBuffer = null;
    this.#wowTimer = null;
    this.#toneTimer = null;
    this.#dropoutTimer = null;
    this.#syncNudgeTimer = null;
    this.#basePlaybackRate = 1;
    this.#wowRateMultiplier = 1;
    this.#syncRateMultiplier = 1;
    this.#random = Math.random;
    this.#graphReady = false;
    this.#fadeToken = 0;
    this.#playToken = 0;
    this.#destroyed = false;
    this.#shuttleAudio = null;
  }

  #sourceNode;
  #highpassNode;
  #lowpassNode;
  #dropoutGain;
  #saturationNode;
  #compressorNode;
  #masterGain;
  #noiseHighpassNode;
  #noiseLowpassNode;
  #noiseGain;
  #noiseSource;
  #noiseBuffer;
  #wowTimer;
  #toneTimer;
  #dropoutTimer;
  #syncNudgeTimer;
  #basePlaybackRate;
  #wowRateMultiplier;
  #syncRateMultiplier;
  #random;
  #graphReady;
  #fadeToken;
  #playToken;
  #destroyed;
  #shuttleAudio;
  #onEnded;
  #endedHandler;

  get playing() {
    return !this.audio.paused && !this.audio.ended;
  }

  get currentTime() {
    return Number(this.audio.currentTime ?? 0) || 0;
  }

  get duration() {
    const duration = Number(this.audio.duration ?? 0);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  }

  async play({ offset = 0, volume = 0.8, playbackRate = 1, loop = false, fadeInMs = 0, nativeEffects = null, isCurrent = () => true } = {}) {
    this.#fadeToken += 1;
    const playToken = ++this.#playToken;
    this.audio.pause();
    this.volume = volume;
    this.audio.volume = fadeInMs > 0 ? 0 : volume;
    this.audio.loop = loop;
    this.#basePlaybackRate = playbackRate;
    this.#wowRateMultiplier = 1;
    this.#syncRateMultiplier = 1;
    this.#random = createSeededRandom(nativeEffects?.seed ?? `${this.path}:${offset}`);
    this.#applyPlaybackRate();

    const targetOffset = Math.max(0, Number(offset) || 0);
    const offsetApplied = this.#trySetCurrentTime(targetOffset);
    if (!offsetApplied && targetOffset > 0) {
      this.#setCurrentTimeWhenMetadataReady(targetOffset, playToken, isCurrent);
    }

    if (!isCurrent() || this.#destroyed || playToken !== this.#playToken) return { ok: true, ignored: true };

    let playPromise = null;
    try {
      playPromise = this.audio.play();
    } catch (error) {
      if (!isCurrent() || this.#destroyed || playToken !== this.#playToken) return { ok: true, ignored: true };
      throw error;
    }

    if (playPromise instanceof Promise) {
      const quickStart = await Promise.race([
        playPromise.then(
          () => ({ ok: true }),
          (error) => ({ ok: false, error })
        ),
        wait(75).then(() => ({ pending: true }))
      ]);

      if (!isCurrent() || this.#destroyed || playToken !== this.#playToken) {
        this.audio.pause();
        return { ok: true, ignored: true };
      }

      if (quickStart?.ok === false) throw quickStart.error;
      if (quickStart?.pending) {
        void playPromise.catch((error) => {
          if (isCurrent() && !this.#destroyed && playToken === this.#playToken) {
            logger.warn("Native audio play promise rejected after startup.", error);
          }
        });
      }
    }

    void this.#configureNativeEffects(nativeEffects, playbackRate)
      .then(() => {
        if (isCurrent() && !this.#destroyed && playToken === this.#playToken) {
          this.#startDynamicEffects(nativeEffects, playbackRate);
        }
      })
      .catch((error) => {
        if (isCurrent() && !this.#destroyed && playToken === this.#playToken) {
          logger.warn("Native audio effects configuration failed after playback start.", error);
        }
      });

    if (fadeInMs > 0) await this.#fadeElementVolume(volume, fadeInMs, { isCurrent });
    return { ok: true };
  }


  setVolume(volume = 0.8) {
    this.#fadeToken += 1;
    const value = Math.min(1, Math.max(0, Number(volume) || 0));
    this.volume = value;
    if (this.audio) this.audio.volume = value;
  }

  async pause({ fadeOutMs = 0, isCurrent = () => true } = {}) {
    this.#fadeToken += 1;
    this.#playToken += 1;
    if (fadeOutMs > 0) await this.#fadeElementVolume(0, fadeOutMs, { isCurrent });
    if (!isCurrent() || this.#destroyed) return;
    this.audio.pause();
    this.#stopDynamicEffects({ keepGraph: true });
    this.audio.volume = this.volume;
  }

  async stop({ fadeOutMs = 0, isCurrent = () => true } = {}) {
    this.#fadeToken += 1;
    this.#playToken += 1;
    if (fadeOutMs > 0) await this.#fadeElementVolume(0, fadeOutMs, { isCurrent });
    if (!isCurrent() || this.#destroyed) return;
    this.audio.pause();
    this.#stopDynamicEffects({ keepGraph: true });
    try {
      this.audio.currentTime = 0;
    } catch (error) {
      logger.log("Could not reset native audio currentTime.", error);
    }
    this.audio.volume = this.volume;
  }


  async shuttlePreview({ fromOffset = this.currentTime, toOffset = this.currentTime, durationMs = 500, volume = this.volume, playbackRate = this.#basePlaybackRate, isCurrent = () => true } = {}) {
    this.#fadeToken += 1;
    const playToken = ++this.#playToken;
    const previewMs = Math.max(80, Number(durationMs) || 500);
    const start = Math.max(0, Number(fromOffset) || 0);
    const target = Math.max(0, Number(toOffset) || 0);
    const distance = Math.abs(target - start);

    if (!isCurrent() || this.#destroyed || distance < 0.05) {
      if (Number.isFinite(target)) this.#trySetCurrentTime(target);
      return { ok: true, skipped: true, reason: "no shuttle distance" };
    }

    await this.#ensureMetadata();
    if (!isCurrent() || this.#destroyed || playToken !== this.#playToken) return { ok: true, ignored: true };

    const normalRate = Math.max(0.1, Number(playbackRate ?? this.#basePlaybackRate ?? 1) || 1);
    const normalizedVolume = normalizeShuttleSourceVolume(volume, this.volume);

    this.volume = normalizedVolume;
    this.audio.pause();
    this.audio.playbackRate = normalRate;
    this.audio.volume = normalizedVolume;
    this.#stopDynamicEffects({ keepGraph: true });

    const previewed = await this.#playAudibleShuttlePreview({
      start,
      target,
      previewMs,
      volume: normalizedVolume,
      isCurrent,
      playToken
    });

    if (!isCurrent() || this.#destroyed || playToken !== this.#playToken) return { ok: true, ignored: true };

    this.audio.pause();
    this.audio.playbackRate = normalRate;
    this.#trySetCurrentTime(target);
    this.audio.volume = this.volume;
    this.#stopDynamicEffects({ keepGraph: true });
    return { ok: true, previewed, mode: previewed ? "audible-scan" : "silent-delay", fromOffset: start, toOffset: target };
  }

  async #playAudibleShuttlePreview({ start = 0, target = 0, previewMs = 500, volume = this.volume, isCurrent = () => true, playToken = this.#playToken } = {}) {
    this.#shuttleAudio ??= createShuttleAudio(this.src);
    return playHtmlShuttleScan({
      audio: this.#shuttleAudio,
      start,
      target,
      previewMs,
      volume,
      isCurrent: () => isCurrent() && !this.#destroyed && playToken === this.#playToken
    });
  }

  async cue({ offset = 0, volume = this.volume, isCurrent = () => true } = {}) {
    this.#fadeToken += 1;
    this.#playToken += 1;
    this.volume = Math.min(1, Math.max(0, Number(volume) || 0));
    this.audio.volume = this.volume;
    await this.#ensureMetadata();
    if (!isCurrent() || this.#destroyed) return { ok: true, ignored: true };
    try {
      this.audio.currentTime = Math.max(0, Number(offset) || 0);
    } catch (error) {
      logger.warn("Could not cue native audio offset.", error);
    }
    this.audio.pause();
    this.#stopDynamicEffects({ keepGraph: true });
    return { ok: true };
  }

  async refreshEffects({ playbackRate = this.#basePlaybackRate, nativeEffects = null } = {}) {
    if (!this.playing || this.#destroyed) return;
    this.#basePlaybackRate = playbackRate;
    await this.#configureNativeEffects(nativeEffects, playbackRate);
    if (!this.playing || this.#destroyed) return;
    this.#startDynamicEffects(nativeEffects, playbackRate);
  }

  nudgeSync({ drift = 0, playbackRate = this.#basePlaybackRate, durationMs = 2400 } = {}) {
    if (!this.playing) return;
    if (this.#syncNudgeTimer) window.clearTimeout(this.#syncNudgeTimer);

    const direction = Number(drift) > 0 ? -1 : 1;
    const correction = Math.min(0.035, Math.max(0.008, Math.abs(Number(drift) || 0) * 0.012));
    this.#basePlaybackRate = Math.max(0.1, Number(playbackRate || this.#basePlaybackRate || 1));
    this.#syncRateMultiplier = 1 + direction * correction;
    this.#applyPlaybackRate();

    this.#syncNudgeTimer = window.setTimeout(() => {
      this.#syncRateMultiplier = 1;
      this.#applyPlaybackRate();
      this.#syncNudgeTimer = null;
    }, Math.max(300, Number(durationMs) || 2400));
  }

  destroy() {
    this.#destroyed = true;
    this.#fadeToken += 1;
    this.#playToken += 1;
    this.#stopDynamicEffects({ keepGraph: false });
    releaseShuttleAudio(this.#shuttleAudio);
    this.#shuttleAudio = null;
    if (this.#endedHandler) this.audio.removeEventListener("ended", this.#endedHandler);
    this.audio.removeAttribute("src");
    this.audio.load();
  }

  #emitEnded() {
    if (this.#destroyed || this.audio.loop) return;
    this.#stopDynamicEffects({ keepGraph: true });
    this.#onEnded?.({
      path: this.path,
      currentTime: this.currentTime,
      duration: this.duration
    });
  }


  #trySetCurrentTime(offset = 0) {
    try {
      this.audio.currentTime = Math.max(0, Number(offset) || 0);
      return true;
    } catch (error) {
      logger.log("Could not set native audio offset immediately.", error);
      return false;
    }
  }

  #setCurrentTimeWhenMetadataReady(offset = 0, playToken = this.#playToken, isCurrent = () => true) {
    const target = Math.max(0, Number(offset) || 0);
    const apply = () => {
      this.audio.removeEventListener("loadedmetadata", apply);
      this.audio.removeEventListener("canplay", apply);
      if (!isCurrent() || this.#destroyed || playToken !== this.#playToken) return;
      this.#trySetCurrentTime(target);
    };
    this.audio.addEventListener("loadedmetadata", apply, { once: true });
    this.audio.addEventListener("canplay", apply, { once: true });
    try {
      this.audio.load();
    } catch (_error) {
      // play() will also trigger loading; this is only a best-effort offset hook.
    }
  }

  async #ensureMetadata() {
    if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) return;
    await new Promise((resolve) => {
      let settled = false;
      let timeout = null;
      const done = () => {
        if (settled) return;
        settled = true;
        this.audio.removeEventListener("loadedmetadata", done);
        this.audio.removeEventListener("canplay", done);
        this.audio.removeEventListener("error", done);
        if (timeout !== null) window.clearTimeout(timeout);
        timeout = null;
        resolve();
      };
      this.audio.addEventListener("loadedmetadata", done, { once: true });
      this.audio.addEventListener("canplay", done, { once: true });
      this.audio.addEventListener("error", done, { once: true });
      this.audio.load();
      timeout = window.setTimeout(done, 2500);
    });
  }

  async #configureNativeEffects(profile = null, playbackRate = 1) {
    const enabled = Boolean(profile?.enabled);

    if (!enabled) {
      this.#stopDynamicEffects({ keepGraph: true });
      if (this.#sourceNode) {
        const context = this.#sourceNode.context;
        const now = context.currentTime;
        this.#lowpassNode?.frequency?.setTargetAtTime?.(22050, now, 0.02);
        this.#highpassNode?.frequency?.setTargetAtTime?.(10, now, 0.02);
        this.#dropoutGain?.gain?.setTargetAtTime?.(1, now, 0.02);
        this.#noiseGain?.gain?.setTargetAtTime?.(0, now, 0.02);
        if (this.#saturationNode) this.#saturationNode.curve = null;
        configureCompressor(this.#compressorNode, 0);
      }
      this.#basePlaybackRate = playbackRate;
      this.#applyPlaybackRate();
      this.effectsState = { enabled: false, preset: profile?.preset ?? "clean" };
      return;
    }

    const context = await this.#prepareAudioContextForGraph();
    if (!context) {
      this.effectsState = { enabled: false, preset: profile?.preset ?? "unknown", reason: "Web Audio unavailable or suspended" };
      return;
    }

    if (!this.#graphReady && !this.#createAudioGraph(context)) {
      this.effectsState = { enabled: false, preset: profile?.preset ?? "unknown", reason: "Web Audio graph unavailable" };
      return;
    }

    const now = context.currentTime;
    const lowpass = Number(profile.lowpass ?? 0);
    const highpass = Number(profile.highpass ?? 0);
    const noise = clampNumber(profile.noise, 0, 0.32, 0);
    const saturation = clampNumber(profile.saturation, 0, 2, 0);
    const compression = clampNumber(profile.compression, 0, 2, 0);

    this.#lowpassNode.frequency.setTargetAtTime(lowpass > 0 ? lowpass : 22050, now, 0.08);
    this.#highpassNode.frequency.setTargetAtTime(highpass > 0 ? highpass : 10, now, 0.08);
    this.#dropoutGain.gain.setTargetAtTime(1, now, 0.02);
    this.#noiseGain.gain.setTargetAtTime(noise, now, 0.18);

    if (this.#saturationNode) this.#saturationNode.curve = saturation > 0 ? createSaturationCurve(saturation) : null;
    configureCompressor(this.#compressorNode, compression);
    configureNoiseTone(this.#noiseHighpassNode, this.#noiseLowpassNode, { highpass, lowpass }, now);

    this.#basePlaybackRate = playbackRate;
    this.#applyPlaybackRate();

    this.#ensureNoiseSource(context);

    this.effectsState = {
      enabled: true,
      preset: profile.preset,
      lowpass: lowpass || null,
      highpass: highpass || null,
      noise,
      saturation,
      compression,
      wowFlutter: clampNumber(profile.wowFlutter, 0, 1, 0),
      toneWobble: clampNumber(profile.toneWobble, 0, 1, 0),
      dropout: clampNumber(profile.dropout, 0, 1, 0),
      dropoutDepth: clampNumber(profile.dropoutDepth, 0, 0.995, 0),
      dropoutHoldMs: clampNumber(profile.dropoutHoldMs, 0, 900, 0)
    };
  }

  async #prepareAudioContextForGraph() {
    const context = this.#getAudioContext();
    if (!context) return null;

    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch (error) {
        logger.log("Native Web Audio context resume failed; keeping direct media output.", error);
        return null;
      }
    }

    // Do not attach createMediaElementSource while the context is still suspended.
    // Attaching reroutes the element away from direct browser output; if the context
    // cannot actually run, the main track becomes silent while click SFX still works.
    if (context.state !== "running") return null;
    return context;
  }

  #createAudioGraph(context) {
    if (!context) return false;
    if (this.#sourceNode) return this.#graphReady;

    let source = null;
    const nodes = [];
    try {
      source = context.createMediaElementSource(this.audio);
      const highpass = context.createBiquadFilter();
      const lowpass = context.createBiquadFilter();
      const dropoutGain = context.createGain();
      const saturation = context.createWaveShaper();
      const compressor = context.createDynamicsCompressor();
      const masterGain = context.createGain();
      const noiseHighpass = context.createBiquadFilter();
      const noiseLowpass = context.createBiquadFilter();
      const noiseGain = context.createGain();
      nodes.push(highpass, lowpass, dropoutGain, saturation, compressor, masterGain, noiseHighpass, noiseLowpass, noiseGain);

      highpass.type = "highpass";
      lowpass.type = "lowpass";
      noiseHighpass.type = "highpass";
      noiseLowpass.type = "lowpass";
      dropoutGain.gain.value = 1;
      masterGain.gain.value = 1;
      noiseGain.gain.value = 0;
      saturation.oversample = "2x";
      configureCompressor(compressor, 0);

      source.connect(highpass).connect(lowpass).connect(saturation).connect(dropoutGain).connect(compressor).connect(masterGain).connect(context.destination);
      noiseHighpass.connect(noiseLowpass).connect(noiseGain).connect(dropoutGain);

      this.#sourceNode = source;
      this.#highpassNode = highpass;
      this.#lowpassNode = lowpass;
      this.#dropoutGain = dropoutGain;
      this.#saturationNode = saturation;
      this.#compressorNode = compressor;
      this.#masterGain = masterGain;
      this.#noiseHighpassNode = noiseHighpass;
      this.#noiseLowpassNode = noiseLowpass;
      this.#noiseGain = noiseGain;
      this.#graphReady = true;
      return true;
    } catch (error) {
      logger.warn("Could not create native Web Audio graph. Falling back to direct context output.", error);
      for (const node of nodes) {
        try { node.disconnect?.(); } catch (_error) {}
      }
      if (source) {
        try { source.disconnect?.(); } catch (_error) {}
        try { source.connect(context.destination); } catch (_error) {}
        this.#sourceNode = source;
      }
      this.#graphReady = false;
      return false;
    }
  }

  #getAudioContext() {
    const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContextClass) return null;

    if (!NativeAudioHandle.#context || NativeAudioHandle.#context.state === "closed") {
      NativeAudioHandle.#context = new AudioContextClass();
    }

    return NativeAudioHandle.#context;
  }

  #ensureNoiseSource(context) {
    if (this.#noiseSource) return;

    this.#noiseBuffer ??= createNoiseBuffer(context, this.#random);
    if (!this.#noiseBuffer) return;

    try {
      const source = context.createBufferSource();
      source.buffer = this.#noiseBuffer;
      source.loop = true;
      source.connect(this.#noiseHighpassNode ?? this.#noiseGain);
      source.start();
      this.#noiseSource = source;
    } catch (error) {
      logger.log("Noise source creation failed.", error);
    }
  }

  #startDynamicEffects(profile = null, playbackRate = this.#basePlaybackRate) {
    this.#stopDynamicEffects({ keepGraph: true, keepNoise: true });
    if (!profile?.enabled) return;

    const wow = clampNumber(profile.wowFlutter, 0, 1, 0);
    const toneWobble = clampNumber(profile.toneWobble, 0, 1, 0);
    const dropout = clampNumber(profile.dropout, 0, 1, 0);

    if (wow > 0) {
      this.#wowTimer = setInterval(() => {
        if (!this.playing) return;
        const swing = (this.#random() * 2 - 1) * wow * 0.095;
        this.#wowRateMultiplier = 1 + swing;
        this.#applyPlaybackRate();
      }, 280 + Math.round(this.#random() * 160));
    }

    if (toneWobble > 0 && this.#lowpassNode) {
      this.#toneTimer = setInterval(() => {
        if (!this.playing || !this.#lowpassNode) return;
        const context = this.#lowpassNode.context;
        const now = context.currentTime;
        const base = Number(profile.lowpass ?? 5000) || 5000;
        const swing = (this.#random() * 2 - 1) * toneWobble * 0.55;
        const target = Math.max(140, base * (1 + swing));
        this.#lowpassNode.frequency.setTargetAtTime(target, now, 0.35);
      }, 480 + Math.round(this.#random() * 520));
    }

    if (dropout > 0 && this.#dropoutGain) {
      const dropoutDepth = clampNumber(profile.dropoutDepth, 0, 0.995, 0.35);
      const dropoutHoldMs = clampNumber(profile.dropoutHoldMs, 0, 900, 80);

      this.#dropoutTimer = setInterval(() => {
        if (!this.playing || !this.#dropoutGain) return;
        if (this.#random() > dropout) return;

        const context = this.#dropoutGain.context;
        const now = context.currentTime;
        const targetGain = Math.max(0.001, 1 - dropoutDepth * (0.72 + this.#random() * 0.28));
        const hold = (dropoutHoldMs * (0.45 + this.#random() * 0.95)) / 1000;
        const attack = Math.max(0.004, Math.min(0.035, hold * 0.16));
        const release = Math.max(0.018, Math.min(0.22, hold * 0.42));

        this.#dropoutGain.gain.cancelScheduledValues(now);
        this.#dropoutGain.gain.setValueAtTime(this.#dropoutGain.gain.value || 1, now);
        this.#dropoutGain.gain.linearRampToValueAtTime(targetGain, now + attack);
        this.#dropoutGain.gain.setValueAtTime(targetGain, now + attack + hold);
        this.#dropoutGain.gain.linearRampToValueAtTime(1, now + attack + hold + release);
      }, 180);
    }
  }

  #stopDynamicEffects({ keepGraph = true, keepNoise = false } = {}) {
    if (this.#wowTimer) window.clearInterval(this.#wowTimer);
    if (this.#toneTimer) window.clearInterval(this.#toneTimer);
    if (this.#dropoutTimer) window.clearInterval(this.#dropoutTimer);
    if (this.#syncNudgeTimer) window.clearTimeout(this.#syncNudgeTimer);
    this.#wowTimer = null;
    this.#toneTimer = null;
    this.#dropoutTimer = null;
    this.#syncNudgeTimer = null;
    this.#wowRateMultiplier = 1;
    this.#syncRateMultiplier = 1;
    this.#applyPlaybackRate();

    if (!keepNoise && this.#noiseSource) {
      try {
        this.#noiseSource.stop();
      } catch (_error) {
        // Already stopped.
      }
      this.#noiseSource.disconnect?.();
      this.#noiseSource = null;
    }

    if (!keepGraph) {
      for (const node of [this.#sourceNode, this.#highpassNode, this.#lowpassNode, this.#dropoutGain, this.#saturationNode, this.#compressorNode, this.#masterGain, this.#noiseHighpassNode, this.#noiseLowpassNode, this.#noiseGain]) {
        try {
          node?.disconnect?.();
        } catch (_error) {
          // Already disconnected.
        }
      }
      this.#sourceNode = null;
      this.#highpassNode = null;
      this.#lowpassNode = null;
      this.#dropoutGain = null;
      this.#saturationNode = null;
      this.#compressorNode = null;
      this.#masterGain = null;
      this.#noiseHighpassNode = null;
      this.#noiseLowpassNode = null;
      this.#noiseGain = null;
      this.#graphReady = false;
    }
  }

  #applyPlaybackRate() {
    const base = Math.max(0.1, Number(this.#basePlaybackRate ?? 1) || 1);
    const wow = Number.isFinite(this.#wowRateMultiplier) ? this.#wowRateMultiplier : 1;
    const sync = Number.isFinite(this.#syncRateMultiplier) ? this.#syncRateMultiplier : 1;
    this.audio.playbackRate = Math.max(0.25, Math.min(4, base * wow * sync));
  }

  async #fadeElementVolume(targetVolume, durationMs, { isCurrent = () => true } = {}) {
    const duration = Math.max(0, Number(durationMs) || 0);
    const target = Math.min(1, Math.max(0, Number(targetVolume) || 0));
    const token = this.#fadeToken;
    if (duration <= 0) {
      if (token === this.#fadeToken && isCurrent() && !this.#destroyed) this.audio.volume = target;
      return;
    }

    const start = this.audio.volume;
    const startedAt = performance.now();

    await new Promise((resolve) => {
      const step = (now) => {
        if (token !== this.#fadeToken || !isCurrent() || this.#destroyed) {
          resolve();
          return;
        }
        const t = Math.min(1, (now - startedAt) / duration);
        this.audio.volume = start + (target - start) * easeInOut(t);
        if (t >= 1) resolve();
        else window.requestAnimationFrame(step);
      };
      window.requestAnimationFrame(step);
    });
  }
}

const saturationCurveCache = new Map();

function createSaturationCurve(amount = 0) {
  const drive = Math.max(0, Math.min(2, Number(amount) || 0));
  if (drive <= 0) return null;

  const cacheKey = Math.round(drive * 1000) / 1000;
  const cached = saturationCurveCache.get(cacheKey);
  if (cached) return cached;

  const samples = 2048;
  const curve = new Float32Array(samples);
  const k = 1 + drive * 38;

  for (let index = 0; index < samples; index += 1) {
    const x = (index * 2) / samples - 1;
    curve[index] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }

  if (saturationCurveCache.size >= 32) saturationCurveCache.delete(saturationCurveCache.keys().next().value);
  saturationCurveCache.set(cacheKey, curve);
  return curve;
}

function configureCompressor(node, amount = 0) {
  if (!node) return;
  const value = Math.max(0, Math.min(2, Number(amount) || 0));
  const now = node.context?.currentTime ?? 0;
  node.threshold?.setTargetAtTime?.(-18 - value * 16, now, 0.05);
  node.knee?.setTargetAtTime?.(18 - Math.min(value, 1.6) * 7, now, 0.05);
  node.ratio?.setTargetAtTime?.(2 + value * 7, now, 0.05);
  node.attack?.setTargetAtTime?.(0.004 + value * 0.014, now, 0.05);
  node.release?.setTargetAtTime?.(0.14 + value * 0.21, now, 0.05);
}

function configureNoiseTone(highpassNode, lowpassNode, { highpass = 100, lowpass = 5000 } = {}, now = 0) {
  const hp = Math.max(80, Number(highpass || 100) * 1.2);
  const lp = Math.max(260, Math.min(7200, Number(lowpass || 5000) * 0.82));
  highpassNode?.frequency?.setTargetAtTime?.(hp, now, 0.1);
  lowpassNode?.frequency?.setTargetAtTime?.(lp, now, 0.1);
}

function createNoiseBuffer(context, random = Math.random) {
  try {
    const sampleRate = context.sampleRate || 44100;
    const length = sampleRate * 2;
    const buffer = context.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) {
      const white = random() * 2 - 1;
      data[index] = white * 0.09;
    }
    return buffer;
  } catch (error) {
    logger.log("Could not create noise buffer.", error);
    return null;
  }
}

function createSeededRandom(seedValue = "cassette-deck") {
  const text = String(seedValue);
  let state = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    state ^= text.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  state >>>= 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
