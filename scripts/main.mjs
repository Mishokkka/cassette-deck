import { MODULE_ID, SETTINGS } from "./core/constants.mjs";
import { logger } from "./core/logger.mjs";
import { registerSettings } from "./core/settings.mjs";
import { CassetteSocket } from "./core/socket.mjs";
import { registerPublicApi } from "./core/api.mjs";
import { registerHooks } from "./hooks.mjs";
import { runMigrations } from "./core/migration.mjs";
import { openWidget } from "./apps/cassette-widget.mjs";
import { SyncService } from "./services/sync-service.mjs";
import { PreloadService } from "./services/preload-service.mjs";

Hooks.once("init", () => {
  registerSettings();
  registerPublicApi();
  registerHooks();
  logger.info("Initialized.");
});

Hooks.once("socketlib.ready", () => {
  CassetteSocket.init();
});

Hooks.once("ready", async () => {
  CassetteSocket.init({ quiet: true });

  await runMigrations();

  const shouldAutoOpen = game.settings.get(MODULE_ID, SETTINGS.autoOpenWidget);
  if (shouldAutoOpen) await openWidget();

  SyncService.start();
  void PreloadService.warmFromCurrentContext({ reason: "ready" });

  logger.info("Ready.");
});
