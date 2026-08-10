export function statusFromTransportAction(action) {
  switch (action) {
    case "play":
    case "seek":
    case "sync":
      return "playing";
    case "pause":
    case "cue":
      return "paused";
    case "stop":
    case "open":
      return "stopped";
    case "closeLid":
    case "noop":
      return "idle";
    case "eject":
    case "select":
    default:
      return "idle";
  }
}

export function effectiveDeckStateFromRuntime({ runtime = null, baseState = null, now = Date.now() } = {}) {
  const base = baseState ?? {};
  const command = runtime?.command ?? null;
  const commandSeq = Number(command?.seq ?? 0);
  const baseSeq = Number(base?.seq ?? 0);
  if (!command || !commandSeq || commandSeq < baseSeq) return base;

  if (command.action === "volume") {
    const volume = Math.min(1, Math.max(0, Number(command.volume ?? base.volume ?? 0.8)));
    return {
      ...base,
      seq: Math.max(baseSeq, commandSeq),
      volume: Number.isFinite(volume) ? volume : (base.volume ?? 0.8),
      lidOpen: command.lidOpen ?? base.lidOpen ?? false
    };
  }

  const status = String(command.status || statusFromTransportAction(command.action));
  const issuedAt = Number(command.issuedAt ?? command.dispatchedAt ?? now) || now;
  const delayMs = Math.max(0, Number(command.transportDelayMs ?? 0) || 0);
  const shuttleActive = Boolean(delayMs && ["seek", "cue"].includes(String(command.action || "")) && (now - issuedAt) < delayMs);
  const offset = shuttleActive && Number.isFinite(Number(command.shuttleFromOffset))
    ? Number(command.shuttleFromOffset)
    : (Number(command.offset ?? base.offset ?? 0) || 0);
  const playbackAnchor = issuedAt + (["seek", "cue"].includes(String(command.action || "")) ? delayMs : 0);
  return {
    ...base,
    seq: Math.max(baseSeq, commandSeq),
    status,
    cassetteId: command.cassetteId ?? null,
    trackId: shuttleActive ? (command.shuttleSourceTrackId ?? command.trackId ?? null) : (command.trackId ?? null),
    offset,
    volume: command.volume ?? base.volume ?? 0.8,
    lidOpen: command.lidOpen ?? base.lidOpen ?? false,
    startedAt: status === "playing" ? playbackAnchor : null,
    pausedAt: status === "paused" ? playbackAnchor : null
  };
}

export function isPureVolumeDeckStateChange(previous, next) {
  if (!previous || !next) return false;
  if (!Number.isFinite(Number(next.volume))) return false;
  const stableKeys = ["status", "cassetteId", "trackId", "startedAt", "pausedAt", "offset", "lidOpen"];
  return stableKeys.every((key) => (previous?.[key] ?? null) === (next?.[key] ?? null));
}

export function formatTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "--:--";
  const total = Math.floor(value);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}


export function fixedTimeLabel(label) {
  const source = String(label ?? "--:--");
  const match = source.match(/^(\d{2}|--):(\d{2}|--)$/);
  if (match) return `${match[1]}:${match[2]}`;
  return "--:--";
}

export function timeSlots(label) {
  return fixedTimeLabel(label).split("").map((char, index) => ({
    index,
    char,
    digit: /\d/.test(char),
    separator: char === ":",
    blank: char === "-"
  }));
}

export function statusLabel(status) {
  switch (status) {
    case "playing": return "Воспроизведение";
    case "paused": return "Пауза";
    case "stopped": return "Остановлено";
    case "idle":
    default:
      return "Ожидание";
  }
}

export function preloadSummaryLabel(summary = {}) {
  const parts = [`preload: ${summary.strategy ?? "unknown"}`, `cache ${summary.cacheSize ?? 0}/${summary.maxEntries ?? 0}`];
  if (summary.ready) parts.push(`ready ${summary.ready}`);
  return parts.join(" · ");
}
