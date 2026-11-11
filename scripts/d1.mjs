#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { abort, configPath, readConfig } from "./config.mjs";

/**
 * Applies the migrations. It exists instead of a raw `wrangler ...` in
 * package.json for two reasons: it reads the database name from the config (so
 * renaming the database does not break the scripts) and it refuses to run
 * against production while the id is the template placeholder.
 */
const argv = process.argv.slice(2);
const remote = argv.includes("--remote");
const sql = argv.includes("--sql");
const config = readConfig();

if (!config.databaseName) {
  abort(`No D1 database configured in ${config.path}.`);
}

if (remote && config.usingPlaceholder) {
  abort(
    [
      "This project still has the template database_id.",
      "",
      "Applying migrations to production now would do nothing useful, or worse,",
      "would write to another project's database. Create this project's database:",
      "",
      "  npx wrangler d1 create <database-name>",
      "",
      `and run \`npm run new-project\` to write the id to ${config.path}.`,
    ].join("\n"),
  );
}

if (sql) {
  const query = argv[argv.indexOf("--sql") + 1];
  if (!query) abort('Pass the query: npm run db:sql -- "SELECT * FROM user"');
  const flags = [remote ? "--remote" : "--local", "--command", query, "-c", configPath()];
  process.exit(
    spawnSync("npx", ["wrangler", "d1", "execute", config.databaseName, ...flags], { stdio: "inherit" }).status ?? 1,
  );
}

const target = remote ? "\x1b[33mPRODUCTION\x1b[0m" : "local";
console.log(`\nMigrations → ${config.databaseName} (${target})`);
if (remote) console.log(`  id: ${config.databaseId}\n`);

const args = ["wrangler", "d1", "migrations", "apply", config.databaseName,
              remote ? "--remote" : "--local", "-c", configPath()];
process.exit(spawnSync("npx", args, { stdio: "inherit" }).status ?? 1);
