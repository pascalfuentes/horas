import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Este repositório é template E instalação ao mesmo tempo.
 *
 * `wrangler.jsonc` é a versão do TEMPLATE: vai para o Git com placeholders no
 * lugar dos ids. `wrangler.local.jsonc` é a versão DESTE deploy: fica fora do
 * Git com os valores reais. Quando existe, ele vence.
 *
 * Assim um clone novo não tem id de banco válido — `db:remote` falha alto em
 * vez de escrever no banco de produção de outro projeto por engano.
 */
export function configPath() {
  return existsSync(resolve("wrangler.local.jsonc")) ? "wrangler.local.jsonc" : "wrangler.jsonc";
}

/**
 * O id do template. A trava olha SÓ o id: renomear o banco não desarma a
 * proteção, e é o id que decide em qual banco o wrangler escreve.
 */
const PLACEHOLDER = /^(|0{8}-0{4}-4000-8000-0{12})$/;

/** Remove comentários de JSONC respeitando o que está dentro de strings. */
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

  // Vírgula sobrando antes de } ou ] é válida em JSONC, não em JSON.
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
    usandoPlaceholder: PLACEHOLDER.test(String(d1?.database_id ?? "")),
  };
}

export function abortar(mensagem) {
  console.error(`\n\x1b[31m✗\x1b[0m ${mensagem}\n`);
  process.exit(1);
}
