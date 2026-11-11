-- "Sempre tem que ter um admin" — o invariante mora no BANCO, não na aplicação.
-- Checagem em JavaScript não protege contra duas requisições simultâneas
-- rebaixando os dois últimos admins. Estes triggers são atômicos.
--
-- Admin "ativo" = role 'admin' E não banido.
-- Ao violar, o SQLite aborta com a mensagem 'LAST_ADMIN', que a camada de
-- aplicação traduz numa mensagem legível.

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
