import { HOOKS } from "./core/constants.mjs";
import { AuthorityService } from "./core/authority.mjs";
import { logger } from "./core/logger.mjs";
import { canOpenWidget } from "./core/permissions.mjs";
import { CassetteSocket } from "./core/socket.mjs";
import { closeWidget, getWidget } from "./apps/cassette-widget.mjs";
import { getLibraryApp } from "./apps/cassette-library-app.mjs";
import { getPermissionsApp } from "./apps/permissions-app.mjs";
import { getDiagnosticsApp } from "./apps/diagnostics-app.mjs";
import { PreloadService } from "./services/preload-service.mjs";
import { gmHandleNaturalEnd, gmReconcileDeckStateWithLibrary } from "./services/deck-service.mjs";
import { invalidateLibraryCache } from "./services/library-service.mjs";
import { SyncService } from "./services/sync-service.mjs";
import { AudioEngine } from "./services/audio-engine.mjs";
import { isMigrationInProgress } from "./core/migration.mjs";

let lastDeckState = null;

function rerenderIfRendered(app) {
  if (!app?.rendered) return;
  if (typeof app.requestRender === "function") app.requestRender();
  else app.render({ force: true });
}

async function broadcastResult(result, label) {
  if (!result?.ok || !result.command) return;
  try {
    await CassetteSocket.broadcastTransportCommand(result.command);
  } catch (error) {
    logger.warn(`${label} transport broadcast failed.`, error);
  }
}

export function registerHooks() {
  Hooks.on(HOOKS.libraryChanged, () => {
    invalidateLibraryCache();
    getWidget()?.invalidatePreloadWarmKey?.();
    PreloadService.invalidateWarm("library-changed");
    void PreloadService.warmFromCurrentContext({ reason: "library-changed" });
    if (AuthorityService.isLocalAuthority && !isMigrationInProgress()) {
      void gmReconcileDeckStateWithLibrary({ reason: "library-changed" })
        .then((result) => broadcastResult(result, "Library reconciliation"))
        .catch((error) => logger.warn("Library reconciliation failed.", error));
    }
    rerenderIfRendered(getWidget());
    getLibraryApp()?.handleExternalLibraryChange?.();
    rerenderIfRendered(getDiagnosticsApp());
  });

  Hooks.on(HOOKS.deckStateChanged, (deckState) => {
    if (!isMigrationInProgress()) {
      void CassetteSocket.applyAuthoritativeState(deckState).catch((error) => logger.warn("Authoritative state apply failed.", error));
      SyncService.handleDeckStateChanged(deckState);
    }
    const widget = getWidget();
    const shouldRerenderWidget = widget?.cacheDeckState?.(deckState) !== false;
    const preloadContextChanged = !lastDeckState
      || lastDeckState.cassetteId !== deckState?.cassetteId
      || lastDeckState.trackId !== deckState?.trackId
      || lastDeckState.trackPath !== deckState?.trackPath;
    lastDeckState = foundry.utils.deepClone(deckState ?? {});
    if (preloadContextChanged) {
      widget?.invalidatePreloadWarmKey?.();
      PreloadService.invalidateWarm("deck-state-track-changed");
      void PreloadService.warmFromCurrentContext({ reason: "deck-state-track-changed" });
    }
    if (shouldRerenderWidget) rerenderIfRendered(widget);
    rerenderIfRendered(getDiagnosticsApp());
  });

  Hooks.on(HOOKS.permissionsChanged, () => {
    const widget = getWidget();
    if (widget?.rendered && !canOpenWidget(game.user)) void closeWidget();
    else rerenderIfRendered(widget);
    rerenderIfRendered(getPermissionsApp());
    rerenderIfRendered(getDiagnosticsApp());
  });

  Hooks.on(HOOKS.audioRuntimeChanged, (runtime = {}) => {
    if (runtime?.personalVolumeChanged) AudioEngine.refreshPersonalVolume?.();
    const widget = getWidget();
    rerenderIfRendered(getDiagnosticsApp());
    if (!widget?.rendered) return;

    const action = runtime?.command?.action;
    if (action && action !== "sync") {
      void widget.refreshFromTransportCommand?.(runtime.command);
    }
  });

  Hooks.on(HOOKS.audioTrackEnded, (payload = {}) => {
    if (!AuthorityService.isLocalAuthority) return;
    void gmHandleNaturalEnd(payload)
      .then((result) => broadcastResult(result, "Natural end"))
      .catch((error) => logger.warn("Natural end handling failed.", error));
  });


  Hooks.on("updateUser", () => {
    SyncService.refreshAuthority({ reason: "user-activity" });
  });

  Hooks.on("deleteUser", () => {
    SyncService.refreshAuthority({ reason: "user-deleted" });
  });

  logger.log("Hooks registered.");
}
