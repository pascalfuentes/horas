-- Multi-tenant: cada cliente passa a ter o próprio workspace.
--
-- As três tabelas abaixo são do plugin `organization` do Better Auth. Os nomes
-- de coluna vêm do RUNTIME (dist/plugins/organization/organization.mjs), não dos
-- arquivos .d.mts — eles divergem em dois campos, e quem gera migration e valida
-- é o runtime.
--
-- Nenhuma delas tem `updatedAt`: o plugin não escreve esse campo.

CREATE TABLE "organization" (
  "id"        text    PRIMARY KEY NOT NULL,
  "name"      text    NOT NULL,
  "slug"      text    NOT NULL UNIQUE,
  "logo"      text,
  "createdAt" integer NOT NULL,
  -- JSON serializado pelo próprio plugin.
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
-- Uma pessoa entra uma vez só em cada workspace.
CREATE UNIQUE INDEX "member_um_por_workspace" ON "member" ("organizationId", "userId");

-- O plugin chama esta tabela de "invitation", que colide com a tabela de
-- convites global deste projeto (`tokenHash` NOT NULL UNIQUE, CHECK em role).
-- Renomeada via `schema.invitation.modelName` em src/lib/auth.ts.
CREATE TABLE "org_invitation" (
  "id"             text    PRIMARY KEY NOT NULL,
  "organizationId" text    NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "email"          text    NOT NULL,
  -- Nullable de propósito: é o que o runtime declara.
  "role"           text,
  -- O adapter grava `teamId` mesmo com teams desligado. A coluna existe para
  -- isso não virar erro em produção no primeiro convite.
  "teamId"         text,
  "status"         text    NOT NULL DEFAULT 'pending',
  "expiresAt"      integer NOT NULL,
  "createdAt"      integer NOT NULL,
  "inviterId"      text    NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);
CREATE INDEX "org_invitation_organizationId_idx" ON "org_invitation" ("organizationId");
CREATE INDEX "org_invitation_email_idx"          ON "org_invitation" ("email");

-- Workspace ativo da sessão. Serve para LEMBRAR o último usado, nunca para
-- autorizar: a autorização vem do slug na URL, conferido contra a membership.
ALTER TABLE "session" ADD COLUMN "activeOrganizationId" text;

-- Todo dado de negócio passa a pertencer a um workspace.
ALTER TABLE "note" ADD COLUMN "workspaceId" text REFERENCES "organization" ("id") ON DELETE CASCADE;
-- Auditoria é SET NULL, não CASCADE: apagar um workspace não pode apagar o
-- registro de que ele existiu e de quem fez o quê nele.
ALTER TABLE "audit_log" ADD COLUMN "workspaceId" text REFERENCES "organization" ("id") ON DELETE SET NULL;

CREATE INDEX "note_workspaceId_idx"      ON "note" ("workspaceId");
CREATE INDEX "audit_log_workspaceId_idx" ON "audit_log" ("workspaceId");
