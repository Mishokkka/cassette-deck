import { MODULE_ID } from "./constants.mjs";
import { CassetteSocket } from "./socket.mjs";
import { getWidget, openWidget, closeWidget, toggleWidget } from "../apps/cassette-widget.mjs";
import { getLibraryApp, openLibraryApp } from "../apps/cassette-library-app.mjs";
import { getPermissionsApp, openPermissionsApp } from "../apps/permissions-app.mjs";
import { getDiagnosticsApp, openDiagnosticsApp } from "../apps/diagnostics-app.mjs";
import {
  duplicateCassette,
  getCassettes,
  getVisibleCassetteById,
  importLibrary,
  previewLibraryImport,
  rollbackLibrary,
  moveCassette,
  normalizeLibrarySort,
  readVisibleLibrary,
  inspectLibrary
} from "../services/library-service.mjs";
import { AudioEngine } from "../services/audio-engine.mjs";
import { SyncService } from "../services/sync-service.mjs";
import { PreloadService } from "../services/preload-service.mjs";
import { exportDiagnostics, getDiagnosticsSummary, repairLibrary, resetDeckState, resetLocalAudio } from "../services/diagnostics-service.mjs";
import { runMigrations } from "./migration.mjs";

export function registerPublicApi() {
  const api = {
    openWidget,
    closeWidget,
    toggleWidget,
    getWidget,
    openLibrary: openLibraryApp,
    getLibraryApp,
    openPermissions: openPermissionsApp,
    getPermissionsApp,
    openDiagnostics: openDiagnosticsApp,
    getDiagnosticsApp,
    getLibrary: () => readVisibleLibrary(game.user),
    importLibrary,
    previewLibraryImport,
    rollbackLibrary,
    duplicateCassette,
    moveCassette,
    normalizeLibrarySort,
    inspectLibrary,
    getCassettes: () => getCassettes({ visibleTo: game.user }),
    getCassetteById: (cassetteId) => getVisibleCassetteById(cassetteId, game.user),
    getVisibleCassetteById: (cassetteId) => getVisibleCassetteById(cassetteId, game.user),
    pingGM: () => CassetteSocket.pingGM(),
    transport: (action, options = {}) => CassetteSocket.transport(action, options),
    requestSync: (options = {}) => SyncService.requestSync(options),
    broadcastSync: (options = {}) => SyncService.broadcastPulse(options),
    getSyncStatus: () => SyncService.getStatus(),
    getAudioRuntime: () => AudioEngine.getRuntimeState(),
    getPreloadState: () => PreloadService.getSummary(),
    preloadCurrent: (options = {}) => PreloadService.warmFromCurrentContext({ reason: "api", force: true, ...options }),
    clearPreloadCache: () => PreloadService.clear(),
    getDiagnostics: () => getDiagnosticsSummary(),
    exportDiagnostics: () => exportDiagnostics(),
    runMigrations: () => runMigrations(),
    resetLocalAudio: () => resetLocalAudio(),
    resetDeck: () => resetDeckState(),
    repairLibrary: (options = {}) => repairLibrary(options),
    socket: CassetteSocket,
    audio: AudioEngine,
    sync: SyncService,
    preload: PreloadService
  };

  game.cassetteDeck = api;

  const module = game.modules.get(MODULE_ID);
  if (module) module.api = api;
}
