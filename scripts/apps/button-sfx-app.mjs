import { DEFAULT_TRANSPORT_SFX, SETTINGS, TEMPLATES } from "../core/constants.mjs";
import { getSetting, setSetting } from "../core/settings.mjs";
import { EffectsService, normalizeTransportSfxSettings, TRANSPORT_SFX_ACTIONS } from "../services/effects-service.mjs";

const AppApi = globalThis.foundry?.applications?.api ?? {};
const ApplicationV2 = AppApi.ApplicationV2 ?? class {};
const HandlebarsApplicationMixin = AppApi.HandlebarsApplicationMixin ?? ((Base) => Base);

export class CassetteButtonSfxApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "cassette-deck-button-sfx",
    classes: ["cassette-deck", "cd-button-sfx-app"],
    tag: "section",
    window: {
      frame: true,
      title: "Cassette Deck: звуки кнопок",
      icon: "fa-solid fa-volume-high"
    },
    position: {
      width: 720,
      height: 640
    }
  };

  static PARTS = {
    body: { template: TEMPLATES.buttonSfx }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const sfx = normalizeTransportSfxSettings(getSetting(SETTINGS.transportSfx));
    const enabled = Boolean(getSetting(SETTINGS.deckClickSfx));

    return {
      ...context,
      enabled,
      fallbackSynth: Boolean(sfx.fallbackSynth),
      volume: Math.round(Number(sfx.volume ?? DEFAULT_TRANSPORT_SFX.volume) * 100),
      actions: TRANSPORT_SFX_ACTIONS.map((action) => ({
        ...action,
        path: sfx.actions?.[action.id] ?? ""
      }))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.removeEventListener("click", this.#onActionClick);
    this.element.addEventListener("click", this.#onActionClick);
  }

  #onActionClick = async (event) => {
    const button = event.target?.closest?.("[data-action]");
    if (!button || !this.element?.contains?.(button)) return;
    event.preventDefault();
    const action = button?.dataset?.action;
    if (!action) return;

    if (action === "save-sfx") return this.#save();
    if (action === "reset-sfx") return this.#reset();
    if (action === "test-sfx") return this.#test(button.dataset.sfxAction);
    if (action === "browse-sfx") return this.#browse(button.closest("[data-sfx-row]"));
    if (action === "clear-sfx") return this.#clear(button.closest("[data-sfx-row]"));
  };

  async #save() {
    if (!game.user?.isGM) return ui.notifications.warn("Cassette Deck: эти настройки может менять только GM.");
    const form = this.element.querySelector("[data-cd-button-sfx-form]");
    const formData = new FormData(form);
    const actions = {};

    for (const action of TRANSPORT_SFX_ACTIONS) {
      actions[action.id] = String(formData.get(`sfx.${action.id}`) || "").trim();
    }

    const volume = Math.min(1, Math.max(0, Number(formData.get("volume") || 70) / 100));
    const fallbackSynth = formData.get("fallbackSynth") === "on";
    const enabled = formData.get("enabled") === "on";

    await setSetting(SETTINGS.deckClickSfx, enabled);
    await setSetting(SETTINGS.transportSfx, normalizeTransportSfxSettings({ volume, fallbackSynth, actions }));
    ui.notifications.info("Cassette Deck: звуки кнопок сохранены.");
    await this.render({ force: true });
  }

  async #reset() {
    if (!game.user?.isGM) return ui.notifications.warn("Cassette Deck: эти настройки может менять только GM.");
    await setSetting(SETTINGS.deckClickSfx, true);
    await setSetting(SETTINGS.transportSfx, foundry.utils.deepClone(DEFAULT_TRANSPORT_SFX));
    ui.notifications.info("Cassette Deck: звуки кнопок сброшены.");
    await this.render({ force: true });
  }

  async #test(action) {
    const form = this.element.querySelector("[data-cd-button-sfx-form]");
    const formData = new FormData(form);
    const actions = {};
    for (const entry of TRANSPORT_SFX_ACTIONS) actions[entry.id] = String(formData.get(`sfx.${entry.id}`) || "").trim();
    const volume = Math.min(1, Math.max(0, Number(formData.get("volume") || 70) / 100));
    const fallbackSynth = formData.get("fallbackSynth") === "on";
    await EffectsService.playTransportClick(action, {
      enabled: true,
      settingsOverride: normalizeTransportSfxSettings({ volume, fallbackSynth, actions })
    });
  }

  #browse(row) {
    const input = row?.querySelector?.("[data-sfx-path]");
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

  #clear(row) {
    const input = row?.querySelector?.("[data-sfx-path]");
    if (!input) return;
    input.value = "";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async _preClose(options) {
    this.element?.removeEventListener?.("click", this.#onActionClick);
    await super._preClose?.(options);
  }
}
