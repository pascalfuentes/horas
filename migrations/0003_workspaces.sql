-- Multi-tenant: each customer now has its own workspace.
--
-- The three tables below belong to Better Auth's `organization` plugin. The
-- column names come from the RUNTIME (dist/plugins/organization/organization.mjs),
-- not from the .d.mts files: they differ in two fields, and the runtime is what
-- generates migrations and validates.
--
-- None of them has `updatedAt`: the plugin does not write that field.

CREATE TABLE "organization" (
  "id"        text    PRIMARY KEY NOT NULL,
  "name"      text    NOT NULL,
  "slug"      text    NOT NULL UNIQUE,
  "logo"      text,
  "createdAt" integer NOT NULL,
  -- JSON serialized by the plugin itself.
  "metadata"  text
);
CREATE INDEX "organization_slug_idx" ON "organization" ("slug");

CREATE TABLE "member" (
  "id"             text    PRIMARY KEY NOT NULL,
  "organizationId" text    NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "userId"         text    NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "role"           text    NOT NULL DEFAULT 'viewer',
  "createdAt"      integer NOT NULL
);
CREATE INDEX "member_organizationId_idx" ON "member" ("organizationId");
CREATE INDEX "member_userId_idx"         ON "member" ("userId");
-- A person joins each workspace only once.
CREATE UNIQUE INDEX "member_um_por_workspace" ON "member" ("organizationId", "userId");

-- The plugin calls this table "invitation", which collides with this
-- project's global invitations table (`tokenHash` NOT NULL UNIQUE, CHECK on role).
-- Renamed via `schema.invitation.modelName` in src/lib/auth.ts.
CREATE TABLE "org_invitation" (
  "id"             text    PRIMARY KEY NOT NULL,
  "organizationId" text    NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "email"          text    NOT NULL,
  -- Nullable on purpose: that is what the runtime declares.
  "role"           text,
  -- The adapter writes `teamId` even with teams turned off. The column exists
  -- so that this does not become a production error on the first invitation.
  "teamId"         text,
  "status"         text    NOT NULL DEFAULT 'pending',
  "expiresAt"      integer NOT NULL,
  "createdAt"      integer NOT NULL,
  "inviterId"      text    NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);
CREATE INDEX "org_invitation_organizationId_idx" ON "org_invitation" ("organizationId");
CREATE INDEX "org_invitation_email_idx"          ON "org_invitation" ("email");

-- The session's active workspace. It exists to REMEMBER the last one used, never
-- to authorize: authorization comes from the slug in the URL, checked against membership.
ALTER TABLE "session" ADD COLUMN "activeOrganizationId" text;

-- All business data now belongs to a workspace.
ALTER TABLE "note" ADD COLUMN "workspaceId" text REFERENCES "organization" ("id") ON DELETE CASCADE;
-- Audit is SET NULL, not CASCADE: deleting a workspace must not delete the
-- record that it existed and of who did what in it.
ALTER TABLE "audit_log" ADD COLUMN "workspaceId" text REFERENCES "organization" ("id") ON DELETE SET NULL;

CREATE INDEX "note_workspaceId_idx"      ON "note" ("workspaceId");
CREATE INDEX "audit_log_workspaceId_idx" ON "audit_log" ("workspaceId");
