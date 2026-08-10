import { codedError } from "./utils.mjs";

const AUTHORITY_LEASE_MS = 20_000;

export class AuthorityService {
  static getActiveGms() {
    return game.users.contents
      .filter((user) => user.isGM && user.active)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  static get authorityUser() {
    return this.getActiveGms()[0] ?? null;
  }

  static get authorityUserId() {
    return this.authorityUser?.id ?? null;
  }

  static get isLocalAuthority() {
    return Boolean(game.user?.isGM && this.authorityUserId === game.user.id);
  }

  static assertLocalAuthority() {
    if (!game.user?.isGM) throw codedError("This operation requires a GM client.", "GM_ONLY");
    if (!this.isLocalAuthority) {
      throw codedError("This GM client is not the active Cassette Deck authority.", "AUTHORITY_MISMATCH");
    }
    return true;
  }

  static isStateAuthorityCurrent(deckState = {}) {
    const expected = this.authorityUserId;
    if (!expected) return false;
    if (deckState.authorityUserId && deckState.authorityUserId !== expected) return false;
    const heartbeatAt = Number(deckState.authorityHeartbeatAt ?? 0);
    if (!heartbeatAt) return true;
    return Date.now() - heartbeatAt <= AUTHORITY_LEASE_MS || this.isLocalAuthority;
  }

  static getStatus(deckState = null) {
    return {
      authorityUserId: this.authorityUserId,
      authorityName: this.authorityUser?.name ?? null,
      isLocalAuthority: this.isLocalAuthority,
      activeGms: this.getActiveGms().map((user) => ({ id: user.id, name: user.name })),
      stateAuthorityUserId: deckState?.authorityUserId ?? null,
      stateAuthorityEpoch: Number(deckState?.authorityEpoch ?? 0),
      stateHeartbeatAt: Number(deckState?.authorityHeartbeatAt ?? 0) || null,
      leaseMs: AUTHORITY_LEASE_MS
    };
  }
}
