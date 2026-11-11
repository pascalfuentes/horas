-- "There must always be an admin": the invariant lives in the DATABASE, not
-- in the application. A JavaScript check does not protect against two
-- simultaneous requests demoting the last two admins. These triggers are atomic.
--
-- "Active" admin = role 'admin' AND not banned.
-- On violation, SQLite aborts with the message 'LAST_ADMIN', which the
-- application layer translates into a readable message.

CREATE TRIGGER "keep_one_admin_on_update"
BEFORE UPDATE OF "role", "banned" ON "user"
FOR EACH ROW
WHEN OLD."role" = 'admin'
  AND COALESCE(OLD."banned", 0) = 0
  AND (NEW."role" <> 'admin' OR COALESCE(NEW."banned", 0) <> 0)
BEGIN
  SELECT RAISE(ABORT, 'LAST_ADMIN')
  WHERE (
    SELECT COUNT(*) FROM "user"
    WHERE "role" = 'admin'
      AND COALESCE("banned", 0) = 0
      AND "id" <> OLD."id"
  ) = 0;
END;

CREATE TRIGGER "keep_one_admin_on_delete"
BEFORE DELETE ON "user"
FOR EACH ROW
WHEN OLD."role" = 'admin' AND COALESCE(OLD."banned", 0) = 0
BEGIN
  SELECT RAISE(ABORT, 'LAST_ADMIN')
  WHERE (
    SELECT COUNT(*) FROM "user"
    WHERE "role" = 'admin'
      AND COALESCE("banned", 0) = 0
      AND "id" <> OLD."id"
  ) = 0;
END;
