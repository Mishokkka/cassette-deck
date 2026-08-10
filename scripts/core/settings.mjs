import {
  DEFAULT_DECK_STATE,
  DEFAULT_LIBRARY,
  DEFAULT_PERMISSIONS,
  DEFAULT_TRANSPORT_SFX,
  DEFAULT_WIDGET_STATE,
  HOOKS,
  MODULE_ID,
  SETTINGS
} from "./constants.mjs";
import { logger } from "./logger.mjs";
import { CassetteButtonSfxApp } from "../apps/button-sfx-app.mjs";

function cloneDefault(value) {
  return foundry.utils.deepClone(value);
}

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTINGS.debug, {
    name: "Cassette Deck: Debug logging",
    hint: "Включает подробные сообщения модуля в консоли браузера. Обычно не нужно.",
    scope: "world",
    config: true,
    restricted: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, SETTINGS.autoOpenWidget, {
    name: "Cassette Deck: открывать виджет автоматически",
    hint: "Если включено, кассетный виджет будет появляться у пользователя после входа в мир.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.audioEngine, {
    name: "Cassette Deck: аудиодвижок",
    hint: "Native Audio работает отдельно от регулятора Music. Foundry Sound оставлен для диагностики.",
    scope: "client",
    config: false,
    type: String,
    choices: {
      native: "Native Audio (отдельно от Music)",
      foundry: "Foundry Sound (legacy fallback)"
    },
    default: "native"
  });

  game.settings.register(MODULE_ID, SETTINGS.autoSyncOnReady, {
    name: "Cassette Deck: синхронизация при входе",
    hint: "Если включено, клиент после входа в мир запрашивает актуальное состояние кассетника у GM и подключается к текущему воспроизведению.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.syncPulseInterval, {
    name: "Cassette Deck: интервал sync-pulse",
    hint: "Как часто GM-клиент отправляет сверку воспроизведения всем подключенным клиентам. 0 отключает периодическую сверку.",
    scope: "world",
    config: true,
    restricted: true,
    type: Number,
    default: 10,
    range: {
      min: 0,
      max: 60,
      step: 1
    }
  });


  game.settings.register(MODULE_ID, SETTINGS.effectsEnabled, {
    name: "Cassette Deck: эффекты кассет",
    hint: "Включает Web Audio-цепочку для пресетов старой и поврежденной пленки. Clean preset остается без обработки.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.deckClickSfx, {
    name: "Cassette Deck: звуки кнопок включены",
    hint: "Настраивается через отдельное меню «Звуки кнопок плеера». Старый ключ оставлен для совместимости.",
    scope: "world",
    config: false,
    restricted: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.transportSfx, {
    name: "Cassette Deck: звуки кнопок плеера",
    scope: "world",
    config: false,
    restricted: true,
    type: Object,
    default: cloneDefault(DEFAULT_TRANSPORT_SFX)
  });

  game.settings.registerMenu(MODULE_ID, SETTINGS.transportSfxMenu, {
    name: "Cassette Deck: звуки кнопок плеера",
    label: "Открыть редактор звуков",
    hint: "Выбор отдельных аудиофайлов для PLAY, PAUSE, STOP, перемотки, выбора кассеты, открытия и закрытия крышки.",
    icon: "fa-solid fa-volume-high",
    type: CassetteButtonSfxApp,
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTINGS.fadeMs, {
    name: "Cassette Deck: fade in/out",
    hint: "Длительность мягкого входа и выхода звука в миллисекундах.",
    scope: "client",
    config: true,
    type: Number,
    default: 160,
    range: {
      min: 0,
      max: 2000,
      step: 20
    }
  });


  game.settings.register(MODULE_ID, SETTINGS.preloadStrategy, {
    name: "Cassette Deck: стратегия предзагрузки",
    hint: "Определяет, какие аудиометаданные заранее прогревать. Аудиофайлы целиком не грузятся, чтобы не тратить память и трафик.",
    scope: "client",
    config: true,
    type: String,
    choices: {
      none: "Не предзагружать автоматически",
      current: "Только текущая дорожка",
      cassette: "Все дорожки выбранной кассеты",
      visible: "Доступные кассеты, только metadata"
    },
    default: "cassette"
  });

  game.settings.register(MODULE_ID, SETTINGS.preloadNextTrack, {
    name: "Cassette Deck: предзагружать следующую дорожку",
    hint: "Если включено, модуль дополнительно прогревает metadata следующей дорожки выбранной кассеты. Это помогает быстрее показать длительность при переключении.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.preloadMaxEntries, {
    name: "Cassette Deck: лимит metadata cache",
    hint: "Максимум дорожек, которые клиент держит в metadata cache. Это не full audio preload, но ограничение все равно полезно для больших библиотек.",
    scope: "client",
    config: true,
    type: Number,
    default: 40,
    range: {
      min: 5,
      max: 200,
      step: 5
    }
  });

  game.settings.register(MODULE_ID, SETTINGS.preloadConcurrency, {
    name: "Cassette Deck: параллельность preload",
    hint: "Сколько metadata-запросов можно выполнять одновременно при прогреве библиотеки. Для обычного стола оставь 4.",
    scope: "client",
    config: true,
    type: Number,
    default: 4,
    range: {
      min: 1,
      max: 8,
      step: 1
    },
    onChange: () => Hooks.callAll(HOOKS.widgetStateChanged, getWidgetState())
  });

  game.settings.register(MODULE_ID, SETTINGS.widgetSkin, {
    name: "Cassette Deck: внешний вид виджета",
    hint: "Legacy setting. Текущий виджет использует ассеты player-v2.",
    scope: "client",
    config: false,
    type: String,
    choices: {
      field: "Полевой кассетник",
      amber: "Янтарный терминал",
      green: "Военный зеленый",
      steel: "Старый металл"
    },
    default: "field",
    onChange: () => Hooks.callAll(HOOKS.widgetStateChanged, getWidgetState())
  });

  game.settings.register(MODULE_ID, SETTINGS.widgetState, {
    name: "Cassette Deck: состояние виджета",
    scope: "client",
    config: false,
    type: Object,
    default: cloneDefault(DEFAULT_WIDGET_STATE),
    onChange: (value) => Hooks.callAll(HOOKS.widgetStateChanged, value)
  });



  game.settings.register(MODULE_ID, SETTINGS.playerLayoutOverride, {
    name: "Cassette Deck: player-v2 layout override",
    scope: "world",
    config: false,
    restricted: true,
    type: Object,
    default: {},
    onChange: () => Hooks.callAll(HOOKS.widgetStateChanged, getWidgetState())
  });

  game.settings.register(MODULE_ID, SETTINGS.library, {
    name: "Cassette Deck: cassette library",
    scope: "world",
    config: false,
    restricted: true,
    type: Object,
    default: cloneDefault(DEFAULT_LIBRARY),
    onChange: (value) => Hooks.callAll(HOOKS.libraryChanged, value)
  });

  game.settings.register(MODULE_ID, SETTINGS.deckState, {
    name: "Cassette Deck: deck state",
    scope: "world",
    config: false,
    restricted: true,
    type: Object,
    default: cloneDefault(DEFAULT_DECK_STATE),
    onChange: (value) => Hooks.callAll(HOOKS.deckStateChanged, value)
  });

  game.settings.register(MODULE_ID, SETTINGS.permissions, {
    name: "Cassette Deck: permissions",
    scope: "world",
    config: false,
    restricted: true,
    type: Object,
    default: cloneDefault(DEFAULT_PERMISSIONS),
    onChange: (value) => Hooks.callAll(HOOKS.permissionsChanged, value)
  });


  game.settings.register(MODULE_ID, SETTINGS.personalVolume, {
    name: "Cassette Deck: личная громкость",
    hint: "Личный множитель громкости этого клиента. Не меняет общую ручку деки у остальных игроков.",
    scope: "client",
    config: true,
    type: Number,
    default: 1,
    range: { min: 0, max: 1.5, step: 0.05 },
    onChange: () => Hooks.callAll(HOOKS.audioRuntimeChanged, { personalVolumeChanged: true })
  });

  game.settings.register(MODULE_ID, SETTINGS.personalMute, {
    name: "Cassette Deck: личное отключение звука",
    hint: "Отключает звук кассетника только на этом клиенте.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => Hooks.callAll(HOOKS.audioRuntimeChanged, { personalVolumeChanged: true })
  });

  game.settings.register(MODULE_ID, SETTINGS.migrationVersion, {
    name: "Cassette Deck: migration version",
    scope: "world",
    config: false,
    restricted: true,
    type: Number,
    default: 0
  });

  game.settings.register(MODULE_ID, SETTINGS.migrationBackup, {
    name: "Cassette Deck: migration backup",
    scope: "world",
    config: false,
    restricted: true,
    type: Object,
    default: {}
  });

  logger.log("Settings registered.");
}

export function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

export async function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}

export function getWidgetState() {
  const state = foundry.utils.mergeObject(
    cloneDefault(DEFAULT_WIDGET_STATE),
    getSetting(SETTINGS.widgetState) ?? {},
    { inplace: false }
  );
  // `lidOpen` is now authoritative world deck state, not client widget state.
  delete state.lidOpen;
  return state;
}

export async function updateWidgetState(patch = {}) {
  const next = foundry.utils.mergeObject(getWidgetState(), patch, { inplace: false });
  await setSetting(SETTINGS.widgetState, next);
  return next;
}

export function getDeckState() {
  return foundry.utils.mergeObject(
    cloneDefault(DEFAULT_DECK_STATE),
    getSetting(SETTINGS.deckState) ?? {},
    { inplace: false }
  );
}

export function getLibrary() {
  return foundry.utils.mergeObject(
    cloneDefault(DEFAULT_LIBRARY),
    getSetting(SETTINGS.library) ?? {},
    { inplace: false }
  );
}
