export const MODULE_ID = "cassette-deck";
export const MODULE_TITLE = "Cassette Deck";

export const MODULE_PATH = `modules/${MODULE_ID}`;

export const TEMPLATES = {
  widget: `${MODULE_PATH}/templates/widget/widget.hbs`,
  library: `${MODULE_PATH}/templates/gm/library.hbs`,
  permissions: `${MODULE_PATH}/templates/gm/permissions.hbs`,
  diagnostics: `${MODULE_PATH}/templates/gm/diagnostics.hbs`,
  buttonSfx: `${MODULE_PATH}/templates/gm/button-sfx.hbs`
};

export const SETTINGS = {
  debug: "debug",
  autoOpenWidget: "autoOpenWidget",
  audioEngine: "audioEngine",
  autoSyncOnReady: "autoSyncOnReady",
  syncPulseInterval: "syncPulseInterval",
  effectsEnabled: "effectsEnabled",
  deckClickSfx: "deckClickSfx",
  transportSfx: "transportSfx",
  transportSfxMenu: "transportSfxMenu",
  fadeMs: "fadeMs",
  preloadStrategy: "preloadStrategy",
  preloadNextTrack: "preloadNextTrack",
  preloadMaxEntries: "preloadMaxEntries",
  preloadConcurrency: "preloadConcurrency",
  widgetSkin: "widgetSkin",
  widgetState: "widgetState",
  playerLayoutOverride: "playerLayoutOverride",
  library: "library",
  deckState: "deckState",
  permissions: "permissions",
  personalVolume: "personalVolume",
  personalMute: "personalMute",
  migrationVersion: "migrationVersion",
  migrationBackup: "migrationBackup"
};

export const SOCKETS = {
  gmPing: "gmPing",
  gmSelectCassette: "gmSelectCassette",
  gmTransportRequest: "gmTransportRequest",
  gmSyncRequest: "gmSyncRequest",
  gmWriteLibrary: "gmWriteLibrary",
  clientApplyTransport: "clientApplyTransport",
  clientApplySyncPulse: "clientApplySyncPulse",
  gmIssueSession: "gmIssueSession",
  clientReceiveSession: "clientReceiveSession"
};

export const HOOKS = {
  libraryChanged: "cassetteDeck.libraryChanged",
  deckStateChanged: "cassetteDeck.deckStateChanged",
  permissionsChanged: "cassetteDeck.permissionsChanged",
  widgetStateChanged: "cassetteDeck.widgetStateChanged",
  audioRuntimeChanged: "cassetteDeck.audioRuntimeChanged",
  audioTrackEnded: "cassetteDeck.audioTrackEnded",
  transportCommandReceived: "cassetteDeck.transportCommandReceived"
};

export const SCHEMA_VERSIONS = Object.freeze({
  library: 4,
  deckState: 6,
  permissions: 3,
  widgetState: 4
});

export const DEFAULT_WIDGET_STATE = Object.freeze({
  lastKnownPosition: null,
  lastKnownSize: null,
  browserOpen: false,
  diagnostics: false,
  debugOverlay: false,
  calibrationMode: false
});

export const DEFAULT_LIBRARY = Object.freeze({
  schemaVersion: SCHEMA_VERSIONS.library,
  revision: 0,
  updatedAt: null,
  cassettes: []
});
export const DEFAULT_TRANSPORT_SFX = Object.freeze({
  volume: 0.7,
  fallbackSynth: true,
  actions: {
    play: "",
    pause: "",
    stop: "",
    seekBackward: "",
    seekForward: "",
    previous: "",
    next: "",
    open: "",
    closeLid: "",
    eject: "",
    select: ""
  }
});


export const DEFAULT_DECK_STATE = Object.freeze({
  schemaVersion: SCHEMA_VERSIONS.deckState,
  revision: 0,
  seq: 0,
  playbackSeq: 0,
  authorityEpoch: 0,
  authorityUserId: null,
  authorityHeartbeatAt: null,
  command: null,
  status: "idle",
  cassetteId: null,
  trackId: null,
  trackPath: null,
  startedAt: null,
  pausedAt: null,
  offset: 0,
  playbackRate: 1,
  duration: null,
  expectedEndAt: null,
  volume: 0.8,
  lidOpen: false
});

export const DEFAULT_PERMISSIONS = Object.freeze({
  schemaVersion: SCHEMA_VERSIONS.permissions,
  defaultPlayer: {
    openWidget: true,
    browseUnlocked: true,
    selectCassette: true,
    play: false,
    pause: false,
    stop: false,
    seek: false,
    next: false,
    previous: false,
    eject: false,
    volume: false
  },
  users: {}
});
