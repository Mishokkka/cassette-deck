export function saveJsonFile(payload, filename, { indent = 2 } = {}) {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload ?? {}, null, indent);
  const type = "application/json";

  if (typeof globalThis.foundry?.utils?.saveDataToFile === "function") {
    globalThis.foundry.utils.saveDataToFile(data, type, filename);
    return true;
  }

  if (typeof globalThis.saveDataToFile === "function") {
    globalThis.saveDataToFile(data, type, filename);
    return true;
  }

  const url = URL.createObjectURL(new Blob([data], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}
