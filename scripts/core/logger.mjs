import { MODULE_ID, MODULE_TITLE, SETTINGS } from "./constants.mjs";

function isDebugEnabled() {
  try {
    return Boolean(game?.settings?.get(MODULE_ID, SETTINGS.debug));
  } catch (_error) {
    return false;
  }
}

export const logger = {
  log(...args) {
    if (isDebugEnabled()) console.log(`${MODULE_TITLE} |`, ...args);
  },

  info(...args) {
    console.info(`${MODULE_TITLE} |`, ...args);
  },

  warn(...args) {
    console.warn(`${MODULE_TITLE} |`, ...args);
  },

  error(...args) {
    console.error(`${MODULE_TITLE} |`, ...args);
  }
};
