import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const ALLOWED = [/^git@github\.com$/i, /@example\.com$/i, /@users\.noreply\.github\.com$/i];

function files(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) =>
    name === "node_modules" || name === ".git" ? [] : files(join(path, name)),
  );
}

function text(path) {
  const data = readFileSync(path);
  return path.endsWith(".tgz") ? gunzipSync(data).toString("latin1") : data.toString("utf8");
}

const leaks = [];
for (const path of process.argv.slice(2).flatMap(files)) {
  for (const match of text(path).matchAll(EMAIL)) {
    if (!ALLOWED.some((rule) => rule.test(match[0]))) leaks.push(`${path}: ${match[0]}`);
  }
}
if (leaks.length > 0) {
  console.error(`Email addresses outside the allowlist:\n${leaks.join("\n")}`);
  process.exit(1);
}
console.log("No email address outside the allowlist.");
