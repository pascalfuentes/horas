-- Time tracking module.
--
-- Projects belong to the WORKSPACE (shared among members). Time entries
-- belong to ONE PERSON inside a workspace: each member sees and edits only
-- their own hours.
--
-- Entry dates (`start`, `end`) are ISO-8601 text in UTC. Comparing and sorting
-- as text works, and the reader's time zone is applied in the application.

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
  -- NULL = timer running. At most one per person per workspace (see index).
  "end"         text,
  "createdAt"   text    NOT NULL
);
CREATE INDEX "time_entry_owner_start_idx" ON "time_entry" ("workspaceId", "userId", "start");
-- Guarantees in the database that nobody has two timers running in the same
-- workspace, even with two simultaneous requests (the web and MCP, for example).
CREATE UNIQUE INDEX "time_entry_one_running_idx" ON "time_entry" ("workspaceId", "userId") WHERE "end" IS NULL;

-- Personal API/MCP tokens. The plaintext token only exists in the response that
-- creates it; the SHA-256 is stored here. Each token is valid for ONE person in
-- ONE workspace, and their role is checked on every request (not copied into the token).
CREATE TABLE "api_token" (
  "id"          text PRIMARY KEY NOT NULL,
  "userId"      text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "workspaceId" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "name"        text NOT NULL,
  "tokenHash"   text NOT NULL UNIQUE,
  -- First characters, only so the person can tell which token is which.
  "prefix"      text NOT NULL,
  -- Creator's time zone: defines "today" and interprets dates without an offset coming from the AI.
  "timezone"    text NOT NULL DEFAULT 'America/Sao_Paulo',
  "createdAt"   text NOT NULL,
  "lastUsedAt"  text
);
CREATE INDEX "api_token_userId_idx" ON "api_token" ("userId");
