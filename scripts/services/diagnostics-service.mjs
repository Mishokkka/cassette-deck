import { MODULE_ID, SETTINGS } from "../core/constants.mjs";
import { getDeckState, getSetting } from "../core/settings.mjs";
import { codedError } from "../core/utils.mjs";
import { saveJsonFile } from "../core/file-utils.mjs";
import { canOpenWidget } from "../core/permissions.mjs";
import { isSafeAudioPath } from "../models/validators.mjs";
import { CassetteSocket } from "../core/socket.mjs";
import { AudioEngine } from "./audio-engine.mjs";
import { PreloadService } from "./preload-service.mjs";
import { SyncService } from "./sync-service.mjs";
import { inspectLibrary, readLibrary, repairLibrary as repairLibraryState } from "./library-service.mjs";

function getModuleVersion() {
  return game.modules.get(MODULE_ID)?.version ?? "unknown";
}

function getActiveGms() {
  return game.users.contents
    .filter((user) => user.isGM)
    .map((user) => ({
      id: user.id,
      name: user.name,
      active: Boolean(user.active),
      current: user.id === game.user.id
    }));
}

function getSelectedLabels(deckState = getDeckState(), library = readLibrary()) {
  const cassette = library.cassettes.find((item) => item.id === deckState.cassetteId) ?? null;
  const track = cassette?.tracks?.find((item) => item.id === deckState.trackId) ?? null;
  return {
    cassetteTitle: cassette?.title ?? "—",
    trackTitle: track?.title ?? "—",
    trackPath: track?.path ?? ""
  };
}

export function getDiagnosticsSummary() {
  const deckState = getDeckState();
  const library = readLibrary();
  const runtime = AudioEngine.getRuntimeState();
  const preload = PreloadService.getSummary();
  const sync = SyncService.getStatus();
  const socket = CassetteSocket.getStatus?.() ?? {
    ready: CassetteSocket.ready,
    unavailableReason: CassetteSocket.unavailableReason ?? null
  };
  const activeGms = getActiveGms();
  const libraryInspection = inspectLibrary();
  const selected = getSelectedLabels(deckState, library);

  const issues = [];
  if (!activeGms.some((gm) => gm.active)) issues.push("Нет активного GM-клиента. Игроки не смогут отправлять GM-authoritative команды.");
  if (!socket.ready) issues.push(`Socket не готов: ${socket.unavailableReason ?? "unknown"}.`);
  if (libraryInspection.issueCount > 0) issues.push(`В библиотеке найдено проблем: ${libraryInspection.issueCount}.`);
  if (runtime.error) issues.push(`Последняя ошибка аудио: ${runtime.error}.`);

  const summary = {
    module: {
      id: MODULE_ID,
      version: getModuleVersion(),
      foundryVersion: game.version ?? game.data?.version ?? "unknown"
    },
    now: Date.now(),
    isGM: Boolean(game.user?.isGM),
    currentUser: {
      id: game.user?.id ?? null,
      name: game.user?.name ?? "unknown",
      isGM: Boolean(game.user?.isGM)
    },
    activeGms,
    activeGmLabel: activeGms.filter((gm) => gm.active).map((gm) => gm.name).join(", ") || "нет активного GM",
    socket,
    deckState,
    selected,
    runtime,
    preload,
    sync,
    library: {
      cassetteCount: library.cassettes.length,
      trackCount: library.cassettes.reduce((total, cassette) => total + (cassette.tracks?.length ?? 0), 0),
      inspection: libraryInspection
    },
    settings: {
      audioEngine: safeGetSetting(SETTINGS.audioEngine),
      syncPulseInterval: safeGetSetting(SETTINGS.syncPulseInterval),
      preloadStrategy: safeGetSetting(SETTINGS.preloadStrategy),
      preloadConcurrency: safeGetSetting(SETTINGS.preloadConcurrency),
      effectsEnabled: safeGetSetting(SETTINGS.effectsEnabled),
      clickSfx: safeGetSetting(SETTINGS.deckClickSfx)
    },
    issues,
    ok: issues.length === 0
  };

  summary.qa = buildQaChecks(summary, library);
  return summary;
}

function safeGetSetting(key) {
  try {
    return getSetting(key);
  } catch (_error) {
    return null;
  }
}

function qaCheck(id, label, status, details = "") {
  return { id, label, status, details };
}

function buildQaChecks(summary, library) {
  const checks = [];
  const activeGmCount = (summary.activeGms ?? []).filter((gm) => gm.active).length;
  const socket = summary.socket ?? {};
  const deckState = summary.deckState ?? {};
  const selectedCassette = library.cassettes.find((cassette) => cassette.id === deckState.cassetteId) ?? null;
  const selectedTrack = selectedCassette?.tracks?.find((track) => track.id === deckState.trackId) ?? null;
  const tracks = library.cassettes.flatMap((cassette) => (cassette.tracks ?? []).map((track) => ({ cassette, track })));
  const unsafeTrackCount = tracks.filter(({ track }) => track.path && !isSafeAudioPath(track.path, { allowRemote: false })).length;
  const unknownDurationCount = tracks.filter(({ track }) => track.path && !Number.isFinite(Number(track.duration)) && PreloadService.getCachedDuration(track.path) === null).length;
  const longLibrary = library.cassettes.length >= 50 || tracks.length >= 150;

  checks.push(qaCheck(
    "active-gm",
    "Активный GM-клиент",
    activeGmCount > 0 ? "pass" : "fail",
    activeGmCount > 0 ? `Активных GM: ${activeGmCount}.` : "Игроки не смогут отправлять transport-запросы без активного GM."
  ));

  checks.push(qaCheck(
    "socketlib",
    "socketlib канал",
    socket.ready ? "pass" : "warn",
    socket.ready ? "GM-authoritative команды доступны." : `socketlib не готов: ${socket.unavailableReason ?? "unknown"}. GM сможет управлять локально, игроки — нет.`
  ));

  checks.push(qaCheck(
    "authenticated-socket",
    "Авторизованный transport-канал",
    socket.ready && socket.rawSocketRegistered !== true ? "pass" : "warn",
    socket.ready && socket.rawSocketRegistered !== true
      ? "Команды идут через единый socketlib-канал с сессионной проверкой; небезопасный raw socket отключён."
      : "Проверь состояние socketlib и отсутствие legacy raw socket."
  ));

  checks.push(qaCheck(
    "current-user-widget",
    "Доступ текущего пользователя к виджету",
    canOpenWidget(game.user) ? "pass" : "info",
    canOpenWidget(game.user) ? "Виджет может открыться на этом клиенте." : "Для этого пользователя виджет будет тихо скрыт."
  ));

  checks.push(qaCheck(
    "library-integrity",
    "Целостность библиотеки",
    summary.library?.inspection?.issueCount > 0 ? "fail" : "pass",
    summary.library?.inspection?.issueCount > 0 ? `Проблем: ${summary.library.inspection.issueCount}. Запусти мягкое восстановление или проверь JSON.` : "Дубликатов id и небезопасных путей не найдено."
  ));

  checks.push(qaCheck(
    "unsafe-paths",
    "Безопасность audio paths",
    unsafeTrackCount > 0 ? "fail" : "pass",
    unsafeTrackCount > 0 ? `Небезопасных путей: ${unsafeTrackCount}.` : "Все заполненные пути проходят whitelist расширений и не содержат '..'."
  ));

  checks.push(qaCheck(
    "deck-selection",
    "Текущее состояние проигрывателя",
    deckState.cassetteId && !selectedCassette ? "fail" : (deckState.trackId && !selectedTrack ? "fail" : "pass"),
    deckState.cassetteId && !selectedCassette
      ? "deckState ссылается на несуществующую кассету."
      : deckState.trackId && !selectedTrack
        ? "deckState ссылается на несуществующую дорожку."
        : "Выбранная кассета/дорожка согласованы с библиотекой."
  ));

  checks.push(qaCheck(
    "preload-size",
    "Большая библиотека",
    longLibrary ? "warn" : "pass",
    longLibrary ? `Кассет: ${library.cassettes.length}, дорожек: ${tracks.length}. Лучше держать preload strategy не выше 'cassette'.` : `Кассет: ${library.cassettes.length}, дорожек: ${tracks.length}.`
  ));

  checks.push(qaCheck(
    "durations",
    "Metadata длительности",
    unknownDurationCount > 0 ? "info" : "pass",
    unknownDurationCount > 0 ? `У дорожек с путями без сохраненной duration: ${unknownDurationCount}. Это нормально, если metadata еще не прогревалась.` : "У всех дорожек с путями есть сохраненная duration или cache."
  ));

  checks.push(qaCheck(
    "manual-multiclient",
    "Ручной тест: GM + игрок-контроллер + наблюдатель",
    "manual",
    "Запусти трек, сделай pause/seek/stop с GM и игрока-контроллера. Наблюдатель должен слышать изменения сразу, без ожидания 10 секунд."
  ));

  checks.push(qaCheck(
    "manual-reload",
    "Ручной тест: reload посреди трека",
    "manual",
    "Обнови страницу игрока во время воспроизведения. Клиент должен подцепиться к текущему offset после входа."
  ));

  checks.push(qaCheck(
    "manual-long-files",
    "Ручной тест: длинные аудиофайлы",
    "manual",
    "Проверь 10–30 минутный трек: старт, seek, stop, reload. Full audio preload не используется, поэтому память не должна резко расти."
  ));

  const counts = checks.reduce((acc, check) => {
    acc[check.status] = (acc[check.status] ?? 0) + 1;
    return acc;
  }, {});

  return { checks, counts, ok: !checks.some((check) => check.status === "fail") };
}

export async function resetLocalAudio() {
  await AudioEngine.unload();
  return { ok: true, runtime: AudioEngine.getRuntimeState() };
}

export async function resetDeckState() {
  if (!game.user?.isGM) throw codedError("Only a GM can reset the cassette deck.", "GM_ONLY");
  const result = await CassetteSocket.transport("eject", { suppressClick: true });
  if (!result?.ok) throw codedError(result?.reason ?? "Deck reset failed.", result?.code ?? "RESET_FAILED");
  return result;
}

export async function repairLibrary(options = {}) {
  if (!game.user?.isGM) throw codedError("Only a GM can repair the cassette library.", "GM_ONLY");
  return repairLibraryState(options);
}

export function exportDiagnostics() {
  const filename = `cassette-deck-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  return saveJsonFile(getDiagnosticsSummary(), filename);
}
