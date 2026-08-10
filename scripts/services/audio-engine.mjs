import { HOOKS, MODULE_ID, MODULE_TITLE, SETTINGS } from "../core/constants.mjs";
import { logger } from "../core/logger.mjs";
import { EffectsService } from "./effects-service.mjs";
import { FoundrySoundHandle } from "./audio/foundry-sound-handle.mjs";
import { NativeAudioHandle } from "./audio/native-audio-handle.mjs";
import { commandMayMutatePlayback, makeCommandEpochContext, normalizeVolume } from "./audio/command-generation.mjs";
import { compareCommandOrder } from "../models/deck-state.mjs";

class CassetteAudioEngine {
  #handle = null;
  #path = null;
  #lastSeq = 0;
  #lastCommand = null;
  #lastPlaybackCommand = null;
  #lastError = null;
  #desiredVolume = null;
  #commandEpoch = 0;
  #lastOrderedCommand = null;
  #lastErrorNotice = { key: null, at: 0 };

  get lastSeq() {
    return this.#lastSeq;
  }

  get lastError() {
    return this.#lastError;
  }

  getRuntimeState() {
    return {
      path: this.#path,
      seq: this.#lastSeq,
      command: this.#lastCommand,
      playbackCommand: this.#lastPlaybackCommand,
      error: this.#lastError,
      playing: this.#handle?.playing ?? false,
      currentTime: this.#handle?.currentTime ?? 0,
      duration: this.#handle?.duration ?? null,
      volume: this.#handle?.volume ?? null,
      engine: this.#handle?.kind ?? null,
      effects: this.#handle?.effectsState ?? null
    };
  }

  async applyTransportCommand(command = {}) {
    const seq = Number(command.seq ?? 0);
    if (this.#lastCommand?.commandId && command.commandId === this.#lastCommand.commandId) {
      return { ok: true, ignored: true, reason: "duplicate command" };
    }
    if (this.#lastOrderedCommand) {
      const order = compareCommandOrder(command, this.#lastOrderedCommand);
      if (order < 0) {
        logger.log("Ignoring stale audio command.", command);
        return { ok: true, ignored: true, reason: "stale command" };
      }
      if (order === 0 && command.action !== "sync") {
        logger.warn("Ignoring conflicting audio command with an already-applied order tuple.", command);
        return { ok: false, ignored: true, reason: "conflicting command order" };
      }
    }

    const playbackMutating = commandMayMutatePlayback(command, {
      activePath: this.#path,
      hasActiveHandle: Boolean(this.#handle)
    });
    const epoch = playbackMutating ? ++this.#commandEpoch : this.#commandEpoch;
    const { isCurrent } = makeCommandEpochContext(epoch, () => this.#commandEpoch);

    const clonedCommand = foundry.utils.deepClone(command);
    this.#lastSeq = Math.max(this.#lastSeq, seq || this.#lastSeq);
    this.#lastCommand = clonedCommand;
    if (command.action !== "sync" || !this.#lastOrderedCommand) this.#lastOrderedCommand = clonedCommand;
    if (playbackMutating) this.#lastPlaybackCommand = clonedCommand;
    if (Number.isFinite(Number(command.volume))) {
      this.#desiredVolume = this.#normalizeOutputVolume(command.volume, command.volumeMultiplier ?? 1);
    }
    this.#lastError = null;

    try {
      switch (command.action) {
        case "play":
          this.#triggerTransportClick(command.clickAction || "play", command);
          if (!isCurrent()) return { ok: true, ignored: true, reason: "superseded command" };
          await this.play(command, { epoch, isCurrent });
          break;
        case "pause":
          if (!isCurrent()) return { ok: true, ignored: true, reason: "superseded command" };
          await this.pause(command, { epoch, isCurrent });
          this.#triggerTransportClick(command.clickAction || "pause", command);
          break;
        case "stop":
          if (!isCurrent()) return { ok: true, ignored: true, reason: "superseded command" };
          await this.stop(command, { epoch, isCurrent });
          this.#triggerTransportClick(command.clickAction || "stop", command);
          break;
        case "eject":
          if (!isCurrent()) return { ok: true, ignored: true, reason: "superseded command" };
          await this.stop(command, { epoch, isCurrent });
          this.#path = null;
          this.#triggerTransportClick(command.clickAction || "eject", command);
          break;
        case "open":
          if (!isCurrent()) return { ok: true, ignored: true, reason: "superseded command" };
          await this.stop(command, { epoch, isCurrent });
          this.#triggerTransportClick(command.clickAction || "open", command);
          break;
        case "closeLid":
        case "noop":
          this.#triggerTransportClick(command.clickAction || command.action || "click", command);
          break;
        case "seek":
          this.#triggerTransportClick(command.clickAction || "seek", command);
          Hooks.callAll(HOOKS.audioRuntimeChanged, this.getRuntimeState());
          if (!isCurrent()) return { ok: true, ignored: true, reason: "superseded command" };
          await this.#performShuttle({ command, epoch, isCurrent, mode: "play" });
          break;
        case "cue":
          this.#triggerTransportClick(command.clickAction || "seek", command);
          Hooks.callAll(HOOKS.audioRuntimeChanged, this.getRuntimeState());
          if (!isCurrent()) return { ok: true, ignored: true, reason: "superseded command" };
          await this.#performShuttle({ command, epoch, isCurrent, mode: "cue" });
          break;
        case "volume":
          await this.setVolume(command, { epoch, isCurrent });
          break;
        case "sync":
          await this.sync(command, { epoch, isCurrent });
          break;
        case "select":
          await this.stop({ ...command, fadeOutMs: 0 }, { epoch, isCurrent });
          this.#triggerTransportClick(command.clickAction || "select", command);
          break;
        default:
          logger.warn("Unknown audio command action.", command);
          return { ok: false, reason: `unknown command action: ${command.action}` };
      }

      if (!isCurrent()) return { ok: true, ignored: true, reason: "superseded command" };
      Hooks.callAll(HOOKS.audioRuntimeChanged, this.getRuntimeState());
      return { ok: true };
    } catch (error) {
      if (!isCurrent()) return { ok: true, ignored: true, reason: "superseded command" };
      this.#lastError = error?.message ?? "audio command failed";
      logger.error("Audio command failed.", error);
      Hooks.callAll(HOOKS.audioRuntimeChanged, this.getRuntimeState());

      this.#notifyAudioError(this.#lastError);
      return { ok: false, reason: this.#lastError };
    }
  }


  #triggerTransportClick(action = "click", command = {}) {
    if (command.clickSfx === false) return;
    void EffectsService.playTransportClick(action, { enabled: command.clickSfx }).catch((error) => {
      logger.log("Transport click SFX failed.", error);
    });
  }


  async play(command = {}, context = {}) {
    if (!command.path) throw new Error("audio command has no path");
    const isCurrent = context.isCurrent ?? (() => true);

    const offset = Math.max(0, Number(command.offset ?? 0) || 0);
    const playbackRate = Math.max(0.1, Number(command.playbackRate ?? 1) || 1);
    const fadeInMs = Math.max(0, Number(command.fadeInMs ?? 0) || 0);

    if (!isCurrent()) return { ok: true, ignored: true };

    if (!this.#handle || this.#path !== command.path) {
      const oldHandle = this.#handle;
      await this.#disposeHandle(oldHandle);
      if (!isCurrent()) return { ok: true, ignored: true };

      const nextHandle = await this.#createHandle(command.path);
      if (!isCurrent()) {
        await this.#disposeHandle(nextHandle);
        return { ok: true, ignored: true };
      }

      this.#handle = nextHandle;
      this.#path = command.path;
    }

    const activeHandle = this.#handle;
    const volume = this.#desiredVolume ?? this.#normalizeOutputVolume(command.volume ?? 0.8, command.volumeMultiplier ?? 1);
    const playOptions = {
      offset,
      volume,
      playbackRate,
      loop: Boolean(command.loop),
      fadeInMs,
      nativeEffects: command.nativeEffects ?? null,
      isCurrent
    };

    try {
      await activeHandle.play(playOptions);
      if (!isCurrent()) return { ok: true, ignored: true };
    } catch (error) {
      if (!isCurrent()) return { ok: true, ignored: true };
      if (activeHandle?.kind !== "foundry") throw error;
      logger.warn("Foundry Sound playback failed; retrying with native Audio.", error);
      await this.#disposeHandle(activeHandle);
      if (!isCurrent()) return { ok: true, ignored: true };
      const nativeHandle = new NativeAudioHandle(command.path, { onEnded: (event) => this.#handleEnded(nativeHandle, event) });
      this.#handle = nativeHandle;
      this.#path = command.path;
      await nativeHandle.play(playOptions);
    }

    return { ok: true };
  }

  async #performShuttle({ command = {}, epoch = 0, isCurrent = () => true, mode = "play" } = {}) {
    const delayMs = Math.max(0, Number(command.transportDelayMs ?? 0) || 0);
    const targetOffset = Math.max(0, Number(command.offset ?? 0) || 0);
    const previewToOffset = Number.isFinite(Number(command.shuttleToOffset))
      ? Math.max(0, Number(command.shuttleToOffset))
      : targetOffset;
    const fromOffset = Number.isFinite(Number(command.shuttleFromOffset))
      ? Math.max(0, Number(command.shuttleFromOffset))
      : Math.max(0, Number(this.#handle?.currentTime ?? previewToOffset) || 0);

    let previewed = false;
    if (this.#handle?.shuttlePreview && delayMs > 0) {
      try {
        const result = await this.#handle.shuttlePreview({
          fromOffset,
          toOffset: previewToOffset,
          durationMs: delayMs,
          volume: this.#desiredVolume ?? this.#normalizeOutputVolume(command.volume ?? 0.8, command.volumeMultiplier ?? 1),
          playbackRate: command.playbackRate ?? 1,
          isCurrent
        });
        previewed = Boolean(result?.ok && result.previewed);
      } catch (error) {
        logger.log("Shuttle preview failed; falling back to delayed seek.", error);
      }
    }

    if (!previewed) {
      if (this.#handle) {
        try {
          if (this.#handle.playing) await this.pause({ fadeOutMs: 0 }, { epoch, isCurrent });
        } catch (_error) {
          // If pause fails, the delayed seek will still restart from target offset.
        }
      }

      if (!isCurrent()) return { ok: true, ignored: true };
      if (delayMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        if (!isCurrent()) return { ok: true, ignored: true };
      }
    }

    if (mode === "cue") return this.cue(command, { epoch, isCurrent });
    return this.play({ ...command, action: "play", clickSfx: false }, { epoch, isCurrent });
  }

  async cue(command = {}, context = {}) {
    const isCurrent = context.isCurrent ?? (() => true);
    if (!command.path || !this.#handle || this.#path !== command.path) {
      return { ok: true, skipped: true, reason: "no matching active handle to cue" };
    }

    const offset = Math.max(0, Number(command.offset ?? 0) || 0);
    const volume = this.#normalizeOutputVolume(command.volume ?? this.#handle.volume ?? 0.8, command.volumeMultiplier ?? 1);
    await this.#handle.cue?.({ offset, volume, isCurrent });
    if (!isCurrent()) return { ok: true, ignored: true };
    return { ok: true };
  }

  async sync(command = {}, context = {}) {
    const isCurrent = context.isCurrent ?? (() => true);
    if (command.status !== "playing") {
      if (command.status === "paused" || command.action === "cue") await this.cue(command, context);
      else if (command.status === "stopped" || command.status === "idle" || command.action === "select") await this.stop({ ...command, fadeOutMs: 0 }, context);
      return { ok: true, skipped: true, status: command.status };
    }

    if (!command.path) return { ok: false, reason: "sync command has no path" };

    const playbackRate = Math.max(0.1, Number(command.playbackRate ?? 1) || 1);
    const issuedAt = Number(command.issuedAt ?? Date.now());
    const networkElapsed = Math.max(0, (Date.now() - issuedAt) / 1000);
    const expectedOffset = Math.max(0, (Number(command.offset ?? 0) || 0) + networkElapsed * playbackRate);

    if (!this.#handle || this.#path !== command.path || !this.#handle.playing) {
      await this.play({ ...command, offset: expectedOffset, fadeInMs: 0 }, context);
      return { ok: true, corrected: true, reason: "not playing or path changed" };
    }

    if (!isCurrent()) return { ok: true, ignored: true };

    const actualOffset = Number(this.#handle.currentTime ?? 0) || 0;
    const drift = actualOffset - expectedOffset;

    if (Math.abs(drift) > 2.0) {
      await this.play({ ...command, offset: expectedOffset, fadeInMs: 0, clickSfx: false }, context);
      logger.log("Audio drift hard-corrected.", { drift, expectedOffset, actualOffset });
      return { ok: true, corrected: true, mode: "hard", drift };
    }

    if (Math.abs(drift) > 0.75) {
      this.#handle.nudgeSync?.({ drift, playbackRate, durationMs: 2400 });
      logger.log("Audio drift soft-corrected.", { drift, expectedOffset, actualOffset });
      return { ok: true, corrected: true, mode: "soft", drift };
    }

    if (command.forceRefreshEffects) {
      await this.#handle.refreshEffects?.({
        playbackRate,
        nativeEffects: command.nativeEffects ?? null
      });
    }

    logger.log("Audio sync pulse accepted.", { drift, expectedOffset, actualOffset });
    return { ok: true, corrected: false, drift };
  }

  async pause(command = {}, context = {}) {
    const handle = this.#handle;
    if (!handle) return;
    await handle.pause({ fadeOutMs: Math.max(0, Number(command.fadeOutMs ?? 0) || 0), isCurrent: context.isCurrent });
  }

  async stop(command = {}, context = {}) {
    const handle = this.#handle;
    if (!handle) return;
    await handle.stop({ fadeOutMs: Math.max(0, Number(command.fadeOutMs ?? 0) || 0), isCurrent: context.isCurrent });
  }

  async setVolume(command = {}, context = {}) {
    if (!this.#handle) return { ok: true, skipped: true, reason: "no active audio handle" };
    const isCurrent = context.isCurrent ?? (() => true);
    if (!isCurrent()) return { ok: true, ignored: true };
    const volume = this.#normalizeOutputVolume(command.volume ?? this.#handle.volume ?? 0.8, command.volumeMultiplier ?? 1);
    this.#handle.setVolume?.(volume);
    return { ok: true, volume };
  }

  previewVolume(volume = 0.8) {
    if (!this.#handle) return { ok: true, skipped: true, reason: "no active audio handle" };
    const normalized = this.#normalizeOutputVolume(volume, 1);
    this.#handle.setVolume?.(normalized);
    return { ok: true, volume: normalized };
  }

  refreshPersonalVolume() {
    const command = this.#lastCommand ?? this.#lastPlaybackCommand ?? {};
    if (!this.#handle) return { ok: true, skipped: true };
    const volume = this.#normalizeOutputVolume(command.volume ?? 0.8, command.volumeMultiplier ?? 1);
    this.#desiredVolume = volume;
    this.#handle.setVolume?.(volume);
    Hooks.callAll(HOOKS.audioRuntimeChanged, this.getRuntimeState());
    return { ok: true, volume };
  }

  #normalizeOutputVolume(volume, multiplier = 1) {
    let personalVolume = 1;
    let muted = false;
    try {
      personalVolume = Number(game.settings.get(MODULE_ID, SETTINGS.personalVolume) ?? 1);
      muted = Boolean(game.settings.get(MODULE_ID, SETTINGS.personalMute));
    } catch (_error) {}
    return muted ? 0 : normalizeVolume(volume, Number(multiplier ?? 1) * (Number.isFinite(personalVolume) ? personalVolume : 1));
  }

  #notifyAudioError(message) {
    const key = String(message || "audio command failed");
    const now = Date.now();
    if (this.#lastErrorNotice.key === key && now - this.#lastErrorNotice.at < 8000) return;
    this.#lastErrorNotice = { key, at: now };
    ui.notifications?.warn?.(`${MODULE_TITLE}: звук не запустился (${key}).`);
  }

  async unload() {
    this.#commandEpoch += 1;
    await this.#disposeHandle(this.#handle);
    this.#path = null;
    await NativeAudioHandle.closeSharedContext?.();
  }

  async #disposeHandle(handle = this.#handle) {
    if (!handle) return;
    try {
      await handle.stop?.({ fadeOutMs: 0 });
      handle.destroy?.();
    } catch (error) {
      logger.warn("Audio handle disposal failed.", error);
    } finally {
      if (this.#handle === handle) {
        this.#handle = null;
        this.#path = null;
      }
    }
  }

  async #createHandle(path) {
    const mode = this.#getAudioEngineMode();
    if (mode === "foundry") {
      const foundryHandle = await this.#tryCreateFoundrySound(path);
      if (foundryHandle) return foundryHandle;
    }
    let handle = null;
    handle = new NativeAudioHandle(path, { onEnded: (event) => this.#handleEnded(handle, event) });
    return handle;
  }

  #handleEnded(handle, event = {}) {
    if (!handle || this.#handle !== handle) return;
    const command = this.#lastPlaybackCommand ?? {};
    if (command.status !== "playing") return;

    Hooks.callAll(HOOKS.audioTrackEnded, {
      seq: Number(command.seq ?? this.#lastSeq ?? 0),
      playbackSeq: Number(command.playbackSeq ?? command.seq ?? this.#lastSeq ?? 0),
      authorityEpoch: Number(command.authorityEpoch ?? 0),
      commandId: command.commandId ?? null,
      cassetteId: command.cassetteId ?? null,
      trackId: command.trackId ?? null,
      path: command.path ?? this.#path ?? event.path ?? null,
      currentTime: event.currentTime ?? handle.currentTime ?? 0,
      duration: event.duration ?? handle.duration ?? null,
      endedAt: Date.now()
    });
  }


  #getAudioEngineMode() {
    try {
      return game.settings.get(MODULE_ID, SETTINGS.audioEngine) || "native";
    } catch (_error) {
      return "native";
    }
  }

  async #tryCreateFoundrySound(path) {
    const SoundClass = foundry.audio?.Sound;
    if (!SoundClass) return null;

    try {
      let sound = null;
      if (typeof SoundClass.create === "function") {
        sound = await SoundClass.create(path);
      }
      if (!sound) sound = new SoundClass(path);
      return new FoundrySoundHandle(sound, path);
    } catch (error) {
      logger.warn("Foundry Sound handle creation failed; falling back to native Audio.", error);
      return null;
    }
  }
}

export const AudioEngine = new CassetteAudioEngine();
