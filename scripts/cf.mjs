#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { configPath } from "./config.mjs";

/**
 * Roda `wrangler` apontando para a config certa — wrangler.local.jsonc neste
 * deploy, wrangler.jsonc num clone recém-saído do template.
 *
 *   npm run cf -- secret put MINHA_CHAVE
 *   npm run cf -- tail
 *
 * `deploy` e `dev` são exceção: eles consomem a config que o BUILD gerou em
 * dist/server/wrangler.json, e o wrangler chega lá por um redirect em
 * .wrangler/deploy/config.json. Passar `-c` sobrescreve esse redirect e o
 * wrangler perde o entry-point ("Missing entry-point"). Esses dois já usam a
 * config certa de qualquer jeito, porque o build a lê via astro.config.mjs.
 */
const USA_CONFIG_DO_BUILD = new Set(["deploy", "dev"]);

const args = process.argv.slice(2);
const comando = args.find((a) => !a.startsWith("-"));
const completos = USA_CONFIG_DO_BUILD.has(comando ?? "")
  ? ["wrangler", ...args]
  : ["wrangler", ...args, "-c", configPath()];

process.exit(spawnSync("npx", completos, { stdio: "inherit" }).status ?? 1);
