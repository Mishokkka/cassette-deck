import { MODULE_TITLE, SCHEMA_VERSIONS, TEMPLATES } from "../core/constants.mjs";
import { logger } from "../core/logger.mjs";
import {
  buildControllerPreset,
  buildLockedPreset,
  buildViewerPreset,
  normalizePermissionSet,
  PERMISSION_DEFINITIONS,
  readPermissions,
  resetPermissions,
  savePermissions
} from "../core/permissions.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

let permissionsAppInstance = null;

export class CassettePermissionsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "cassette-deck-permissions",
    classes: ["cassette-deck", "cd-permissions-app"],
    tag: "section",
    window: {
      frame: true,
      title: "Cassette Deck: права управления",
      icon: "fa-solid fa-user-lock"
    },
    position: {
      width: 960,
      height: 620
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.permissions
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const permissions = readPermissions();
    const playerUsers = game.users.contents
      .filter((user) => !user.isGM)
      .sort((a, b) => a.name.localeCompare(b.name));

    const rows = [
      this.#buildRow({
        id: "defaultPlayer",
        label: "Все игроки по умолчанию",
        sublabel: "База для новых и не настроенных пользователей",
        kind: "default",
        permissions: permissions.defaultPlayer
      }),
      ...playerUsers.map((user) => this.#buildRow({
        id: user.id,
        label: user.name,
        sublabel: user.active ? "онлайн" : "оффлайн",
        kind: "user",
        permissions: permissions.users?.[user.id] ?? permissions.defaultPlayer,
        defaultPermissions: permissions.defaultPlayer,
        active: user.active
      }))
    ];

    return {
      ...context,
      moduleTitle: MODULE_TITLE,
      isGM: game.user.isGM,
      definitions: PERMISSION_DEFINITIONS,
      rows,
      hasUsers: playerUsers.length > 0,
      userCount: playerUsers.length
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    this.element.removeEventListener("click", this.#onActionClick);
    this.element.addEventListener("click", this.#onActionClick);
  }

  #onActionClick = async (event) => {
    const element = event.target?.closest?.("[data-action]");
    if (!element || !this.element?.contains?.(element)) return;
    event.preventDefault();
    const action = element?.dataset?.action;
    if (!action) return;

    try {
      switch (action) {
        case "save-permissions":
          return this.#savePermissions();
        case "reset-permissions":
          return this.#resetPermissions();
        case "apply-controller-preset":
          return this.#applyPreset(element.closest("[data-permission-row]"), buildControllerPreset());
        case "apply-viewer-preset":
          return this.#applyPreset(element.closest("[data-permission-row]"), buildViewerPreset());
        case "apply-locked-preset":
          return this.#applyPreset(element.closest("[data-permission-row]"), buildLockedPreset());
        case "copy-default-preset":
          return this.#copyDefaultToRow(element.closest("[data-permission-row]"));
        default:
          logger.warn(`Unknown permissions action: ${action}`);
      }
    } catch (error) {
      logger.error("Permissions action failed.", error);
      ui.notifications.error(`Cassette Deck: ${error?.message ?? "ошибка прав"}`);
    }
  };

  async #savePermissions({ silent = false } = {}) {
    if (!game.user.isGM) return ui.notifications.warn("Cassette Deck: права может менять только GM.");

    const permissions = this.#collectPermissionsFromForm();
    await savePermissions(permissions);
    if (!silent) ui.notifications.info("Cassette Deck: права сохранены.");
    await this.render({ force: true });
  }

  async #resetPermissions() {
    if (!game.user.isGM) return ui.notifications.warn("Cassette Deck: права может менять только GM.");

    const dialogApi = foundry.applications.api.DialogV2;
    const confirmed = dialogApi?.confirm
      ? await dialogApi.confirm({
        window: { title: "Сбросить права" },
        content: "<p>Сбросить все права Cassette Deck к значениям по умолчанию?</p>",
        yes: { label: "Сбросить", icon: "fa-solid fa-rotate-left" },
        no: { label: "Отмена" }
      })
      : globalThis.confirm("Сбросить все права Cassette Deck к значениям по умолчанию?");

    if (!confirmed) return;

    await resetPermissions();
    ui.notifications.info("Cassette Deck: права сброшены.");
    await this.render({ force: true });
  }

  async #applyPreset(row, preset) {
    if (!row) return;
    for (const definition of PERMISSION_DEFINITIONS) {
      const input = row.querySelector(`[data-permission-key='${definition.key}']`);
      if (input) input.checked = Boolean(preset[definition.key]);
    }
    await this.#savePermissions({ silent: true });
  }

  async #copyDefaultToRow(row) {
    if (!row || row.dataset.rowKind !== "user") return;
    const defaultRow = this.element.querySelector("[data-permission-row][data-row-kind='default']");
    if (!defaultRow) return;

    for (const definition of PERMISSION_DEFINITIONS) {
      const source = defaultRow.querySelector(`[data-permission-key='${definition.key}']`);
      const target = row.querySelector(`[data-permission-key='${definition.key}']`);
      if (source && target) target.checked = source.checked;
    }

    await this.#savePermissions({ silent: true });
  }

  #collectPermissionsFromForm() {
    const root = this.element.querySelector("[data-cd-permissions]");
    if (!root) throw new Error("Permissions form is not rendered.");

    const result = {
      schemaVersion: SCHEMA_VERSIONS.permissions,
      defaultPlayer: {},
      users: {}
    };

    for (const row of root.querySelectorAll("[data-permission-row]")) {
      const kind = row.dataset.rowKind;
      const rowId = row.dataset.rowId;
      const values = {};

      for (const definition of PERMISSION_DEFINITIONS) {
        const input = row.querySelector(`[data-permission-key='${definition.key}']`);
        values[definition.key] = Boolean(input?.checked);
      }

      if (kind === "default") result.defaultPlayer = normalizePermissionSet(values);
      else if (kind === "user" && rowId) result.users[rowId] = normalizePermissionSet(values, result.defaultPlayer);
    }

    return result;
  }

  async _preClose(options) {
    this.element?.removeEventListener?.("click", this.#onActionClick);
    if (permissionsAppInstance === this) permissionsAppInstance = null;
    await super._preClose?.(options);
  }

  #buildRow({ id, label, sublabel, kind, permissions, active = false }) {
    const normalized = normalizePermissionSet(permissions);
    return {
      id,
      label,
      sublabel,
      kind,
      isDefault: kind === "default",
      active,
      values: PERMISSION_DEFINITIONS.map((definition) => ({
        ...definition,
        checked: Boolean(normalized[definition.key])
      }))
    };
  }
}

export function getPermissionsApp() {
  return permissionsAppInstance;
}

export async function openPermissionsApp({ force = true } = {}) {
  if (!game.user.isGM) {
    ui.notifications.warn("Cassette Deck: права может открывать только GM.");
    return null;
  }

  if (!permissionsAppInstance) permissionsAppInstance = new CassettePermissionsApp();
  await permissionsAppInstance.render({ force: true });
  if (force) permissionsAppInstance.bringToFront();
  return permissionsAppInstance;
}
