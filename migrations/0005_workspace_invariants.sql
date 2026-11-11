-- Workspace invariants, in the database. Same principle as 0001_invariants.sql:
-- a JavaScript check does not protect against two simultaneous requests.

-- ---------------------------------------------------------------------------
-- 1. `member.role` accepts exactly one of the four roles
--
-- Better Auth allows comma-separated roles ('owner,admin') and resolves
-- permissions with split(','). That would open a hole in the last-owner trigger
-- right below, which compares with '='. Here the comma form simply does not
-- get into the database.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "member_papel_valido_insert"
BEFORE INSERT ON "member"
FOR EACH ROW
WHEN NEW."role" NOT IN ('owner', 'admin', 'editor', 'viewer')
BEGIN
  SELECT RAISE(ABORT, 'PAPEL_INVALIDO');
END;

CREATE TRIGGER "member_papel_valido_update"
BEFORE UPDATE OF "role" ON "member"
FOR EACH ROW
WHEN NEW."role" NOT IN ('owner', 'admin', 'editor', 'viewer')
BEGIN
  SELECT RAISE(ABORT, 'PAPEL_INVALIDO');
END;

-- ---------------------------------------------------------------------------
-- 2. Every workspace has at least one owner
--
-- The `EXISTS (SELECT 1 FROM "organization" ...)` clause is not decoration:
-- without it, the trigger fires during the CASCADE of deleting the workspace and
-- makes deletion IMPOSSIBLE. Verified empirically: with the EXISTS, removing the
-- owner directly aborts, and deleting the whole workspace works.
--
-- A consequence worth knowing when deleting an account: if the person is the
-- only owner, the workspace must be deleted BEFORE the user. In the reverse
-- order the database refuses, because the `user` cascade tries to remove an
-- owner from a workspace that still exists.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "keep_one_owner_on_update"
BEFORE UPDATE OF "role" ON "member"
FOR EACH ROW
WHEN OLD."role" = 'owner' AND NEW."role" <> 'owner'
BEGIN
  SELECT RAISE(ABORT, 'LAST_OWNER')
  WHERE (
    SELECT COUNT(*) FROM "member"
     WHERE "organizationId" = OLD."organizationId"
       AND "role" = 'owner'
       AND "id" <> OLD."id"
  ) = 0;
END;

CREATE TRIGGER "keep_one_owner_on_delete"
BEFORE DELETE ON "member"
FOR EACH ROW
WHEN OLD."role" = 'owner'
 AND EXISTS (SELECT 1 FROM "organization" WHERE "id" = OLD."organizationId")
BEGIN
  SELECT RAISE(ABORT, 'LAST_OWNER')
  WHERE (
    SELECT COUNT(*) FROM "member"
     WHERE "organizationId" = OLD."organizationId"
       AND "role" = 'owner'
       AND "id" <> OLD."id"
  ) = 0;
END;

-- ---------------------------------------------------------------------------
-- 3. `user.role` (PLATFORM role) accepts only admin | user
--
-- Replaces narrowing the CHECK, which would require recreating the "user" table.
-- 'readonly' ceased to exist in migration 0004.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "user_papel_plataforma_valido_insert"
BEFORE INSERT ON "user"
FOR EACH ROW
WHEN NEW."role" NOT IN ('admin', 'user')
BEGIN
  SELECT RAISE(ABORT, 'PAPEL_PLATAFORMA_INVALIDO');
END;

CREATE TRIGGER "user_papel_plataforma_valido_update"
BEFORE UPDATE OF "role" ON "user"
FOR EACH ROW
WHEN NEW."role" NOT IN ('admin', 'user')
BEGIN
  SELECT RAISE(ABORT, 'PAPEL_PLATAFORMA_INVALIDO');
END;
