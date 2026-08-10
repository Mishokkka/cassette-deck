const LEGACY_LABEL_FONT_IDS = new Set(["handwritten", "marker", "typewriter", "print", "digital"]);

export const CASSETTE_ACCESS_MODES = Object.freeze([
  Object.freeze({ id: "unlocked", label: "Все игроки" }),
  Object.freeze({ id: "locked", label: "Заперта" }),
  Object.freeze({ id: "users", label: "Конкретные игроки" }),
  Object.freeze({ id: "roles", label: "По ролям" })
]);

const CASSETTE_ACCESS_MODE_IDS = new Set(CASSETTE_ACCESS_MODES.map((mode) => mode.id));

export function normalizeCassetteLabel(source = {}) {
  const rawFont = String(source?.font ?? "").trim();
  const font = LEGACY_LABEL_FONT_IDS.has(rawFont) ? "" : rawFont;
  return { font };
}

export function createEmptyTrack() {
  return {
    id: foundry.utils.randomID(),
    title: "Новая дорожка",
    path: "",
    duration: null,
    transcript: "",
    tags: []
  };
}

export function createEmptyCassette() {
  return {
    id: foundry.utils.randomID(),
    title: "Новая кассета",
    description: "",
    discovered: false,
    sort: 0,
    access: {
      mode: "unlocked",
      users: [],
      roles: []
    },
    tracks: [createEmptyTrack()],
    effects: {
      preset: "clean",
      intensity: 1
    },
    label: normalizeCassetteLabel()
  };
}

export function normalizeCassette(source = {}) {
  const cassette = foundry.utils.deepClone(source);

  cassette.id = String(cassette.id || foundry.utils.randomID());
  cassette.title = String(cassette.title || "Безымянная кассета").trim() || "Безымянная кассета";
  cassette.description = String(cassette.description || "");
  delete cassette.cover;
  cassette.discovered = Boolean(cassette.discovered);
  cassette.sort = Number.isFinite(Number(cassette.sort)) ? Number(cassette.sort) : 0;

  cassette.access = foundry.utils.mergeObject(
    { mode: "unlocked", users: [], roles: [] },
    cassette.access ?? {},
    { inplace: false }
  );
  cassette.access.mode = CASSETTE_ACCESS_MODE_IDS.has(String(cassette.access.mode || ""))
    ? String(cassette.access.mode)
    : "locked";
  cassette.access.users = Array.isArray(cassette.access.users)
    ? [...new Set(cassette.access.users.map((id) => String(id)).filter(Boolean))]
    : [];
  cassette.access.roles = Array.isArray(cassette.access.roles)
    ? [...new Set(cassette.access.roles.map((role) => String(role)).filter(Boolean))]
    : [];

  cassette.tracks = Array.isArray(cassette.tracks) ? cassette.tracks.map(normalizeTrack) : [];
  cassette.effects = foundry.utils.mergeObject(
    { preset: "clean", intensity: 1 },
    cassette.effects ?? {},
    { inplace: false }
  );
  cassette.effects.preset = String(cassette.effects.preset || "clean");
  cassette.effects.intensity = Number.isFinite(Number(cassette.effects.intensity))
    ? Math.min(5, Math.max(0, Number(cassette.effects.intensity)))
    : 1;

  cassette.label = normalizeCassetteLabel(cassette.label ?? {});

  return cassette;
}

export function normalizeTrack(source = {}) {
  const track = foundry.utils.deepClone(source);

  track.id = String(track.id || foundry.utils.randomID());
  track.title = String(track.title || "Безымянная дорожка").trim() || "Безымянная дорожка";
  track.path = String(track.path || "").trim();
  track.duration = Number.isFinite(Number(track.duration)) && Number(track.duration) >= 0 ? Number(track.duration) : null;
  track.transcript = String(track.transcript || "");
  track.tags = Array.isArray(track.tags)
    ? track.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : String(track.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);

  return track;
}
