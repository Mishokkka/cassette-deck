import { MODULE_TITLE, TEMPLATES } from "../core/constants.mjs";
import { logger } from "../core/logger.mjs";
import { PreloadService } from "../services/preload-service.mjs";
import {
  exportDiagnostics,
  getDiagnosticsSummary,
  repairLibrary,
  resetDeckState,
  resetLocalAudio
} from "../services/diagnostics-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

let diagnosticsAppInstance = null;

export class DiagnosticsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  #renderTimer = null;

  static DEFAULT_OPTIONS = {
    id: "cassette-deck-diagnostics",
    classes: ["cassette-deck", "cd-diagnostics-app"],
    tag: "section",
    window: {
      frame: true,
      title: "Cassette Deck: диагностика",
      icon: "fa-solid fa-stethoscope"
    },
    position: {
      width: 760,
      height: 640
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.diagnostics
    }
  };


  requestRender({ delay = 500 } = {}) {
    if (!this.rendered || this.#renderTimer !== null) return;
    this.#renderTimer = window.setTimeout(() => {
      this.#renderTimer = null;
      if (this.rendered) void this.render({ force: true });
    }, Math.max(0, Number(delay) || 0));
  }

  render(options = {}) {
    if (this.#renderTimer !== null) {
      window.clearTimeout(this.#renderTimer);
      this.#renderTimer = null;
    }
    return super.render(options);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const summary = getDiagnosticsSummary();
    const runtime = summary.runtime ?? {};
    const command = runtime.command ?? {};
    const socket = summary.socket ?? {};
    const deckState = summary.deckState ?? {};
    const libraryInspection = summary.library?.inspection ?? {};

    return {
      ...context,
      moduleTitle: MODULE_TITLE,
      summary,
      ok: summary.ok,
      issues: summary.issues ?? [],
      activeGmLabel: summary.activeGmLabel,
      moduleVersion: summary.module?.version ?? "unknown",
      foundryVersion: summary.module?.foundryVersion ?? "unknown",
      socketReadyLabel: socket.ready ? "готов" : "не готов",
      socketReadyClass: socket.ready ? "is-ok" : "is-bad",
      rawSocketLabel: socket.rawSocketRegistered ? "небезопасный legacy-канал активен" : "отключён",
      authorityLabel: socket.authority?.authorityName ?? socket.authority?.authorityUserId ?? "—",
      sessionReadyLabel: socket.sessionReady ? "готова" : "не готова",
      deckStatus: deckState.status ?? "unknown",
      deckSeq: deckState.seq ?? 0,
      deckPlaybackSeq: deckState.playbackSeq ?? 0,
      cassetteTitle: summary.selected?.cassetteTitle ?? "—",
      trackTitle: summary.selected?.trackTitle ?? "—",
      trackPath: summary.selected?.trackPath ?? "",
      audioEngine: runtime.engine ?? "—",
      audioPlaying: runtime.playing ? "да" : "нет",
      audioCurrentTime: this.#formatSeconds(runtime.currentTime),
      audioDuration: this.#formatSeconds(runtime.duration),
      audioError: runtime.error ?? "—",
      lastCommandAction: command.action ?? "—",
      lastCommandSeq: command.seq ?? "—",
      lastCommandPlaybackSeq: command.playbackSeq ?? "—",
      lastCommandDispatch: command.dispatchId ?? "—",
      preloadStrategy: summary.preload?.strategy ?? "—",
      preloadCache: `${summary.preload?.cacheSize ?? 0}/${summary.preload?.maxEntries ?? 0}`,
      preloadReady: summary.preload?.ready ?? 0,
      preloadErrors: summary.preload?.errors ?? 0,
      preloadTimeouts: summary.preload?.timeout ?? 0,
      preloadConcurrency: summary.preload?.concurrency ?? "—",
      preloadWarming: summary.preload?.warming ? "да" : "нет",
      preloadWarmAge: this.#formatMilliseconds(summary.preload?.warmAgeMs),
      preloadLastWarmDuration: this.#formatMilliseconds(summary.preload?.lastWarmSummary?.durationMs),
      preloadStats: summary.preload?.stats ?? {},
      syncStatus: summary.sync ?? {},
      libraryCassetteCount: summary.library?.cassetteCount ?? 0,
      libraryTrackCount: summary.library?.trackCount ?? 0,
      libraryIssueCount: libraryInspection.issueCount ?? 0,
      libraryIssues: (libraryInspection.issues ?? []).slice(0, 12),
      qaChecks: summary.qa?.checks ?? [],
      qaCounts: summary.qa?.counts ?? {},
      qaOk: Boolean(summary.qa?.ok),
      settings: summary.settings ?? {}
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.removeEventListener("click", this.#onActionClick);
    this.element.addEventListener("click", this.#onActionClick);
  }

  #onActionClick = async (event) => {
    const target = event.target?.closest?.("[data-action]");
    if (!target || !this.element?.contains?.(target)) return;
    event.preventDefault();
    const action = target?.dataset?.action;
    if (!action) return;

    try {
      switch (action) {
        case "refresh":
          return this.render({ force: true });
        case "export-diagnostics":
          exportDiagnostics();
          ui.notifications.info("Cassette Deck: диагностика экспортирована.");
          return;
        case "reset-local-audio":
          await resetLocalAudio();
          ui.notifications.info("Cassette Deck: локальный аудиодвижок сброшен.");
          return this.render({ force: true });
        case "clear-preload":
          PreloadService.clear();
          ui.notifications.info("Cassette Deck: preload cache очищен.");
          return this.render({ force: true });
        case "reset-deck":
          return this.#confirmAndResetDeck();
        case "repair-library":
          return this.#confirmAndRepairLibrary();
        default:
          logger.warn(`Unknown diagnostics action: ${action}`);
      }
    } catch (error) {
      logger.error("Diagnostics action failed.", error);
      ui.notifications.error(`Cassette Deck: ${error?.message ?? "ошибка диагностики"}`);
    }
  };

  async #confirmAndResetDeck() {
    const confirmed = await this.#confirm({
      title: "Сбросить проигрыватель",
      content: "Остановить воспроизведение у всех клиентов и извлечь текущую кассету?",
      yesLabel: "Сбросить",
      icon: "fa-solid fa-power-off"
    });
    if (!confirmed) return;

    await resetDeckState();
    ui.notifications.info("Cassette Deck: состояние проигрывателя сброшено.");
    await this.render({ force: true });
  }

  async #confirmAndRepairLibrary() {
    const confirmed = await this.#confirm({
      title: "Восстановить библиотеку",
      content: "Модуль нормализует структуру библиотеки, исправит дублирующиеся id и очистит небезопасные пути. Перед серьезной правкой лучше экспортировать JSON.",
      yesLabel: "Восстановить",
      icon: "fa-solid fa-screwdriver-wrench"
    });
    if (!confirmed) return;

    const result = await repairLibrary({ clearUnsafePaths: true, dedupeIds: true, normalizeSort: true });
    ui.notifications.info(`Cassette Deck: библиотека проверена, исправлений: ${result.fixCount ?? 0}.`);
    await this.render({ force: true });
  }

  async #confirm({ title, content, yesLabel, icon }) {
    const dialogApi = foundry.applications.api.DialogV2;
    if (dialogApi?.confirm) {
      return dialogApi.confirm({
        window: { title },
        content: `<p>${foundry.utils.escapeHTML(content)}</p>`,
        yes: { label: yesLabel, icon },
        no: { label: "Отмена" }
      });
    }
    return globalThis.confirm(content);
  }

  async _preClose(options) {
    if (this.#renderTimer !== null) window.clearTimeout(this.#renderTimer);
    this.#renderTimer = null;
    this.element?.removeEventListener?.("click", this.#onActionClick);
    if (diagnosticsAppInstance === this) diagnosticsAppInstance = null;
    await super._preClose?.(options);
  }

  #formatMilliseconds(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return "—";
    if (number < 1000) return `${Math.round(number)} мс.`;
    return `${(number / 1000).toFixed(2)} сек.`;
  }

  #formatSeconds(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return "—";
    return `${number.toFixed(2)} сек.`;
  }
}

export function getDiagnosticsApp() {
  return diagnosticsAppInstance;
}

export async function openDiagnosticsApp({ force = true } = {}) {
  if (!game.user.isGM) {
    ui.notifications.warn("Cassette Deck: диагностику может открывать только GM.");
    return null;
  }

  if (!diagnosticsAppInstance) diagnosticsAppInstance = new DiagnosticsApp();
  await diagnosticsAppInstance.render({ force: true });
  if (force) diagnosticsAppInstance.bringToFront();
  return diagnosticsAppInstance;
}
