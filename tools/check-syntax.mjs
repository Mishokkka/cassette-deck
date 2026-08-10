import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function collectMjs(root) {
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...collectMjs(path));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) result.push(path);
  }
  return result;
}

let failed = false;
for (const file of collectMjs(".")) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed = true;
    console.error(result.stderr || result.stdout || `Syntax check failed: ${file}`);
  }
}

if (failed) process.exit(1);
console.log("Syntax check passed.");
