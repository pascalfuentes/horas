-- Invariantes de workspace, no banco — mesmo princípio de 0001_invariants.sql:
-- checagem em JavaScript não protege contra duas requisições simultâneas.

-- ---------------------------------------------------------------------------
-- 1. `member.role` aceita exatamente um dos quatro papéis
--
-- O Better Auth permite papéis separados por vírgula ('owner,admin') e resolve
-- permissão com split(','). Isso abriria um buraco no trigger de último owner
-- logo abaixo, que compara com '='. Aqui a forma com vírgula simplesmente não
-- entra no banco.
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
-- 2. Todo workspace tem ao menos um owner
--
-- A cláusula `EXISTS (SELECT 1 FROM "organization" ...)` não é decoração: sem
-- ela, o trigger dispara durante o CASCADE de apagar o workspace e torna a
-- exclusão IMPOSSÍVEL. Verificado empiricamente — com o EXISTS, remover o owner
-- direto aborta, e apagar o workspace inteiro funciona.
--
-- Consequência que vale saber ao apagar uma conta: se a pessoa é a única owner,
-- o workspace precisa ser apagado ANTES do usuário. Na ordem inversa o banco
-- recusa, porque o cascade de `user` tenta remover um owner de um workspace que
-- ainda existe.
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
-- 3. `user.role` (papel de PLATAFORMA) aceita só admin | user
--
-- Substitui o estreitamento do CHECK, que exigiria recriar a tabela "user".
-- 'readonly' deixou de existir na migration 0004.
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
