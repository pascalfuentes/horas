import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * This repository is a template AND an installation at the same time.
 *
 * `wrangler.jsonc` is the TEMPLATE version: it goes to Git with placeholders
 * in place of the ids. `wrangler.local.jsonc` is THIS deploy's version: it
 * stays out of Git with the real values. When it exists, it wins.
 *
 * That way a new clone has no valid database id: `db:remote` fails loudly
 * instead of writing to another project's production database by mistake.
 */
export function configPath() {
  return existsSync(resolve("wrangler.local.jsonc")) ? "wrangler.local.jsonc" : "wrangler.jsonc";
}

/**
 * The template id. The guard looks ONLY at the id: renaming the database does
 * not disarm the protection, and the id is what decides which database
 * wrangler writes to.
 */
const PLACEHOLDER = /^(|0{8}-0{4}-4000-8000-0{12})$/;

/** Strips JSONC comments while respecting what is inside strings. */
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { out += next ?? ""; i++; }
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    out += c;
  }

  // A trailing comma before } or ] is valid in JSONC, not in JSON.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function readConfig() {
  const path = configPath();
  const config = parseJsonc(readFileSync(resolve(path), "utf8"));
  const d1 = config.d1_databases?.[0];

  return {
    path,
    workerName: config.name,
    databaseName: d1?.database_name,
    databaseId: d1?.database_id,
    turnstileSiteKey: config.vars?.PUBLIC_TURNSTILE_SITE_KEY,
    usingPlaceholder: PLACEHOLDER.test(String(d1?.database_id ?? "")),
  };
}

export function abort(message) {
  console.error(`\n\x1b[31m✗\x1b[0m ${message}\n`);
  process.exit(1);
}
