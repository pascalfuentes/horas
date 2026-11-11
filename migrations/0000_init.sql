-- Better Auth core tables (camelCase column names, as the official
-- generator emits for SQLite) + the application tables.
-- All timestamps are unixepoch() in SECONDS, to match drizzle's
-- `integer(..., { mode: "timestamp" })`.

CREATE TABLE "user" (
  "id"                 text    PRIMARY KEY NOT NULL,
  "name"               text    NOT NULL,
  "email"              text    NOT NULL UNIQUE,
  "emailVerified"      integer NOT NULL DEFAULT 0,
  "image"              text,
  "createdAt"          integer NOT NULL,
  "updatedAt"          integer NOT NULL,
  -- admin plugin
  "role"               text    NOT NULL DEFAULT 'user',
  "banned"             integer DEFAULT 0,
  "banReason"          text,
  "banExpires"         integer,
  -- application fields
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

-- Better Auth rate limiting (storage: "database"). A table in D1 instead
-- of KV: single source of truth, no eventual consistency getting in the way.
CREATE TABLE "rateLimit" (
  "id"          text    PRIMARY KEY NOT NULL,
  "key"         text    NOT NULL UNIQUE,
  "count"       integer NOT NULL DEFAULT 0,
  -- milliseconds (Date.now()), not seconds: that is what Better Auth writes.
  "lastRequest" integer NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Invitations. We store the SHA-256 of the token, never the token itself: if
-- the database leaks, nobody can create an account with what is in there.
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

-- At most ONE pending invitation per e-mail.
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
-- DEMO MODULE: a protected business resource that exists only to prove that
-- 'readonly' is blocked on the server. Table, page and endpoint can be deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE "note" (
  "id"        text    PRIMARY KEY NOT NULL,
  "title"     text    NOT NULL,
  "body"      text    NOT NULL DEFAULT '',
  "authorId"  text    REFERENCES "user" ("id") ON DELETE SET NULL,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL
);
