#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { abort, parseJsonc } from "./config.mjs";

/**
 * Gives a build that starts from a clean clone (Cloudflare Workers Builds, any
 * CI) this deploy's config.
 *
 * `wrangler.local.jsonc` holds the real ids and stays out of Git, so a clean
 * clone only has the template `wrangler.jsonc`: placeholder database id, empty
 * vars. Building that would publish a Worker with no database and no operator
 * data. The build service carries the file in the variable
 * WRANGLER_LOCAL_JSONC instead, and this script writes it before the build.
 *
 *   node scripts/ci-config.mjs           writes wrangler.local.jsonc from the variable
 *   node scripts/ci-config.mjs --print   prints the value to store in the variable
 *
 * It refuses to go on without a usable value: a failed build leaves the
 * version that is live alone, a build of the template would replace it.
 */
const LOCAL = "wrangler.local.jsonc";
const VARIABLE = "WRANGLER_LOCAL_JSONC";
const PLACEHOLDER = /^(|0{8}-0{4}-4000-8000-0{12})$/;

/**
 * Checks that a config is this deploy's and not the template's.
 * @param {unknown} config Parsed config.
 * @returns {string | null} What is wrong with it, or null when it can be used.
 */
function problem(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "it is not a JSON object";
  const { name, d1_databases: databases } = /** @type {Record<string, any>} */ (config);
  if (typeof name !== "string" || !name) return 'it has no Worker "name"';
  const id = String(databases?.[0]?.database_id ?? "");
  if (PLACEHOLDER.test(id)) return "its database_id is empty or the template placeholder";
  return null;
}

/**
 * Parses a config text and stops the process when it cannot be used.
 * @param {string} text JSON or JSONC.
 * @param {string} source Where the text came from, for the message.
 * @returns {Record<string, any>} The parsed config.
 */
function parse(text, source) {
  let config;
  try {
    config = parseJsonc(text);
  } catch {
    abort(`${source} is not valid JSON.`);
  }
  const wrong = problem(config);
  if (wrong) abort(`${source} cannot be used: ${wrong}.`);
  return config;
}

/**
 * Prints this machine's config as the one-line value for the build variable.
 * @returns {void}
 */
function print() {
  if (!existsSync(resolve(LOCAL))) abort(`There is no ${LOCAL} here to print.`);
  process.stdout.write(JSON.stringify(parse(readFileSync(resolve(LOCAL), "utf8"), LOCAL)) + "\n");
}

/**
 * Writes the config from the build variable, unless this machine has its own.
 * @returns {void}
 */
function write() {
  if (existsSync(resolve(LOCAL))) {
    console.log(`${LOCAL} is already here: left as it is.`);
    return;
  }
  const value = (process.env[VARIABLE] ?? "").trim();
  if (!value) {
    abort(
      [
        `No ${LOCAL} and no ${VARIABLE}.`,
        "",
        "This build would publish the template config (no database, no operator",
        "data). On the machine that deploys this project, run",
        "",
        "  npm run ci:config -- --print",
        "",
        `and store the output in the build variable ${VARIABLE}.`,
      ].join("\n"),
    );
  }
  const config = parse(value, VARIABLE);
  writeFileSync(resolve(LOCAL), JSON.stringify(config, null, 2) + "\n");
  console.log(`${LOCAL} written from ${VARIABLE} (Worker "${config.name}").`);
}

if (process.argv.includes("--print")) print();
else write();
