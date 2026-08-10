import { MODULE_ID, MODULE_TITLE, SCHEMA_VERSIONS, TEMPLATES } from "../core/constants.mjs";
import { logger } from "../core/logger.mjs";
import { saveJsonFile } from "../core/file-utils.mjs";
import { getEffectPresetChoices } from "../services/effects-service.mjs";
import { CASSETTE_ACCESS_MODES, createEmptyTrack, normalizeCassetteLabel } from "../models/cassette.mjs";
import { isSafeAudioPath } from "../models/validators.mjs";
import { clampNumber } from "../core/utils.mjs";
import { openPermissionsApp } from "./permissions-app.mjs";
import {
  createCassette,
  deleteCassette,
  duplicateCassette,
  importLibrary,
  previewLibraryImport,
  moveCassette,
  normalizeLibrarySort,
  getCassetteById,
  readLibrary,
  saveCassette
} from "../services/library-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

let libraryAppInstance = null;

export class CassetteLibraryApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "cassette-deck-library",
    classes: ["cassette-deck", "cd-library-app"],
    tag: "section",
    window: {
      frame: true,
      title: "Cassette Deck: библиотека кассет",
      icon: "fa-solid fa-compact-disc"
    },
    position: {
      width: 860,
      height: 660
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.library
    }
  };

  #selectedCassetteId = null;
  #dirty = false;
  #loadedRevision = null;
  #closingApproved = false;
  #externalRevisionPending = false;
  #importInput = null;
  #rawSizeRevision = null;
  #rawSizeValue = 0;

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const library = readLibrary();
    const cassettes = library.cassettes ?? [];
    if (this.#loadedRevision === null || !this.#dirty) this.#loadedRevision = library.revision;

    if (!this.#selectedCassetteId && cassettes.length > 0) this.#selectedCassetteId = cassettes[0].id;
    if (this.#selectedCassetteId && !cassettes.some((cassette) => cassette.id === this.#selectedCassetteId)) {
      this.#selectedCassetteId = cassettes[0]?.id ?? null;
    }

    const selected = this.#selectedCassetteId
      ? cassettes.find((cassette) => cassette.id === this.#selectedCassetteId) ?? null
      : null;
    const decoratedSelected = selected ? this.#decorateCassette(selected) : null;
    if (this.#rawSizeRevision !== library.revision) {
      this.#rawSizeRevision = library.revision;
      this.#rawSizeValue = JSON.stringify(library).length;
    }

    return {
      ...context,
      moduleTitle: MODULE_TITLE,
      isGM: game.user.isGM,
      cassettes: cassettes.map((cassette) => ({
        id: cassette.id,
        title: cassette.title,
        discovered: Boolean(cassette.discovered),
        selected: cassette.id === this.#selectedCassetteId,
        trackCount: Array.isArray(cassette.tracks) ? cassette.tracks.length : 0
      })),
      selected: decoratedSelected,
      hasCassettes: cassettes.length > 0,
      presetChoices: getEffectPresetChoices().map((preset) => ({
        ...preset,
        selected: preset.id === (decoratedSelected?.effects?.preset ?? "clean")
      })),
      labelFontChoices: this.#getLabelFontChoices(decoratedSelected?.label?.font ?? ""),
      accessModes: this.#getAccessModes(decoratedSelected?.access?.mode ?? "unlocked"),
      libraryRawSize: this.#rawSizeValue,
      accessUsers: this.#getAccessUsers(decoratedSelected),
      accessRoles: this.#getAccessRoles(decoratedSelected)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    this.element.removeEventListener("click", this.#onActionClick);
    this.element.removeEventListener("input", this.#markDirty);
    this.element.removeEventListener("change", this.#markDirty);
    this.element.addEventListener("click", this.#onActionClick);
    this.element.addEventListener("input", this.#markDirty);
    this.element.addEventListener("change", this.#markDirty);

    this.#importInput?.removeEventListener?.("change", this.#onImportFileSelected);
    this.#importInput = this.element.querySelector("[data-cd-import-input]");
    this.#importInput?.addEventListener("change", this.#onImportFileSelected);
    if (!this.#dirty) this.#externalRevisionPending = false;
  }

  handleExternalLibraryChange() {
    if (!this.rendered) return;
    if (this.#dirty) {
      this.#externalRevisionPending = true;
      return;
    }
    this.#loadedRevision = null;
    void this.render({ force: true });
  }

  #markDirty = (event) => {
    if (event?.target?.matches?.("[data-cd-import-input]")) return;
    if (event?.target?.closest?.("[data-cd-library-form]")) this.#dirty = true;
  };

  #onActionClick = async (event) => {
    const button = event.target?.closest?.("[data-action]");
    if (!button || !this.element?.contains?.(button)) return;
    event.preventDefault();
    const action = button?.dataset?.action;
    if (!action) return;

    try {
      switch (action) {
        case "create-cassette":
          return this.#createCassette();
        case "select-cassette":
          return this.#selectCassette(button.dataset.cassetteId);
        case "save-cassette":
          return this.#saveCassette();
        case "delete-cassette":
          return this.#deleteCassette();
        case "duplicate-cassette":
          return this.#duplicateCassette();
        case "move-cassette-up":
          return this.#moveCassette(-1);
        case "move-cassette-down":
          return this.#moveCassette(1);
        case "normalize-sort":
          return this.#normalizeSort();
        case "export-library":
          return this.#exportLibrary();
        case "import-library":
          return this.#openImportFilePicker();
        case "add-track":
          return this.#addTrack();
        case "remove-track":
          return this.#removeTrack(button.closest("[data-track-row]")?.dataset?.trackId);
        case "move-track-up":
          return this.#moveTrack(button.closest("[data-track-row]")?.dataset?.trackId, -1);
        case "move-track-down":
          return this.#moveTrack(button.closest("[data-track-row]")?.dataset?.trackId, 1);
        case "open-permissions":
          return openPermissionsApp();
        case "browse-audio":
          return this.#browseTrackAudio(button.closest("[data-track-row]"));
        default:
          logger.warn(`Unknown library action: ${action}`);
      }
    } catch (error) {
      logger.error("Library action failed.", error);
      ui.notifications.error(`Cassette Deck: ${error?.message ?? "ошибка библиотеки"}`);
    }
  };

  async #createCassette() {
    if (!game.user.isGM) return ui.notifications.warn("Cassette Deck: библиотеку может менять только GM.");
    if (!await this.#confirmDiscard("созданием новой кассеты")) return;
    const cassette = await createCassette();
    this.#selectedCassetteId = cassette.id;
    this.#dirty = false;
    this.#loadedRevision = readLibrary().revision;
    ui.notifications.info("Cassette Deck: кассета создана.");
    await this.render({ force: true });
  }

  async #selectCassette(cassetteId) {
    if (cassetteId === this.#selectedCassetteId) return;
    if (!await this.#confirmDiscard("переходом к другой кассете")) return;
    this.#selectedCassetteId = cassetteId || null;
    this.#dirty = false;
    await this.render({ force: true });
  }

  async #saveCassette() {
    if (!game.user.isGM) return ui.notifications.warn("Cassette Deck: библиотеку может менять только GM.");
    const cassette = this.#collectCassetteFromForm();
    const saved = await saveCassette(cassette, { expectedRevision: this.#loadedRevision });
    this.#selectedCassetteId = saved.id;
    this.#dirty = false;
    this.#loadedRevision = readLibrary().revision;
    ui.notifications.info("Cassette Deck: кассета сохранена.");
    await this.render({ force: true });
  }

  async #deleteCassette() {
    if (!game.user.isGM) return ui.notifications.warn("Cassette Deck: библиотеку может менять только GM.");
    const cassette = getCassetteById(this.#selectedCassetteId);
    if (!cassette) return;
    if (!await this.#confirmDiscard("удалением кассеты")) return;

    const dialogApi = foundry.applications.api.DialogV2;
    const confirmed = dialogApi?.confirm
      ? await dialogApi.confirm({
        window: { title: "Удалить кассету" },
        content: `<p>Удалить кассету <strong>${foundry.utils.escapeHTML(cassette.title)}</strong>?</p><p>Это действие нельзя отменить.</p>`,
        yes: { label: "Удалить", icon: "fa-solid fa-trash" },
        no: { label: "Отмена" }
      })
      : globalThis.confirm(`Удалить кассету "${cassette.title}"?`);

    if (!confirmed) return;

    await deleteCassette(cassette.id, { expectedRevision: this.#loadedRevision });
    this.#selectedCassetteId = null;
    this.#dirty = false;
    this.#loadedRevision = readLibrary().revision;
    ui.notifications.info("Cassette Deck: кассета удалена.");
    await this.render({ force: true });
  }



  async #duplicateCassette() {
    if (!game.user.isGM) return ui.notifications.warn("Cassette Deck: библиотеку может менять только GM.");
    if (!this.#selectedCassetteId) return;

    const source = this.#collectCassetteFromForm();
    const copy = await duplicateCassette(source);
    this.#selectedCassetteId = copy.id;
    this.#dirty = false;
    this.#loadedRevision = readLibrary().revision;
    ui.notifications.info("Cassette Deck: кассета продублирована.");
    await this.render({ force: true });
  }

  async #moveCassette(direction) {
    if (!game.user.isGM) return ui.notifications.warn("Cassette Deck: библиотеку может менять только GM.");
    if (!this.#selectedCassetteId) return;

    const moved = await moveCassette(this.#selectedCassetteId, direction);
    if (moved?.id) this.#selectedCassetteId = moved.id;
    this.#dirty = false;
    this.#loadedRevision = readLibrary().revision;
    await this.render({ force: true });
  }

  async #normalizeSort() {
    if (!game.user.isGM) return ui.notifications.warn("Cassette Deck: библиотеку может менять только GM.");
    await normalizeLibrarySort();
    this.#dirty = false;
    this.#loadedRevision = readLibrary().revision;
    ui.notifications.info("Cassette Deck: порядок кассет нормализован.");
    await this.render({ force: true });
  }

  #exportLibrary() {
    const payload = {
      module: MODULE_ID,
      schemaVersion: SCHEMA_VERSIONS.library,
      exportedAt: new Date().toISOString(),
      library: readLibrary()
    };

    const filename = `cassette-deck-library-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    saveJsonFile(payload, filename);
  }

  #openImportFilePicker() {
    if (!game.user.isGM) return ui.notifications.warn("Cassette Deck: библиотеку может менять только GM.");
    const input = this.element.querySelector("[data-cd-import-input]");
    input?.click();
  }

  #onImportFileSelected = async (event) => {
    const input = event.currentTarget;
    const file = input?.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const preview = previewLibraryImport(data);
      if (!await this.#confirmDiscard("импортом библиотеки")) return;
      const confirmed = await this.#confirmImport(file.name, preview.diff);
      if (!confirmed) return;

      const backupAt = new Date().toISOString();
      const backupName = `cassette-deck-library-backup-${backupAt.replace(/[:.]/g, "-")}.json`;
      saveJsonFile({ module: MODULE_ID, backupAt, library: preview.current }, backupName);

      const result = await importLibrary(data);
      this.#selectedCassetteId = result.library.cassettes[0]?.id ?? null;
      this.#dirty = false;
      this.#loadedRevision = result.library.revision;
      ui.notifications.info("Cassette Deck: библиотека импортирована; резервная копия сохранена.");
      await this.render({ force: true });
    } catch (error) {
      logger.error("Library import failed.", error);
      ui.notifications.error(`Cassette Deck: импорт не выполнен: ${error?.message ?? "ошибка JSON"}`);
    } finally {
      input.value = "";
    }
  };

  async #confirmImport(filename, diff = {}) {
    const message = `Импортировать библиотеку из файла "${filename}"? Будет добавлено: ${diff.added ?? 0}, удалено: ${diff.removed ?? 0}, сохранено по ID: ${diff.retained ?? 0}. Перед заменой будет скачана резервная копия.`;
    const dialogApi = foundry.applications.api.DialogV2;
    if (dialogApi?.confirm) {
      return dialogApi.confirm({
        window: { title: "Импорт библиотеки" },
        content: `<p>${foundry.utils.escapeHTML(message)}</p>`,
        yes: { label: "Импортировать", icon: "fa-solid fa-file-import" },
        no: { label: "Отмена" }
      });
    }
    return globalThis.confirm(message);
  }

  async #addTrack() {
    if (!this.#selectedCassetteId) return;
    const cassette = this.#collectCassetteFromForm();
    cassette.tracks.push(createEmptyTrack());
    const saved = await saveCassette(cassette, { expectedRevision: this.#loadedRevision });
    this.#selectedCassetteId = saved.id;
    this.#dirty = false;
    this.#loadedRevision = readLibrary().revision;
    await this.render({ force: true });
  }

  async #removeTrack(trackId) {
    if (!this.#selectedCassetteId || !trackId) return;
    const cassette = this.#collectCassetteFromForm();
    cassette.tracks = cassette.tracks.filter((track) => track.id !== trackId);
    const saved = await saveCassette(cassette, { expectedRevision: this.#loadedRevision });
    this.#selectedCassetteId = saved.id;
    this.#dirty = false;
    this.#loadedRevision = readLibrary().revision;
    await this.render({ force: true });
  }



  async #moveTrack(trackId, direction) {
    if (!this.#selectedCassetteId || !trackId) return;
    const cassette = this.#collectCassetteFromForm();
    const index = cassette.tracks.findIndex((track) => track.id === trackId);
    if (index < 0) return;

    const targetIndex = Math.max(0, Math.min(cassette.tracks.length - 1, index + (Number(direction) < 0 ? -1 : 1)));
    if (targetIndex === index) return;

    const [track] = cassette.tracks.splice(index, 1);
    cassette.tracks.splice(targetIndex, 0, track);
    const saved = await saveCassette(cassette, { expectedRevision: this.#loadedRevision });
    this.#selectedCassetteId = saved.id;
    this.#dirty = false;
    this.#loadedRevision = readLibrary().revision;
    await this.render({ force: true });
  }

  #collectCassetteFromForm() {
    const form = this.element.querySelector("[data-cd-library-form]");
    if (!form) throw new Error("Library form is not rendered.");

    const current = getCassetteById(this.#selectedCassetteId) ?? {};
    const formData = new FormData(form);

    const cassette = foundry.utils.deepClone(current);
    cassette.id = String(formData.get("id") || current.id || foundry.utils.randomID());
    cassette.title = String(formData.get("title") || "").trim() || "Безымянная кассета";
    cassette.description = String(formData.get("description") || "");
    delete cassette.cover;
    cassette.discovered = formData.get("discovered") === "on";
    cassette.sort = Number(formData.get("sort") || 0);
    cassette.access = {
      ...(current.access ?? {}),
      mode: String(formData.get("accessMode") || "unlocked"),
      users: Array.from(form.querySelectorAll("[data-access-user]:checked")).map((input) => input.value),
      roles: Array.from(form.querySelectorAll("[data-access-role]:checked")).map((input) => input.value)
    };
    cassette.effects = {
      ...(current.effects ?? {}),
      preset: String(formData.get("effectPreset") || "clean"),
      intensity: clampNumber(formData.get("effectIntensity"), 0, 5, 1)
    };
    cassette.label = normalizeCassetteLabel({
      ...(current.label ?? {}),
      font: String(formData.get("labelFont") || "")
    });

    const currentTracks = new Map((current.tracks ?? []).map((track) => [track.id, track]));
    cassette.tracks = Array.from(form.querySelectorAll("[data-track-row]")).map((row, index) => {
      const id = row.dataset.trackId || foundry.utils.randomID();
      const path = row.querySelector("[data-track-field='path']")?.value?.trim() || "";
      const previous = currentTracks.get(id);
      const duration = previous?.path === path ? previous.duration ?? null : null;

      return {
        id,
        title: row.querySelector("[data-track-field='title']")?.value?.trim() || `Дорожка ${index + 1}`,
        path,
        transcript: row.querySelector("[data-track-field='transcript']")?.value || "",
        tags: row.querySelector("[data-track-field='tags']")?.value || "",
        duration
      };
    });

    return cassette;
  }

  #getLabelFontChoices(currentFont = "") {
    const current = String(currentFont || "").trim();
    const choices = [{ id: "", label: "По умолчанию", selected: !current }];
    const seen = new Set([""]);

    for (const font of collectFoundryFonts()) {
      const id = String(font.id || font.family || font.label || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      choices.push({
        id,
        label: String(font.label || font.family || id),
        selected: id === current
      });
    }

    if (current && !seen.has(current)) choices.push({ id: current, label: `${current} (нет в списке Foundry)`, selected: true });
    return choices;
  }

  #getAccessModes(currentMode) {
    return CASSETTE_ACCESS_MODES.map((mode) => ({
      ...mode,
      selected: mode.id === currentMode
    }));
  }

  #getAccessUsers(cassette) {
    if (!cassette) return [];
    const selectedUsers = new Set(cassette.access?.users ?? []);
    return game.users.contents
      .filter((user) => !user.isGM)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((user) => ({
        id: user.id,
        name: user.name,
        active: user.active,
        checked: selectedUsers.has(user.id)
      }));
  }


  async #confirmDiscard(actionLabel = "продолжением") {
    if (!this.#dirty) return true;
    const message = `Есть несохранённые изменения. Отбросить их перед ${actionLabel}?`;
    const dialogApi = foundry.applications.api.DialogV2;
    const confirmed = dialogApi?.confirm
      ? await dialogApi.confirm({
        window: { title: "Несохранённые изменения" },
        content: `<p>${foundry.utils.escapeHTML(message)}</p>`,
        yes: { label: "Отбросить", icon: "fa-solid fa-triangle-exclamation" },
        no: { label: "Остаться" }
      })
      : globalThis.confirm(message);
    if (confirmed) this.#dirty = false;
    return Boolean(confirmed);
  }

  async close(options = {}) {
    if (!this.#closingApproved && !await this.#confirmDiscard("закрытием редактора")) return this;
    this.#closingApproved = true;
    try { return await super.close(options); }
    finally { this.#closingApproved = false; }
  }

  async _preClose(options) {
    this.element?.removeEventListener?.("click", this.#onActionClick);
    this.element?.removeEventListener?.("input", this.#markDirty);
    this.element?.removeEventListener?.("change", this.#markDirty);
    this.#importInput?.removeEventListener?.("change", this.#onImportFileSelected);
    this.#importInput = null;
    if (libraryAppInstance === this) libraryAppInstance = null;
    await super._preClose?.(options);
  }

  #getAccessRoles(cassette) {
    if (!cassette) return [];
    const selectedRoles = new Set((cassette.access?.roles ?? []).map((role) => String(role)));
    const roles = globalThis.CONST?.USER_ROLES ?? {};
    const roleLabels = {
      1: "Игрок",
      2: "Доверенный игрок",
      3: "Ассистент GM"
    };

    return Object.entries(roles)
      .map(([key, value]) => ({ key, value: String(value) }))
      .filter((role) => Number(role.value) > 0 && Number(role.value) < Number(roles.GAMEMASTER ?? 4))
      .sort((a, b) => Number(a.value) - Number(b.value))
      .map((role) => ({
        id: role.value,
        name: roleLabels[role.value] ?? role.key,
        checked: selectedRoles.has(role.value)
      }));
  }

  #decorateCassette(cassette) {
    const clone = foundry.utils.deepClone(cassette);
    clone.label = normalizeCassetteLabel(clone.label ?? {});
    clone.tracks = (clone.tracks ?? []).map((track) => ({
      ...track,
      pathIsInvalid: Boolean(track.path) && !isSafeAudioPath(track.path, { allowRemote: false }),
      tagText: Array.isArray(track.tags) ? track.tags.join(", ") : String(track.tags || "")
    }));
    return clone;
  }

  async #browseFile(type, selector) {
    const input = this.element.querySelector(selector);
    if (!input) return;

    new FilePicker({
      type,
      current: input.value || "",
      callback: (path) => {
        input.value = path;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }).render(true);
  }

  async #browseTrackAudio(row) {
    if (!row) return;
    const input = row.querySelector("[data-track-field='path']");
    if (!input) return;

    new FilePicker({
      type: "audio",
      current: input.value || "",
      callback: (path) => {
        input.value = path;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }).render(true);
  }
}

function collectFoundryFonts() {
  const found = [];
  const pushFont = (id, label = null, family = null) => {
    const value = String(id || family || label || "").trim();
    if (!value) return;
    found.push({ id: value, label: String(label || family || value), family: String(family || value) });
  };

  const fontConfig = globalThis.FontConfig;
  try {
    const available = fontConfig?.getAvailableFonts?.();
    if (available instanceof Map) {
      for (const [key, value] of available.entries()) pushFont(key, value?.label, value?.family ?? key);
    } else if (Array.isArray(available)) {
      for (const value of available) {
        if (typeof value === "string") pushFont(value);
        else pushFont(value?.id ?? value?.family ?? value?.name, value?.label ?? value?.name, value?.family);
      }
    } else if (available && typeof available === "object") {
      for (const [key, value] of Object.entries(available)) pushFont(key, value?.label ?? value?.name, value?.family ?? key);
    }
  } catch (_error) {
    // FontConfig is optional across Foundry versions.
  }

  const definitions = globalThis.CONFIG?.fontDefinitions ?? globalThis.CONFIG?.fonts ?? null;
  if (definitions instanceof Map) {
    for (const [key, value] of definitions.entries()) pushFont(key, value?.label ?? value?.name, value?.family ?? key);
  } else if (Array.isArray(definitions)) {
    for (const value of definitions) {
      if (typeof value === "string") pushFont(value);
      else pushFont(value?.id ?? value?.family ?? value?.name, value?.label ?? value?.name, value?.family);
    }
  } else if (definitions && typeof definitions === "object") {
    for (const [key, value] of Object.entries(definitions)) pushFont(key, value?.label ?? value?.name, value?.family ?? key);
  }

  try {
    const coreFonts = game.settings?.get?.("core", "fonts");
    if (Array.isArray(coreFonts)) {
      for (const value of coreFonts) typeof value === "string" ? pushFont(value) : pushFont(value?.id ?? value?.family ?? value?.name, value?.label ?? value?.name, value?.family);
    } else if (coreFonts && typeof coreFonts === "object") {
      for (const [key, value] of Object.entries(coreFonts)) pushFont(key, value?.label ?? value?.name, value?.family ?? key);
    }
  } catch (_error) {
    // Some worlds do not expose core font settings to modules.
  }

  found.sort((a, b) => a.label.localeCompare(b.label));
  return found;
}

export function getLibraryApp() {
  return libraryAppInstance;
}

export async function openLibraryApp({ force = true } = {}) {
  if (!game.user.isGM) {
    ui.notifications.warn("Cassette Deck: библиотеку может открывать только GM.");
    return null;
  }

  if (!libraryAppInstance) libraryAppInstance = new CassetteLibraryApp();
  await libraryAppInstance.render({ force: true });
  if (force) libraryAppInstance.bringToFront();
  return libraryAppInstance;
}
