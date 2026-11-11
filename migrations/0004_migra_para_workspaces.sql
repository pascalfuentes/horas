-- Data migration for an installation that already exists.
--
-- Runs BEFORE the invariant triggers (0005) on purpose: the trigger that
-- validates `user.role` would reject the very UPDATE that takes 'readonly' out
-- of circulation. Order: schema → data → invariants.
--
-- On a new installation (empty database) nothing here has any effect: every
-- INSERT is guarded by `WHERE EXISTS (SELECT 1 FROM "user")`.

-- ---------------------------------------------------------------------------
-- 1. Initial workspace
--
-- The current installation is one team in a single space, and that is what we
-- preserve. We do not create a personal workspace for existing people: it would
-- invent structure nobody asked for and leave workspaces empty forever. Only a
-- NEW signup gets an automatic personal workspace.
--
-- Rename it later through the interface; the fixed id only lets this migration
-- reference itself without depending on a generated value.
-- ---------------------------------------------------------------------------
INSERT INTO "organization" ("id", "name", "slug", "createdAt")
SELECT 'ws_inicial', 'Workspace Inicial', 'workspace-inicial', unixepoch()
WHERE EXISTS (SELECT 1 FROM "user");

-- ---------------------------------------------------------------------------
-- 2. Everyone becomes a member, with roles mapped
--
--   oldest admin      → owner   (only one: 'owner' carries deleting the workspace
--                                and transferring ownership, a power that must not
--                                be handed out by a migration accident)
--   other admins      → admin
--   user              → editor
--   readonly          → viewer
--
-- If the installation has no admin at all, the oldest user becomes owner;
-- otherwise the workspace would start without an owner and violate the 0005 invariant.
-- ---------------------------------------------------------------------------
INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
SELECT lower(hex(randomblob(16))), 'ws_inicial', u."id",
  CASE
    WHEN u."id" = COALESCE(
      (SELECT "id" FROM "user" WHERE "role" = 'admin' ORDER BY "createdAt", "id" LIMIT 1),
      (SELECT "id" FROM "user" ORDER BY "createdAt", "id" LIMIT 1)
    ) THEN 'owner'
    WHEN u."role" = 'admin'    THEN 'admin'
    WHEN u."role" = 'readonly' THEN 'viewer'
    ELSE 'editor'
  END,
  unixepoch()
FROM "user" u
WHERE EXISTS (SELECT 1 FROM "organization" WHERE "id" = 'ws_inicial');

-- ---------------------------------------------------------------------------
-- 3. Pending invitations become invitations to the initial workspace
--
-- `inviterId` is NOT NULL in the plugin; when the original invitation has no
-- `invitedBy` (the /setup case), it falls back to the workspace owner.
-- ---------------------------------------------------------------------------
INSERT INTO "org_invitation"
  ("id", "organizationId", "email", "role", "status", "expiresAt", "createdAt", "inviterId")
SELECT i."id", 'ws_inicial', i."email",
  CASE i."role" WHEN 'admin' THEN 'admin' WHEN 'readonly' THEN 'viewer' ELSE 'editor' END,
  'pending', i."expiresAt", i."createdAt",
  COALESCE(
    i."invitedBy",
    (SELECT "userId" FROM "member" WHERE "organizationId" = 'ws_inicial' AND "role" = 'owner' LIMIT 1)
  )
FROM "invitation" i
WHERE i."acceptedAt" IS NULL
  AND i."revokedAt" IS NULL
  AND i."expiresAt" > unixepoch()
  AND EXISTS (SELECT 1 FROM "organization" WHERE "id" = 'ws_inicial');

-- ---------------------------------------------------------------------------
-- 4. Existing business data now belongs to the initial workspace
-- ---------------------------------------------------------------------------
UPDATE "note"
   SET "workspaceId" = 'ws_inicial'
 WHERE "workspaceId" IS NULL
   AND EXISTS (SELECT 1 FROM "organization" WHERE "id" = 'ws_inicial');

UPDATE "audit_log"
   SET "workspaceId" = 'ws_inicial'
 WHERE "workspaceId" IS NULL
   AND EXISTS (SELECT 1 FROM "organization" WHERE "id" = 'ws_inicial');

-- ---------------------------------------------------------------------------
-- 5. Platform roles shrink to admin | user
--
-- What decides read/write now is the role IN THE WORKSPACE. `user.role` keeps
-- a single job: saying who the platform superadmin is.
--
-- The table's original CHECK (IN 'admin','user','readonly') becomes a
-- harmless superset. Narrowing it would require RECREATING the "user" table in
-- SQLite, with six FKs and two triggers pointing at it: a risk not worth
-- taking. The trigger in 0005 does the same job without touching the structure.
-- ---------------------------------------------------------------------------
UPDATE "user" SET "role" = 'user' WHERE "role" = 'readonly';

-- ---------------------------------------------------------------------------
-- 6. The global invitations table is retired
--
-- With open signup, global invitations no longer exist: an invitation is now
-- always TO a workspace. The pending ones were already migrated in step 3; the
-- history of accepted and revoked ones stays in audit_log.
-- ---------------------------------------------------------------------------
DROP TABLE "invitation";
