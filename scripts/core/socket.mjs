import { MODULE_ID, SOCKETS } from "./constants.mjs";
import { logger } from "./logger.mjs";
import { formatErrorResult, codedError } from "./utils.mjs";
import { AuthorityService } from "./authority.mjs";
import { getDeckState } from "./settings.mjs";
import { estimateOffset, normalizePlaybackRate, validateCommandAgainstState } from "../models/deck-state.mjs";
import { gmCommitSync, gmHandleTransportRequest, gmSelectCassette } from "../services/deck-service.mjs";
import { AudioEngine } from "../services/audio-engine.mjs";

const SESSION_TTL_MS = 5 * 60_000;
const SESSION_WAIT_MS = 2500;
const APPLY_RETRY_COUNT = 6;
const APPLY_RETRY_MS = 80;

class CassetteSocketService {
  socket = null;
  ready = false;
  initialized = false;
  unavailableReason = "socket service is not ready";
  #registeredChannel = null;
  #sessionsByToken = new Map();
  #sessionTokenByUser = new Map();
  #localSession = null;
  #sessionWaiters = new Map();
  #sessionRequestPromise = null;
  #sessionRequestAuthorityId = null;
  #seenCommandIds = new Set();
  #seenCommandOrder = [];
  #lastBroadcastAt = null;
  #lastAppliedCommand = null;
  #rejectedCount = 0;

  getStatus() {
    return {
      ready: Boolean(this.ready && this.socket),
      initialized: this.initialized,
      unavailableReason: this.unavailableReason,
      socketlibActive: Boolean(game.modules.get("socketlib")?.active),
      socketlibApiAvailable: Boolean(globalThis.socketlib?.registerModule),
      authority: AuthorityService.getStatus(getDeckState()),
      sessionReady: Boolean(AuthorityService.isLocalAuthority || (this.#localSession?.expiresAt > Date.now() && this.#localSession?.authorityUserId === AuthorityService.authorityUserId)),
      localSession: this.#localSession ? { expiresAt: this.#localSession.expiresAt, authorityUserId: this.#localSession.authorityUserId } : null,
      authoritySessionCount: this.#sessionsByToken.size,
      seenCommandCount: this.#seenCommandIds.size,
      rejectedCount: this.#rejectedCount,
      lastBroadcastAt: this.#lastBroadcastAt,
      lastAppliedCommand: this.#lastAppliedCommand ? foundry.utils.deepClone(this.#lastAppliedCommand) : null,
      rawSocketRegistered: false,
      rawChannel: null
    };
  }

  init({ quiet = false } = {}) {
    if (this.ready && this.socket) return true;
    const socketlibModule = game.modules.get("socketlib");
    const socketlibApi = globalThis.socketlib;
    if (!socketlibModule?.active || !socketlibApi?.registerModule) {
      this.ready = false;
      this.initialized = true;
      this.unavailableReason = !socketlibModule?.active ? "socketlib module is not active" : "socketlib API is not available yet";
      if (!quiet) logger.warn(this.unavailableReason);
      return false;
    }

    try {
      const channel = this.#registeredChannel ?? socketlibApi.registerModule(MODULE_ID);
      if (!channel?.register) throw new Error("socketlib did not return a valid module channel");
      if (!this.#registeredChannel) {
        channel.register(SOCKETS.gmPing, this.#handleGmPing.bind(this));
        channel.register(SOCKETS.gmIssueSession, this.#handleGmIssueSession.bind(this));
        channel.register(SOCKETS.clientReceiveSession, this.#handleClientReceiveSession.bind(this));
        channel.register(SOCKETS.gmSelectCassette, this.#handleGmSelectCassette.bind(this));
        channel.register(SOCKETS.gmTransportRequest, this.#handleGmTransportRequest.bind(this));
        channel.register(SOCKETS.gmSyncRequest, this.#handleGmSyncRequest.bind(this));
        channel.register(SOCKETS.clientApplyTransport, this.#handleClientApplyTransport.bind(this));
        channel.register(SOCKETS.clientApplySyncPulse, this.#handleClientApplySyncPulse.bind(this));
        this.#registeredChannel = channel;
      }
      this.socket = channel;
      this.ready = true;
      this.initialized = true;
      this.unavailableReason = null;
      return true;
    } catch (error) {
      this.ready = false;
      this.initialized = true;
      this.unavailableReason = error?.message ?? "socketlib registration failed";
      logger.error("socketlib channel registration failed.", error);
      return false;
    }
  }

  async ensureReady({ timeoutMs = 2000 } = {}) {
    if (this.ready && this.socket) return true;
    if (this.init({ quiet: true })) return true;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await wait(100);
      if (this.init({ quiet: true })) return true;
    }
    return false;
  }

  async prepareSession({ quiet = true } = {}) {
    if (AuthorityService.isLocalAuthority) return { ok: true, localAuthority: true };
    const authorityUserId = AuthorityService.authorityUserId;
    if (!authorityUserId) return { ok: false, ignored: true, reason: "no active authority" };
    try {
      await this.ensureReady();
      if (!this.ready || !this.socket) return { ok: false, ignored: true, reason: this.unavailableReason ?? "socket service is not ready" };
      await this.#ensureSession(authorityUserId);
      return { ok: true, authorityUserId };
    } catch (error) {
      if (!quiet) logger.warn("Socket session preparation failed.", error);
      return formatErrorResult(error, "socket session preparation failed", "SOCKET_ERROR");
    }
  }

  async pingGM() {
    try {
      return await this.#callAuthority(SOCKETS.gmPing, {});
    } catch (error) {
      return formatErrorResult(error, "GM socket call failed", "SOCKET_ERROR");
    }
  }

  async selectCassette(cassetteId, trackId = null) {
    try {
      return await this.#callAuthority(SOCKETS.gmSelectCassette, { cassetteId, trackId });
    } catch (error) {
      return formatErrorResult(error, "GM cassette selection failed", "SOCKET_ERROR");
    }
  }

  async transport(action, options = {}) {
    try {
      return await this.#callAuthority(SOCKETS.gmTransportRequest, { ...options, action });
    } catch (error) {
      return formatErrorResult(error, "GM transport request failed", "SOCKET_ERROR");
    }
  }

  async requestSync({ reason = "manual" } = {}) {
    try {
      const result = await this.#callAuthority(SOCKETS.gmSyncRequest, { reason });
      if (result?.ok && result.command) await this.#handleClientApplyTransport(result.command);
      return result;
    } catch (error) {
      return formatErrorResult(error, "GM sync request failed", "SOCKET_ERROR");
    }
  }

  async broadcastCurrentSync({ reason = "pulse" } = {}) {
    if (!AuthorityService.isLocalAuthority) return { ok: true, ignored: true, reason: "not authority" };
    try {
      const state = getDeckState();
      if (state.status !== "playing") return { ok: true, ignored: true, reason: "playback inactive" };
      const targets = (game.users?.contents ?? []).filter((user) => user?.active && user.id !== game.user.id);
      if (!targets.length) return { ok: true, ignored: true, reason: "no remote clients" };

      const socketReady = await this.ensureReady({ timeoutMs: 500 });
      if (!socketReady || !this.socket) return this.#broadcastPersistentSyncFallback(reason);

      const deliveries = [];
      for (const user of targets) {
        const sessionToken = this.#getSessionTokenForUser(user.id, { extend: true });
        if (!sessionToken) return this.#broadcastPersistentSyncFallback(reason);
        deliveries.push({ userId: user.id, sessionToken });
      }

      const pulse = {
        commandId: foundry.utils.randomID(24),
        authorityUserId: AuthorityService.authorityUserId,
        authorityEpoch: Number(state.authorityEpoch ?? 0),
        revision: Number(state.revision ?? 0),
        seq: Number(state.seq ?? 0),
        playbackSeq: Number(state.playbackSeq ?? 0),
        issuedAt: Date.now(),
        reason: String(reason || "pulse")
      };

      this.#lastBroadcastAt = Date.now();
      const responses = await Promise.all(deliveries.map(({ userId, sessionToken }) =>
        this.socket.executeAsUser(SOCKETS.clientApplySyncPulse, userId, { ...pulse, sessionToken })
      ));
      if (responses.some((response) => !response?.ok)) return this.#broadcastPersistentSyncFallback(reason);

      const localResult = await this.#applySyncPulse(pulse);
      if (!localResult?.ok) return this.#broadcastPersistentSyncFallback(reason);
      return { ok: true, ephemeral: true, delivered: deliveries.length, pulse };
    } catch (error) {
      logger.warn("Ephemeral sync pulse failed; falling back to committed sync.", error);
      try {
        return await this.#broadcastPersistentSyncFallback(reason);
      } catch (fallbackError) {
        return formatErrorResult(fallbackError, "sync pulse failed", "SYNC_FAILED");
      }
    }
  }

  async applyAuthoritativeState(deckState = getDeckState()) {
    if (deckState?.status === "playing" && !AuthorityService.isLocalAuthority) void this.prepareSession();
    const command = deckState?.command;
    if (!command) return { ok: true, ignored: true, reason: "state has no command" };
    return this.#handleClientApplyTransport(command, { expectedState: deckState });
  }

  async broadcastTransportCommand(command = {}) {
    if (!AuthorityService.isLocalAuthority) throw codedError("Only the active authority may broadcast transport commands.", "AUTHORITY_MISMATCH");
    await this.ensureReady({ timeoutMs: 500 });
    this.#lastBroadcastAt = Date.now();
    const localPromise = this.#handleClientApplyTransport(command);
    if (this.ready && this.socket) {
      try {
        if (typeof this.socket.executeForOthers === "function") await this.socket.executeForOthers(SOCKETS.clientApplyTransport, command);
        else await this.socket.executeForEveryone(SOCKETS.clientApplyTransport, command);
      } catch (error) {
        logger.warn("Socket transport broadcast failed; world-state hook remains authoritative.", error);
      }
    }
    await localPromise;
    return { ok: true };
  }

  async #broadcastPersistentSyncFallback(reason = "pulse") {
    const result = await gmCommitSync({ requesterId: game.user.id, reason: `${reason}-committed` });
    if (result?.ok && result.command) await this.broadcastTransportCommand(result.command);
    return { ...result, fallback: true };
  }

  #getSessionTokenForUser(userId, { extend = false } = {}) {
    const id = String(userId || "");
    const token = this.#sessionTokenByUser.get(id);
    const session = token ? this.#sessionsByToken.get(token) : null;
    if (!token || !session || session.userId !== id || session.expiresAt <= Date.now() || !game.users.get(id)?.active) {
      if (token) this.#sessionsByToken.delete(token);
      if (this.#sessionTokenByUser.get(id) === token) this.#sessionTokenByUser.delete(id);
      return null;
    }
    if (extend) session.expiresAt = Date.now() + SESSION_TTL_MS;
    return token;
  }

  async #callAuthority(handler, payload) {
    const authorityUserId = AuthorityService.authorityUserId;
    if (!authorityUserId) throw codedError("No active GM is available.", "NO_ACTIVE_GM");

    // The authority GM remains able to control and persist the deck locally even
    // when socketlib is unavailable. Remote clients still require socketlib.
    if (AuthorityService.isLocalAuthority) {
      return this.#dispatchLocalAuthority(handler, { ...payload, requesterId: game.user.id });
    }

    await this.ensureReady();
    if (!this.ready || !this.socket) throw codedError(this.unavailableReason ?? "socket service is not ready", "SOCKET_UNAVAILABLE");
    const token = await this.#ensureSession(authorityUserId);
    return this.socket.executeAsUser(handler, authorityUserId, { ...payload, sessionToken: token });
  }

  async #dispatchLocalAuthority(handler, payload) {
    AuthorityService.assertLocalAuthority();
    switch (handler) {
      case SOCKETS.gmPing:
        return { ok: true, requesterId: game.user.id, authorityUserId: game.user.id, timestamp: Date.now() };
      case SOCKETS.gmSelectCassette: {
        const result = await gmSelectCassette({ requesterId: game.user.id, cassetteId: payload.cassetteId, trackId: payload.trackId ?? null });
        if (result?.command) await this.broadcastTransportCommand(result.command);
        return result;
      }
      case SOCKETS.gmTransportRequest: {
        const result = await gmHandleTransportRequest({ ...payload, requesterId: game.user.id });
        if (result?.command) await this.broadcastTransportCommand(result.command);
        return result;
      }
      case SOCKETS.gmSyncRequest: {
        const result = await gmCommitSync({ requesterId: game.user.id, reason: payload.reason ?? "manual" });
        if (result?.command) await this.broadcastTransportCommand(result.command);
        return result;
      }
      default:
        throw codedError(`Unsupported local authority handler: ${handler}`, "BAD_REQUEST");
    }
  }

  async #ensureSession(authorityUserId) {
    const now = Date.now();
    if (this.#localSession?.authorityUserId === authorityUserId && this.#localSession.expiresAt > now + 10_000) return this.#localSession.token;
    if (this.#sessionRequestPromise && this.#sessionRequestAuthorityId === authorityUserId) return this.#sessionRequestPromise;

    const requestId = foundry.utils.randomID(24);
    const waiterPromise = new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.#sessionWaiters.delete(requestId);
        reject(codedError("Timed out while establishing an authenticated socket session.", "SESSION_TIMEOUT"));
      }, SESSION_WAIT_MS);
      this.#sessionWaiters.set(requestId, { resolve, reject, timer });
    });

    const requestPromise = (async () => {
      try {
        await this.socket.executeAsUser(SOCKETS.gmIssueSession, authorityUserId, {
          requestedUserId: game.user.id,
          requestId
        });
        return await waiterPromise;
      } catch (error) {
        const waiter = this.#sessionWaiters.get(requestId);
        if (waiter) {
          window.clearTimeout(waiter.timer);
          this.#sessionWaiters.delete(requestId);
        }
        throw error;
      } finally {
        if (this.#sessionRequestAuthorityId === authorityUserId) {
          this.#sessionRequestPromise = null;
          this.#sessionRequestAuthorityId = null;
        }
      }
    })();

    this.#sessionRequestPromise = requestPromise;
    this.#sessionRequestAuthorityId = authorityUserId;
    return requestPromise;
  }

  async #handleGmIssueSession({ requestedUserId, requestId } = {}) {
    AuthorityService.assertLocalAuthority();
    const user = game.users.get(String(requestedUserId || ""));
    if (!user?.active) throw codedError("Requested user is not active.", "UNKNOWN_USER");
    const token = foundry.utils.randomID(48);
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const previousToken = this.#sessionTokenByUser.get(user.id);
    if (previousToken) this.#sessionsByToken.delete(previousToken);
    this.#sessionsByToken.set(token, { userId: user.id, expiresAt });
    this.#sessionTokenByUser.set(user.id, token);
    this.#pruneSessions();
    await this.socket.executeAsUser(SOCKETS.clientReceiveSession, user.id, {
      requestId,
      token,
      userId: user.id,
      authorityUserId: game.user.id,
      expiresAt
    });
    return { ok: true, delivered: true, expiresAt };
  }

  #handleClientReceiveSession(payload = {}) {
    if (payload.userId !== game.user.id) return { ok: false, reason: "session target mismatch" };
    if (payload.authorityUserId !== AuthorityService.authorityUserId) return { ok: false, reason: "session authority mismatch" };
    const waiter = this.#sessionWaiters.get(payload.requestId);
    if (!waiter) return { ok: false, reason: "unsolicited session response" };
    this.#localSession = { token: payload.token, expiresAt: Number(payload.expiresAt), authorityUserId: payload.authorityUserId };
    window.clearTimeout(waiter.timer);
    this.#sessionWaiters.delete(payload.requestId);
    waiter.resolve(payload.token);
    return { ok: true };
  }

  #authenticate(payload = {}) {
    AuthorityService.assertLocalAuthority();
    const token = String(payload.sessionToken || "");
    const session = this.#sessionsByToken.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      if (token) this.#sessionsByToken.delete(token);
      if (session?.userId && this.#sessionTokenByUser.get(session.userId) === token) this.#sessionTokenByUser.delete(session.userId);
      throw codedError("Socket session is missing or expired.", "SESSION_INVALID");
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session.userId;
  }

  #pruneSessions() {
    const now = Date.now();
    for (const [token, session] of this.#sessionsByToken.entries()) {
      if (session.expiresAt <= now || !game.users.get(session.userId)?.active) {
        this.#sessionsByToken.delete(token);
        if (this.#sessionTokenByUser.get(session.userId) === token) this.#sessionTokenByUser.delete(session.userId);
      }
    }
  }

  #handleGmPing(payload = {}) {
    const requesterId = this.#authenticate(payload);
    return { ok: true, requesterId, authorityUserId: game.user.id, timestamp: Date.now() };
  }

  async #handleGmSelectCassette(payload = {}) {
    const requesterId = this.#authenticate(payload);
    const result = await gmSelectCassette({ requesterId, cassetteId: payload.cassetteId, trackId: payload.trackId ?? null });
    if (result?.command) await this.broadcastTransportCommand(result.command);
    return result;
  }

  async #handleGmTransportRequest(payload = {}) {
    const requesterId = this.#authenticate(payload);
    const result = await gmHandleTransportRequest({ ...payload, sessionToken: undefined, requesterId });
    if (result?.command) await this.broadcastTransportCommand(result.command);
    return result;
  }

  async #handleGmSyncRequest(payload = {}) {
    const requesterId = this.#authenticate(payload);
    const result = await gmCommitSync({ requesterId, reason: payload.reason ?? "manual" });
    if (result?.command) await this.broadcastTransportCommand(result.command);
    return result;
  }

  async #handleClientApplySyncPulse(payload = {}) {
    const sessionToken = String(payload.sessionToken || "");
    const localSession = this.#localSession;
    if (!sessionToken || !localSession || sessionToken !== localSession.token) return this.#reject("sync pulse session mismatch");
    if (localSession.authorityUserId !== AuthorityService.authorityUserId) return this.#reject("sync pulse session authority mismatch");
    return this.#applySyncPulse(payload);
  }

  async #applySyncPulse(pulse = {}) {
    if (!pulse?.commandId) return this.#reject("sync pulse has no commandId");
    if (this.#seenCommandIds.has(pulse.commandId)) return { ok: true, ignored: true, reason: "duplicate sync pulse" };
    if (pulse.authorityUserId !== AuthorityService.authorityUserId) return this.#reject("sync pulse authority mismatch");

    const state = getDeckState();
    if (state.status !== "playing") return { ok: false, ignored: true, reason: "local playback state is inactive" };
    if (state.authorityUserId && state.authorityUserId !== pulse.authorityUserId) return this.#reject("sync pulse state authority mismatch");
    if (Number(pulse.authorityEpoch ?? 0) !== Number(state.authorityEpoch ?? 0)) return this.#reject("sync pulse authority epoch mismatch");
    if (Number(pulse.revision ?? 0) !== Number(state.revision ?? 0)) return this.#reject("sync pulse state revision mismatch");
    if (Number(pulse.seq ?? 0) !== Number(state.seq ?? 0)) return this.#reject("sync pulse sequence mismatch");
    if (Number(pulse.playbackSeq ?? 0) !== Number(state.playbackSeq ?? 0)) return this.#reject("sync pulse playback sequence mismatch");

    const issuedAt = Number(pulse.issuedAt ?? Date.now());
    if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > 30_000) return this.#reject("sync pulse timestamp is stale");

    const base = state.command && typeof state.command === "object" ? state.command : {};
    const command = {
      ...base,
      commandId: pulse.commandId,
      revision: Number(state.revision ?? 0),
      seq: Number(state.seq ?? 0),
      playbackSeq: Number(state.playbackSeq ?? 0),
      authorityEpoch: Number(state.authorityEpoch ?? 0),
      authorityUserId: pulse.authorityUserId,
      action: "sync",
      status: state.status,
      cassetteId: state.cassetteId ?? null,
      trackId: state.trackId ?? null,
      path: state.trackPath ?? null,
      duration: state.duration ?? null,
      offset: estimateOffset(state, issuedAt),
      volume: state.volume ?? 0.8,
      lidOpen: Boolean(state.lidOpen),
      issuedAt,
      controllerUserId: pulse.authorityUserId,
      playbackRate: normalizePlaybackRate(state.playbackRate),
      clickSfx: false,
      clickAction: "sync",
      fadeInMs: 0,
      fadeOutMs: 0,
      transportDelayMs: 0,
      shuttleFromOffset: null,
      shuttleToOffset: null,
      shuttleSourceTrackId: null,
      syncReason: String(pulse.reason || "pulse")
    };

    this.#rememberCommand(pulse.commandId);
    this.#lastAppliedCommand = foundry.utils.deepClone(command);
    Hooks.callAll("cassetteDeck.transportCommandReceived", foundry.utils.deepClone(command));
    return AudioEngine.applyTransportCommand(command);
  }

  async #handleClientApplyTransport(command = {}, { expectedState = null } = {}) {
    if (!command?.commandId) return this.#reject("transport command has no commandId");
    if (this.#seenCommandIds.has(command.commandId)) return { ok: true, ignored: true, reason: "duplicate command" };
    if (command.authorityUserId !== AuthorityService.authorityUserId) return this.#reject("transport authority mismatch");

    let state = expectedState ?? getDeckState();
    let validation = validateCommandAgainstState(command, state);
    for (let attempt = 0; !validation.ok && attempt < APPLY_RETRY_COUNT; attempt += 1) {
      await wait(APPLY_RETRY_MS);
      state = getDeckState();
      validation = validateCommandAgainstState(command, state);
    }
    if (!validation.ok) return this.#reject(`transport command rejected: ${validation.reason}`);

    const stateCommand = state?.command ?? null;
    const exactStateCommand = Boolean(
      stateCommand?.commandId
      && stateCommand.commandId === command.commandId
      && stableStringify(stateCommand) === stableStringify(command)
    );
    if (!exactStateCommand) return this.#reject("transport command does not exactly match the committed state command");

    this.#rememberCommand(command.commandId);
    this.#lastAppliedCommand = foundry.utils.deepClone(command);
    Hooks.callAll("cassetteDeck.transportCommandReceived", foundry.utils.deepClone(command));
    return AudioEngine.applyTransportCommand(command);
  }

  #reject(reason) {
    this.#rejectedCount += 1;
    logger.warn(reason);
    return { ok: false, ignored: true, reason };
  }

  #rememberCommand(commandId) {
    this.#seenCommandIds.add(commandId);
    this.#seenCommandOrder.push(commandId);
    while (this.#seenCommandOrder.length > 250) {
      const oldest = this.#seenCommandOrder.shift();
      this.#seenCommandIds.delete(oldest);
    }
  }

}

function stableStringify(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(
      Object.keys(entry)
        .filter((key) => entry[key] !== undefined)
        .sort()
        .map((key) => [key, normalize(entry[key])])
    );
  };
  try { return JSON.stringify(normalize(value)); }
  catch (_error) { return ""; }
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export const CassetteSocket = new CassetteSocketService();
