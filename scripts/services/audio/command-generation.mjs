export function normalizeVolume(volume, multiplier = 1) {
  const value = Number(volume ?? 0.8) * Number(multiplier ?? 1);
  if (!Number.isFinite(value)) return 0.8;
  return Math.min(1, Math.max(0, value));
}

export function commandMayMutatePlayback(command = {}, { activePath = null, hasActiveHandle = false } = {}) {
  const action = String(command.action || "");
  if (action === "volume" || action === "noop" || action === "closeLid") return false;

  if (action === "sync") {
    // A same-track playing sync pulse is corrective, not a new transport intent.
    // Treating it as mutating can cancel a fresh play startup/fade and leave
    // native media muted until a later volume command touches the element.
    if (command.status === "playing" && command.path && hasActiveHandle && activePath === command.path) return false;
  }

  return true;
}

export function makeCommandEpochContext(epoch, getCurrentEpoch) {
  const isCurrent = () => epoch === getCurrentEpoch?.();
  return { epoch, isCurrent };
}
