#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { abortar, parseJsonc } from "./config.mjs";

/**
 * Transforma um clone do template num projeto novo.
 *
 * Escreve `wrangler.local.jsonc` (fora do Git) com os ids reais e ajusta o
 * nome da aplicação. O `wrangler.jsonc` versionado continua com placeholders,
 * para que o próximo clone também comece sem id de banco válido.
 */

const c = (cor, t) => `\x1b[${cor}m${t}\x1b[0m`;

/**
 * Modo não-interativo, para automação e para os testes:
 *
 *   node scripts/novo-projeto.mjs --nome "Meu App" --id <uuid> [--worker x]
 *                                 [--banco x] [--sitekey x] [--sem-banco] [--forcar]
 *
 * Fora de um terminal, perguntar não funciona — então em vez de travar
 * esperando uma resposta que nunca vem, o script diz qual flag faltou.
 */
const flags = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const chave = a.slice(2);
  const prox = process.argv[i + 1];
  if (prox && !prox.startsWith("--")) { flags[chave] = prox; i++; }
  else flags[chave] = true;
}

const interativo = process.stdin.isTTY === true;
const rl = interativo ? createInterface({ input: process.stdin, output: process.stdout }) : null;

const perguntar = async (label, padrao, flag) => {
  if (flag && flags[flag] !== undefined && flags[flag] !== true) return String(flags[flag]);
  // `padrao` pode ser "" legitimamente (sitekey vazia = sem Turnstile), então
  // a checagem é por `undefined`, não por valor falsy.
  if (!interativo) {
    if (padrao !== undefined) return padrao;
    abortar(`Sem terminal para perguntar "${label}". Passe --${flag ?? "?"} na linha de comando.`);
  }
  const r = (await rl.question(`  ${label}${padrao ? ` ${c(90, `[${padrao}]`)}` : ""}: `)).trim();
  return r || padrao || "";
};

/** `flagNao` desliga: `--sem-banco` sempre responde não, nunca o contrário. */
const confirmar = async (label, padrao, flagNao) => {
  if (flagNao && flags[flagNao]) return false;
  if (!interativo) return padrao;
  const r = (await rl.question(`  ${label} ${c(90, padrao ? "[S/n]" : "[s/N]")}: `)).trim().toLowerCase();
  return r ? r === "s" : padrao;
};
const slug = (s) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
   .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

console.log(`\n${c(1, "Novo projeto a partir do template")}\n`);

if (existsSync("wrangler.local.jsonc") && !flags.forcar) {
  const atual = parseJsonc(readFileSync("wrangler.local.jsonc", "utf8"));
  console.log(c(33, `  Já existe wrangler.local.jsonc (worker "${atual.name}").`));
  if (!(await confirmar("Sobrescrever?", false))) {
    rl?.close();
    console.log("\n  Nada alterado.\n");
    process.exit(0);
  }
  console.log();
}

const appName = await perguntar("Nome da aplicação (aparece na interface)", flags.nome ? undefined : "Minha Aplicação", "nome");
const workerName = await perguntar("Nome do Worker", slug(appName), "worker");
const dbName = await perguntar("Nome do banco D1", `${slug(appName).replace(/-/g, "_")}_db`, "banco");

// --- banco ---
let databaseId = "";
console.log();
if (await confirmar(`Criar o banco D1 "${dbName}" agora?`, true, "sem-banco")) {
  console.log(c(90, `\n  $ wrangler d1 create ${dbName}`));
  spawnSync("npx", ["wrangler", "d1", "create", dbName], { stdio: "inherit" });

  const listagem = spawnSync("npx", ["wrangler", "d1", "list", "--json"], { encoding: "utf8" });
  try {
    databaseId = JSON.parse(listagem.stdout).find((d) => d.name === dbName)?.uuid ?? "";
  } catch {
    /* cai no prompt manual abaixo */
  }
}
if (!databaseId) databaseId = await perguntar("database_id (wrangler d1 list)", undefined, "id");
if (!databaseId) {
  rl?.close();
  abortar("Sem database_id não dá para continuar. Rode de novo depois de criar o banco.");
}

const siteKey = await perguntar("Sitekey do Turnstile (vazio = sem Turnstile)", "", "sitekey");
rl?.close();

// --- escreve wrangler.local.jsonc a partir do template ---
//
// As substituições casam pela CHAVE, não pelo valor placeholder. Casar pelo
// valor já quebrou uma vez: mudei os placeholders no template, as substituições
// deixaram de encontrar nada, e o arquivo saiu com a config do template — sem
// nenhum erro. Por isso o resultado é conferido logo abaixo.
const trocar = (texto, chave, valor) =>
  texto.replace(new RegExp(`("${chave}":\\s*)"[^"]*"`), `$1${JSON.stringify(valor)}`);

let local = readFileSync("wrangler.jsonc", "utf8").replace(
  /^\/\/ Versão do TEMPLATE[\s\S]*?\n(?=\{)/m,
  "// Config DESTE deploy. Fora do Git (ver .gitignore).\n" +
    "// Quando existe, vence sobre o wrangler.jsonc, que é a versão do template.\n",
);
local = trocar(local, "name", workerName);
local = trocar(local, "database_name", dbName);
local = trocar(local, "database_id", databaseId);
local = trocar(local, "PUBLIC_TURNSTILE_SITE_KEY", siteKey);
writeFileSync("wrangler.local.jsonc", local);

// Relê do disco: se alguma substituição não pegou, falha agora e alto.
{
  const escrito = parseJsonc(readFileSync("wrangler.local.jsonc", "utf8"));
  const d1 = escrito.d1_databases?.[0] ?? {};
  const erros = [
    escrito.name !== workerName && `name ficou "${escrito.name}"`,
    d1.database_name !== dbName && `database_name ficou "${d1.database_name}"`,
    d1.database_id !== databaseId && `database_id ficou "${d1.database_id}"`,
  ].filter(Boolean);
  if (erros.length) {
    abortar(
      `wrangler.local.jsonc saiu errado (${erros.join("; ")}).\n` +
        "Provavelmente as chaves do wrangler.jsonc mudaram de formato.",
    );
  }
}

writeFileSync("src/config.ts",
  readFileSync("src/config.ts", "utf8").replace(/export const APP_NAME = ".*";/, `export const APP_NAME = ${JSON.stringify(appName)};`));

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.name = workerName;
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`
${c(32, "✓")} wrangler.local.jsonc  ${c(90, `worker "${workerName}", banco "${dbName}"`)}
${c(32, "✓")} src/config.ts         ${c(90, `APP_NAME = "${appName}"`)}
${c(32, "✓")} package.json          ${c(90, `name = "${workerName}"`)}

${c(1, "Falta:")}

  1. cp .dev.vars.example .dev.vars   ${c(90, "e preencha os dois secrets")}
  2. npm run db:local                 ${c(90, "migrations no banco local")}
  3. npm run dev                      ${c(90, "abra /setup e crie o primeiro admin")}

  Para produção, depois:

  4. npm run db:remote
  5. npx wrangler secret put BETTER_AUTH_SECRET   ${c(90, "openssl rand -base64 32")}
     npx wrangler secret put BETTER_AUTH_URL      ${c(90, "a URL pública final")}
     npx wrangler secret put SETUP_SECRET         ${c(90, "apague depois do 1º admin")}
     npx wrangler secret put RESEND_API_KEY
     npx wrangler secret put EMAIL_FROM
  6. npm run deploy
`);
