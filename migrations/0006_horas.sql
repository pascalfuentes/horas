-- Módulo de controle de tempo.
--
-- Projetos são do WORKSPACE (compartilhados entre os membros). Entradas de
-- tempo são de UMA PESSOA dentro de um workspace: cada membro vê e edita só as
-- próprias horas.
--
-- Datas de entrada (`start`, `end`) são texto ISO-8601 em UTC. Comparar e
-- ordenar como texto funciona, e o fuso de quem lê é aplicado na aplicação.

CREATE TABLE "time_project" (
  "id"          integer PRIMARY KEY AUTOINCREMENT,
  "workspaceId" text    NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "name"        text    NOT NULL COLLATE NOCASE,
  "client"      text    NOT NULL DEFAULT '',
  "color"       text    NOT NULL DEFAULT '#3b82f6',
  "archived"    integer NOT NULL DEFAULT 0,
  "createdAt"   text    NOT NULL
);
CREATE UNIQUE INDEX "time_project_workspace_name_idx" ON "time_project" ("workspaceId", "name");

CREATE TABLE "time_entry" (
  "id"          integer PRIMARY KEY AUTOINCREMENT,
  "workspaceId" text    NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "userId"      text    NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "projectId"   integer REFERENCES "time_project" ("id") ON DELETE SET NULL,
  "description" text    NOT NULL DEFAULT '',
  "tags"        text    NOT NULL DEFAULT '[]',
  "billable"    integer NOT NULL DEFAULT 0,
  "start"       text    NOT NULL,
  -- NULL = timer rodando. No máximo um por pessoa por workspace (ver índice).
  "end"         text,
  "createdAt"   text    NOT NULL
);
CREATE INDEX "time_entry_owner_start_idx" ON "time_entry" ("workspaceId", "userId", "start");
-- Garante no banco que ninguém tem dois timers rodando no mesmo workspace,
-- mesmo com duas requisições simultâneas (a web e o MCP, por exemplo).
CREATE UNIQUE INDEX "time_entry_one_running_idx" ON "time_entry" ("workspaceId", "userId") WHERE "end" IS NULL;

-- Tokens pessoais de API/MCP. O token em claro só existe na resposta que o
-- cria; aqui fica o SHA-256. Cada token vale para UMA pessoa em UM workspace,
-- e o papel dela é conferido a cada requisição (não é copiado para o token).
CREATE TABLE "api_token" (
  "id"          text PRIMARY KEY NOT NULL,
  "userId"      text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "workspaceId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "name"        text NOT NULL,
  "tokenHash"   text NOT NULL UNIQUE,
  -- Primeiros caracteres, só para a pessoa reconhecer qual token é qual.
  "prefix"      text NOT NULL,
  -- Fuso de quem criou: define "hoje" e interpreta datas sem offset vindas da IA.
  "timezone"    text NOT NULL DEFAULT 'America/Sao_Paulo',
  "createdAt"   text NOT NULL,
  "lastUsedAt"  text
);
CREATE INDEX "api_token_userId_idx" ON "api_token" ("userId");
