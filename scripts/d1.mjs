#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { abortar, configPath, readConfig } from "./config.mjs";

/**
 * Aplica as migrations. Existe em vez de um `wrangler ...` cru no package.json
 * por dois motivos: lê o nome do banco da config (então renomear o banco não
 * quebra os scripts) e recusa rodar contra produção enquanto o id for o
 * placeholder do template.
 */
const argv = process.argv.slice(2);
const remoto = argv.includes("--remote");
const sql = argv.includes("--sql");
const config = readConfig();

if (!config.databaseName) {
  abortar(`Nenhum banco D1 configurado em ${config.path}.`);
}

if (remoto && config.usandoPlaceholder) {
  abortar(
    [
      "Este projeto ainda está com o database_id do template.",
      "",
      "Aplicar migrations em produção agora não faria nada de útil — ou pior,",
      "escreveria no banco de outro projeto. Crie o banco deste projeto:",
      "",
      "  npx wrangler d1 create <nome-do-banco>",
      "",
      `e rode \`npm run new-project\` para gravar o id em ${config.path}.`,
    ].join("\n"),
  );
}

if (sql) {
  const query = argv[argv.indexOf("--sql") + 1];
  if (!query) abortar('Passe a consulta: npm run db:sql -- "SELECT * FROM user"');
  const flags = [remoto ? "--remote" : "--local", "--command", query, "-c", configPath()];
  process.exit(
    spawnSync("npx", ["wrangler", "d1", "execute", config.databaseName, ...flags], { stdio: "inherit" }).status ?? 1,
  );
}

const alvo = remoto ? "\x1b[33mPRODUÇÃO\x1b[0m" : "local";
console.log(`\nMigrations → ${config.databaseName} (${alvo})`);
if (remoto) console.log(`  id: ${config.databaseId}\n`);

const args = ["wrangler", "d1", "migrations", "apply", config.databaseName,
              remoto ? "--remote" : "--local", "-c", configPath()];
process.exit(spawnSync("npx", args, { stdio: "inherit" }).status ?? 1);
