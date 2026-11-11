#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { abort, parseJsonc } from "./config.mjs";

/**
 * Turns a clone of the template into a new project.
 *
 * Writes `wrangler.local.jsonc` (out of Git) with the real ids and sets the
 * application name. The versioned `wrangler.jsonc` keeps its placeholders, so
 * that the next clone also starts without a valid database id.
 */

const c = (color, t) => `\x1b[${color}m${t}\x1b[0m`;

/**
 * Non-interactive mode, for automation and for the tests:
 *
 *   node scripts/new-project.mjs --name "My App" --id <uuid> [--worker x]
 *                                 [--database x] [--sitekey x] [--no-database] [--force]
 *
 * Outside a terminal, asking does not work. So instead of hanging while
 * waiting for an answer that never comes, the script says which flag is missing.
 */
const flags = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { flags[key] = next; i++; }
  else flags[key] = true;
}

const interactive = process.stdin.isTTY === true;
const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

const ask = async (label, fallback, flag) => {
  if (flag && flags[flag] !== undefined && flags[flag] !== true) return String(flags[flag]);
  // `fallback` can legitimately be "" (empty sitekey = no Turnstile), so the
  // check is for `undefined`, not for a falsy value.
  if (!interactive) {
    if (fallback !== undefined) return fallback;
    abort(`No terminal to ask "${label}". Pass --${flag ?? "?"} on the command line.`);
  }
  const r = (await rl.question(`  ${label}${fallback ? ` ${c(90, `[${fallback}]`)}` : ""}: `)).trim();
  return r || fallback || "";
};

/** `noFlag` turns it off: `--no-database` always answers no, never the opposite. */
const askYesNo = async (label, fallback, noFlag) => {
  if (noFlag && flags[noFlag]) return false;
  if (!interactive) return fallback;
  const r = (await rl.question(`  ${label} ${c(90, fallback ? "[Y/n]" : "[y/N]")}: `)).trim().toLowerCase();
  return r ? r === "y" : fallback;
};
const slug = (s) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
   .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

console.log(`\n${c(1, "New project from the template")}\n`);

if (existsSync("wrangler.local.jsonc") && !flags.force) {
  const current = parseJsonc(readFileSync("wrangler.local.jsonc", "utf8"));
  console.log(c(33, `  wrangler.local.jsonc already exists (worker "${current.name}").`));
  if (!(await askYesNo("Overwrite?", false))) {
    rl?.close();
    console.log("\n  Nothing changed.\n");
    process.exit(0);
  }
  console.log();
}

const appName = await ask("Application name (shown in the interface)", flags.name ? undefined : "My Application", "name");
const workerName = await ask("Worker name", slug(appName), "worker");
const dbName = await ask("D1 database name", `${slug(appName).replace(/-/g, "_")}_db`, "database");

// --- database ---
let databaseId = "";
console.log();
if (await askYesNo(`Create the D1 database "${dbName}" now?`, true, "no-database")) {
  console.log(c(90, `\n  $ wrangler d1 create ${dbName}`));
  spawnSync("npx", ["wrangler", "d1", "create", dbName], { stdio: "inherit" });

  const listing = spawnSync("npx", ["wrangler", "d1", "list", "--json"], { encoding: "utf8" });
  try {
    databaseId = JSON.parse(listing.stdout).find((d) => d.name === dbName)?.uuid ?? "";
  } catch {
    /* falls through to the manual prompt below */
  }
}
if (!databaseId) databaseId = await ask("database_id (wrangler d1 list)", undefined, "id");
if (!databaseId) {
  rl?.close();
  abort("Cannot continue without a database_id. Run again after creating the database.");
}

const siteKey = await ask("Turnstile sitekey (empty = no Turnstile)", "", "sitekey");
rl?.close();

// --- writes wrangler.local.jsonc from the template ---
//
// The replacements match by KEY, not by the placeholder value. Matching by
// value already broke once: I changed the placeholders in the template, the
// replacements stopped finding anything, and the file came out with the
// template config, without any error. That is why the result is checked right
// below.
const replaceValue = (text, key, value) =>
  text.replace(new RegExp(`("${key}":\\s*)"[^"]*"`), `$1${JSON.stringify(value)}`);

let local = readFileSync("wrangler.jsonc", "utf8").replace(
  /^\/\/ TEMPLATE version[\s\S]*?\n(?=\{)/m,
  "// THIS deploy's config. Out of Git (see .gitignore).\n" +
    "// When it exists, it wins over wrangler.jsonc, which is the template version.\n",
);
local = replaceValue(local, "name", workerName);
local = replaceValue(local, "database_name", dbName);
local = replaceValue(local, "database_id", databaseId);
local = replaceValue(local, "PUBLIC_TURNSTILE_SITE_KEY", siteKey);
writeFileSync("wrangler.local.jsonc", local);

// Re-reads from disk: if any replacement did not take, fail now and loudly.
{
  const written = parseJsonc(readFileSync("wrangler.local.jsonc", "utf8"));
  const d1 = written.d1_databases?.[0] ?? {};
  const errors = [
    written.name !== workerName && `name ended up as "${written.name}"`,
    d1.database_name !== dbName && `database_name ended up as "${d1.database_name}"`,
    d1.database_id !== databaseId && `database_id ended up as "${d1.database_id}"`,
  ].filter(Boolean);
  if (errors.length) {
    abort(
      `wrangler.local.jsonc came out wrong (${errors.join("; ")}).\n` +
        "The keys in wrangler.jsonc probably changed format.",
    );
  }
}

writeFileSync("src/config.ts",
  readFileSync("src/config.ts", "utf8").replace(/export const APP_NAME = ".*";/, `export const APP_NAME = ${JSON.stringify(appName)};`));

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.name = workerName;
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`
${c(32, "✓")} wrangler.local.jsonc  ${c(90, `worker "${workerName}", database "${dbName}"`)}
${c(32, "✓")} src/config.ts         ${c(90, `APP_NAME = "${appName}"`)}
${c(32, "✓")} package.json          ${c(90, `name = "${workerName}"`)}

${c(1, "Remaining:")}

  1. cp .dev.vars.example .dev.vars   ${c(90, "and fill in the two secrets")}
  2. npm run db:local                 ${c(90, "migrations on the local database")}
  3. npm run dev                      ${c(90, "open /setup and create the first admin")}

  For production, later:

  4. npm run db:remote
  5. npx wrangler secret put BETTER_AUTH_SECRET   ${c(90, "openssl rand -base64 32")}
     npx wrangler secret put BETTER_AUTH_URL      ${c(90, "the final public URL")}
     npx wrangler secret put SETUP_SECRET         ${c(90, "delete after the 1st admin")}
     npx wrangler secret put RESEND_API_KEY
     npx wrangler secret put EMAIL_FROM
  6. npm run deploy
`);
