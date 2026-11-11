#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { configPath } from "./config.mjs";

/**
 * Runs `wrangler` pointing at the right config: wrangler.local.jsonc in this
 * deploy, wrangler.jsonc in a clone fresh out of the template.
 *
 *   npm run cf -- secret put MY_KEY
 *   npm run cf -- tail
 *
 * `deploy` and `dev` are the exception: they consume the config that the BUILD
 * generated in dist/server/wrangler.json, and wrangler gets there through a
 * redirect in .wrangler/deploy/config.json. Passing `-c` overrides that
 * redirect and wrangler loses the entry-point ("Missing entry-point"). Those
 * two already use the right config anyway, because the build reads it via
 * astro.config.mjs.
 */
const USES_BUILD_CONFIG = new Set(["deploy", "dev"]);

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("-"));
const fullArgs = USES_BUILD_CONFIG.has(command ?? "")
  ? ["wrangler", ...args]
  : ["wrangler", ...args, "-c", configPath()];

process.exit(spawnSync("npx", fullArgs, { stdio: "inherit" }).status ?? 1);
