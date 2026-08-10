import { MODULE_ID, SETTINGS } from "../core/constants.mjs";
import { logger } from "../core/logger.mjs";
import { AuthorityService } from "../core/authority.mjs";
import { CassetteSocket } from "../core/socket.mjs";
import { ensureAuthorityState, gmHandleNaturalEnd } from "./deck-service.mjs";
import { getDeckState } from "../core/settings.mjs";

export class SyncService {
  static #gmPulseTimer = null;
  static #endTimer = null;
  static #started = false;
  static #lastPulseAt = null;
  static #lastRequestAt = null;
  static #lastPulseResult = null;
  static #scheduledEnd = null;
  static #initialSyncTimer = null;

  static start() {
    this.stop();
    this.#started = true;
    this.refreshAuthority({ reason: "start" });
    this.#requestInitialSync();
    logger.log("Sync service started.", this.getStatus());
  }

  static stop() {
    if (this.#gmPulseTimer) window.clearInterval(this.#gmPulseTimer);
    if (this.#endTimer) window.clearTimeout(this.#endTimer);
    if (this.#initialSyncTimer) window.clearTimeout(this.#initialSyncTimer);
    this.#initialSyncTimer = null;
    this.#gmPulseTimer = null;
    this.#endTimer = null;
    this.#scheduledEnd = null;
    this.#started = false;
  }

  static refreshAuthority({ reason = "user-activity" } = {}) {
    if (!this.#started) return;
    if (this.#gmPulseTimer) window.clearInterval(this.#gmPulseTimer);
    this.#gmPulseTimer = null;
    if (!AuthorityService.isLocalAuthority) {
      if (this.#endTimer) window.clearTimeout(this.#endTimer);
      this.#endTimer = null;
      this.#scheduledEnd = null;
      return;
    }

    void ensureAuthorityState({ reason }).then((result) => {
      this.#scheduleNaturalEnd(result?.state ?? getDeckState());
      if (result?.command) return CassetteSocket.broadcastTransportCommand(result.command);
      return null;
    }).catch((error) => logger.warn("Authority claim failed.", error));
    this.#scheduleNaturalEnd(getDeckState());
    this.#startGmPulse();
  }

  static handleDeckStateChanged(deckState = {}) {
    if (!this.#started || !AuthorityService.isLocalAuthority) return;
    this.#scheduleNaturalEnd(deckState);
  }

  static getStatus() {
    return {
      started: this.#started,
      active: this.#started,
      authority: AuthorityService.getStatus(),
      gmPulseActive: Boolean(this.#gmPulseTimer),
      endTimerActive: Boolean(this.#endTimer),
      scheduledEnd: this.#scheduledEnd,
      intervalSeconds: this.#getPulseIntervalSeconds(),
      lastPulseAt: this.#lastPulseAt,
      lastRequestAt: this.#lastRequestAt,
      lastPulseResult: this.#lastPulseResult
    };
  }

  static async requestSync({ reason = "manual", notify = false } = {}) {
    this.#lastRequestAt = Date.now();
    const result = await CassetteSocket.requestSync({ reason });
    if (notify) {
      if (result?.ok) ui.notifications?.info?.("Cassette Deck: синхронизация выполнена.");
      else ui.notifications?.warn?.(`Cassette Deck: синхронизация не выполнена (${result?.reason ?? "unknown"}).`);
    }
    return result;
  }

  static async broadcastPulse({ reason = "pulse" } = {}) {
    if (!AuthorityService.isLocalAuthority) return null;
    this.#lastPulseAt = Date.now();
    this.#lastPulseResult = await CassetteSocket.broadcastCurrentSync({ reason });
    return this.#lastPulseResult;
  }

  static #requestInitialSync() {
    let enabled = true;
    try { enabled = game.settings.get(MODULE_ID, SETTINGS.autoSyncOnReady) !== false; } catch (_error) {}
    if (!enabled || this.#initialSyncTimer) return;
    this.#initialSyncTimer = window.setTimeout(() => {
      this.#initialSyncTimer = null;
      this.requestSync({ reason: "ready" }).catch((error) => logger.warn("Initial sync request failed.", error));
    }, 1000);
  }

  static #startGmPulse() {
    const intervalSeconds = this.#getPulseIntervalSeconds();
    if (!intervalSeconds) return;
    this.#gmPulseTimer = window.setInterval(() => {
      this.broadcastPulse({ reason: "pulse" }).catch((error) => logger.warn("Sync pulse failed.", error));
    }, intervalSeconds * 1000);
  }

  static #scheduleNaturalEnd(deckState = {}) {
    if (deckState.status !== "playing" || !Number.isFinite(Number(deckState.expectedEndAt))) {
      if (this.#endTimer) window.clearTimeout(this.#endTimer);
      this.#endTimer = null;
      this.#scheduledEnd = null;
      return;
    }

    const expectedEndAt = Number(deckState.expectedEndAt);
    const playbackSeq = Number(deckState.playbackSeq ?? 0);
    const nextSchedule = {
      expectedEndAt,
      playbackSeq,
      authorityEpoch: Number(deckState.authorityEpoch ?? 0),
      cassetteId: deckState.cassetteId,
      trackId: deckState.trackId,
      path: deckState.trackPath ?? null
    };
    const current = this.#scheduledEnd;
    if (this.#endTimer
      && current
      && Math.round(Number(current.expectedEndAt)) === Math.round(expectedEndAt)
      && Number(current.playbackSeq) === playbackSeq
      && Number(current.authorityEpoch ?? 0) === nextSchedule.authorityEpoch
      && current.cassetteId === nextSchedule.cassetteId
      && current.trackId === nextSchedule.trackId
      && (current.path ?? null) === nextSchedule.path) return;

    if (this.#endTimer) window.clearTimeout(this.#endTimer);
    this.#endTimer = null;
    const delay = Math.max(0, expectedEndAt - Date.now() + 120);
    this.#scheduledEnd = nextSchedule;
    this.#endTimer = window.setTimeout(async () => {
      this.#endTimer = null;
      try {
        const result = await gmHandleNaturalEnd({
          authoritativeTimer: true,
          playbackSeq,
          authorityEpoch: deckState.authorityEpoch,
          cassetteId: deckState.cassetteId,
          trackId: deckState.trackId,
          path: deckState.trackPath,
          duration: deckState.duration,
          endedAt: Date.now()
        });
        if (result?.command) await CassetteSocket.broadcastTransportCommand(result.command);
      } catch (error) {
        logger.warn("Authoritative natural-end timer failed.", error);
      }
    }, Math.min(delay, 2_147_000_000));
  }

  static #getPulseIntervalSeconds() {
    try {
      const value = Number(game.settings.get(MODULE_ID, SETTINGS.syncPulseInterval) ?? 10);
      if (!Number.isFinite(value) || value <= 0) return 0;
      return Math.max(5, Math.min(60, value));
    } catch (_error) {
      return 10;
    }
  }
}
