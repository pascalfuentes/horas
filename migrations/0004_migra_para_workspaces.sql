-- Migração dos dados de uma instalação que já existe.
--
-- Roda ANTES dos triggers de invariante (0005) de propósito: o trigger que
-- valida `user.role` recusaria o próprio UPDATE que tira o 'readonly' de
-- circulação. Ordem: schema → dados → invariantes.
--
-- Numa instalação nova (banco vazio) nada aqui tem efeito: todos os INSERT são
-- guardados por `WHERE EXISTS (SELECT 1 FROM "user")`.

-- ---------------------------------------------------------------------------
-- 1. Workspace inicial
--
-- A instalação atual é uma equipe num espaço só, e é isso que preservamos.
-- Não criamos workspace pessoal para quem já existe: inventaria estrutura que
-- ninguém pediu e deixaria workspaces vazios para sempre. Só cadastro NOVO
-- ganha workspace pessoal automático.
--
-- Renomeie depois pela interface; o id fixo é só para esta migration se
-- referenciar sem depender de um valor gerado.
-- ---------------------------------------------------------------------------
INSERT INTO "organization" ("id", "name", "slug", "createdAt")
SELECT 'ws_inicial', 'Workspace Inicial', 'workspace-inicial', unixepoch()
WHERE EXISTS (SELECT 1 FROM "user");

-- ---------------------------------------------------------------------------
-- 2. Todo mundo vira membro, com os papéis mapeados
--
--   admin mais antigo → owner   (só um: 'owner' carrega excluir workspace e
--                                transferir propriedade, poder que não deve ser
--                                distribuído por acidente de migração)
--   demais admin      → admin
--   user              → editor
--   readonly          → viewer
--
-- Se a instalação não tiver nenhum admin, o usuário mais antigo vira owner —
-- sem isso o workspace nasceria sem owner e violaria o invariante de 0005.
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
-- 3. Convites pendentes viram convites do workspace inicial
--
-- `inviterId` é NOT NULL no plugin; quando o convite original não tem
-- `invitedBy` (o caso do /setup), cai no owner do workspace.
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
-- 4. Dado de negócio existente passa a pertencer ao workspace inicial
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
-- 5. Papéis de plataforma encolhem para admin | user
--
-- Quem decide ler/escrever agora é o papel NO WORKSPACE. O `user.role` fica
-- com uma função só: dizer quem é o superadmin da plataforma.
--
-- O CHECK original da tabela (IN 'admin','user','readonly') vira um
-- superconjunto inofensivo. Estreitá-lo exigiria RECRIAR a tabela "user" no
-- SQLite, com seis FKs e dois triggers apontando para ela — risco que não se
-- paga. O trigger em 0005 faz o mesmo trabalho sem tocar na estrutura.
-- ---------------------------------------------------------------------------
UPDATE "user" SET "role" = 'user' WHERE "role" = 'readonly';

-- ---------------------------------------------------------------------------
-- 6. A tabela de convites global é aposentada
--
-- Com cadastro aberto, convite global deixa de existir: convite agora é sempre
-- PARA um workspace. Os pendentes já foram migrados no passo 3; o histórico
-- dos aceitos e revogados continua no audit_log.
-- ---------------------------------------------------------------------------
DROP TABLE "invitation";
