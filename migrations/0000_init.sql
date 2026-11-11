-- Tabelas do núcleo do Better Auth (nomes de coluna em camelCase, como o
-- gerador oficial emite para SQLite) + as tabelas da aplicação.
-- Todos os timestamps são unixepoch() em SEGUNDOS, para casar com o
-- drizzle `integer(..., { mode: "timestamp" })`.

CREATE TABLE "user" (
  "id"                 text    PRIMARY KEY NOT NULL,
  "name"               text    NOT NULL,
  "email"              text    NOT NULL UNIQUE,
  "emailVerified"      integer NOT NULL DEFAULT 0,
  "image"              text,
  "createdAt"          integer NOT NULL,
  "updatedAt"          integer NOT NULL,
  -- plugin admin
  "role"               text    NOT NULL DEFAULT 'user',
  "banned"             integer DEFAULT 0,
  "banReason"          text,
  "banExpires"         integer,
  -- campos da aplicação
  "phone"              text,
  CONSTRAINT "user_role_valid" CHECK ("role" IN ('admin', 'user', 'readonly'))
);

CREATE TABLE "session" (
  "id"             text    PRIMARY KEY NOT NULL,
  "token"          text    NOT NULL UNIQUE,
  "userId"         text    NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "expiresAt"      integer NOT NULL,
  "createdAt"      integer NOT NULL,
  "updatedAt"      integer NOT NULL,
  "ipAddress"      text,
  "userAgent"      text,
  "impersonatedBy" text
);
CREATE INDEX "session_userId_idx" ON "session" ("userId");

CREATE TABLE "account" (
  "id"                    text    PRIMARY KEY NOT NULL,
  "accountId"             text    NOT NULL,
  "providerId"            text    NOT NULL,
  "userId"                text    NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  integer,
  "refreshTokenExpiresAt" integer,
  "scope"                 text,
  "password"              text,
  "createdAt"             integer NOT NULL,
  "updatedAt"             integer NOT NULL
);
CREATE INDEX "account_userId_idx" ON "account" ("userId");

CREATE TABLE "verification" (
  "id"         text    PRIMARY KEY NOT NULL,
  "identifier" text    NOT NULL,
  "value"      text    NOT NULL,
  "expiresAt"  integer NOT NULL,
  "createdAt"  integer NOT NULL,
  "updatedAt"  integer NOT NULL
);
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

-- Rate limiting do Better Auth (storage: "database"). Uma tabela no D1 em vez
-- de KV: fonte única de verdade, sem consistência eventual atrapalhando.
CREATE TABLE "rateLimit" (
  "id"          text    PRIMARY KEY NOT NULL,
  "key"         text    NOT NULL UNIQUE,
  "count"       integer NOT NULL DEFAULT 0,
  -- milissegundos (Date.now()), não segundos: é o que o Better Auth grava.
  "lastRequest" integer NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Convites. Guardamos o SHA-256 do token, nunca o token em si: se o banco
-- vazar, ninguém consegue criar conta com o que está lá.
-- ---------------------------------------------------------------------------
CREATE TABLE "invitation" (
  "id"         text    PRIMARY KEY NOT NULL,
  "email"      text    NOT NULL,
  "role"       text    NOT NULL DEFAULT 'user',
  "tokenHash"  text    NOT NULL UNIQUE,
  "invitedBy"  text    REFERENCES "user" ("id") ON DELETE SET NULL,
  "createdAt"  integer NOT NULL,
  "expiresAt"  integer NOT NULL,
  "acceptedAt" integer,
  "revokedAt"  integer,
  CONSTRAINT "invitation_role_valid" CHECK ("role" IN ('admin', 'user', 'readonly'))
);

-- No máximo UM convite pendente por e-mail.
CREATE UNIQUE INDEX "invitation_one_pending_per_email"
  ON "invitation" ("email")
  WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;

-- ---------------------------------------------------------------------------
CREATE TABLE "audit_log" (
  "id"          text    PRIMARY KEY NOT NULL,
  "createdAt"   integer NOT NULL,
  "actorId"     text    REFERENCES "user" ("id") ON DELETE SET NULL,
  "actorEmail"  text,
  "action"      text    NOT NULL,
  "targetId"    text,
  "targetEmail" text,
  "details"     text,
  "ip"          text
);
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log" ("createdAt" DESC);

-- ---------------------------------------------------------------------------
-- MÓDULO DE DEMONSTRAÇÃO — recurso de negócio protegido, existe só para provar
-- que 'readonly' é barrado no servidor. Pode apagar tabela, página e endpoint.
-- ---------------------------------------------------------------------------
CREATE TABLE "note" (
  "id"        text    PRIMARY KEY NOT NULL,
  "title"     text    NOT NULL,
  "body"      text    NOT NULL DEFAULT '',
  "authorId"  text    REFERENCES "user" ("id") ON DELETE SET NULL,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL
);
