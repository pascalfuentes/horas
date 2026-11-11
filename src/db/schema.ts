import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Espelho em Drizzle das migrations SQL em `migrations/`.
 *
 * As migrations são escritas à mão (o drizzle-kit não gera os TRIGGERs do
 * invariante de último admin). Este arquivo existe para dar tipagem às
 * queries e para o adapter do Better Auth — mantenha os dois em sincronia.
 */

/**
 * Dois níveis de papel, de propósito.
 *
 * PLATAFORMA (`user.role`) responde uma pergunta só: quem é o superadmin da
 * instalação. Não decide nada dentro de workspace nenhum.
 *
 * WORKSPACE (`member.role`) é quem decide ler e escrever. É por workspace, então
 * a mesma pessoa pode ser `owner` num e `viewer` noutro.
 */
export const PLATFORM_ROLES = ["admin", "user"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const WORKSPACE_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

const ts = (name: string) => integer(name, { mode: "timestamp" });

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: ts("createdAt").notNull(),
  updatedAt: ts("updatedAt").notNull(),
  // plugin admin
  role: text("role").$type<PlatformRole>().notNull().default("user"),
  banned: integer("banned", { mode: "boolean" }).default(false),
  banReason: text("banReason"),
  banExpires: ts("banExpires"),
  // plugin two-factor
  twoFactorEnabled: integer("twoFactorEnabled", { mode: "boolean" }).default(false),
  // aplicação
  phone: text("phone"),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: ts("expiresAt").notNull(),
    createdAt: ts("createdAt").notNull(),
    updatedAt: ts("updatedAt").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    impersonatedBy: text("impersonatedBy"),
    /**
     * Lembra o último workspace usado, para saber para onde redirecionar.
     * NUNCA autoriza: a autorização vem do slug na URL, conferido contra a
     * membership. Um valor único por sessão não sobrevive a duas abas.
     */
    activeOrganizationId: text("activeOrganizationId"),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: ts("accessTokenExpiresAt"),
    refreshTokenExpiresAt: ts("refreshTokenExpiresAt"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("createdAt").notNull(),
    updatedAt: ts("updatedAt").notNull(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expiresAt").notNull(),
    createdAt: ts("createdAt").notNull(),
    updatedAt: ts("updatedAt").notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

/**
 * Segredo TOTP e códigos de recuperação, já criptografados pelo Better Auth.
 * `verified` só vira 1 quando a pessoa confirma o primeiro código.
 */
export const twoFactor = sqliteTable(
  "twoFactor",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backupCodes").notNull(),
    verified: integer("verified", { mode: "boolean" }).default(false),
    failedVerificationCount: integer("failedVerificationCount").default(0),
    lockedUntil: ts("lockedUntil"),
  },
  (t) => [index("twoFactor_userId_idx").on(t.userId), index("twoFactor_secret_idx").on(t.secret)],
);

/** Rate limiting do Better Auth. `lastRequest` é Date.now() em MILISSEGUNDOS. */
export const rateLimit = sqliteTable("rateLimit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull().default(0),
  lastRequest: integer("lastRequest").notNull().default(0),
});

/**
 * Workspace. É a `organization` do plugin — o nome no produto é "workspace",
 * o nome na tabela é o que o plugin espera.
 */
export const organization = sqliteTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: ts("createdAt").notNull(),
    /** JSON serializado pelo plugin. */
    metadata: text("metadata"),
  },
  (t) => [index("organization_slug_idx").on(t.slug)],
);

/** Quem participa de qual workspace, e com que papel. */
export const member = sqliteTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").$type<WorkspaceRole>().notNull().default("viewer"),
    createdAt: ts("createdAt").notNull(),
  },
  (t) => [
    index("member_organizationId_idx").on(t.organizationId),
    index("member_userId_idx").on(t.userId),
    uniqueIndex("member_um_por_workspace").on(t.organizationId, t.userId),
  ],
);

/**
 * Convite para um workspace. O plugin chama de `invitation`; renomeada aqui
 * porque esse nome já era da tabela de convites global deste projeto (que a
 * migration 0004 aposentou). O `modelName` em src/lib/auth.ts faz a ligação.
 */
export const orgInvitation = sqliteTable(
  "org_invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    /** Nullable: é o que o runtime do plugin declara. */
    role: text("role").$type<WorkspaceRole>(),
    /** O adapter grava mesmo com teams desligado. */
    teamId: text("teamId"),
    status: text("status").notNull().default("pending"),
    expiresAt: ts("expiresAt").notNull(),
    createdAt: ts("createdAt").notNull(),
    inviterId: text("inviterId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("org_invitation_organizationId_idx").on(t.organizationId),
    index("org_invitation_email_idx").on(t.email),
  ],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    createdAt: ts("createdAt").notNull(),
    actorId: text("actorId").references(() => user.id, { onDelete: "set null" }),
    actorEmail: text("actorEmail"),
    action: text("action").notNull(),
    targetId: text("targetId"),
    targetEmail: text("targetEmail"),
    details: text("details"),
    ip: text("ip"),
    /**
     * SET NULL, não CASCADE: apagar um workspace não pode apagar o registro de
     * que ele existiu e de quem fez o quê nele.
     */
    workspaceId: text("workspaceId").references(() => organization.id, { onDelete: "set null" }),
  },
  (t) => [
    index("audit_log_createdAt_idx").on(t.createdAt),
    index("audit_log_workspaceId_idx").on(t.workspaceId),
  ],
);

/** MÓDULO DE DEMONSTRAÇÃO — ver comentário na migration 0000. */
export const note = sqliteTable(
  "note",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    authorId: text("authorId").references(() => user.id, { onDelete: "set null" }),
    /** Todo dado de negócio pertence a um workspace. */
    workspaceId: text("workspaceId").references(() => organization.id, { onDelete: "cascade" }),
    createdAt: ts("createdAt").notNull(),
    updatedAt: ts("updatedAt").notNull(),
  },
  (t) => [index("note_workspaceId_idx").on(t.workspaceId)],
);

/**
 * CONTROLE DE TEMPO — ver migration 0006.
 *
 * Estes espelhos existem pela tipagem e pela regra da casa (migration e schema
 * andam juntos). O módulo em si (`src/lib/horas.ts`) fala SQL direto com o D1:
 * as queries de relatório ficam mais legíveis assim.
 */
export const timeProject = sqliteTable(
  "time_project",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: text("workspaceId").notNull().references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    client: text("client").notNull().default(""),
    color: text("color").notNull().default("#3b82f6"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: text("createdAt").notNull(),
  },
  (t) => [uniqueIndex("time_project_workspace_name_idx").on(t.workspaceId, t.name)],
);

export const timeEntry = sqliteTable(
  "time_entry",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: text("workspaceId").notNull().references(() => organization.id, { onDelete: "cascade" }),
    userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
    projectId: integer("projectId").references(() => timeProject.id, { onDelete: "set null" }),
    description: text("description").notNull().default(""),
    /** JSON: string[] */
    tags: text("tags").notNull().default("[]"),
    billable: integer("billable", { mode: "boolean" }).notNull().default(false),
    /** ISO-8601 em UTC. */
    start: text("start").notNull(),
    /** NULL = timer rodando. */
    end: text("end"),
    createdAt: text("createdAt").notNull(),
  },
  (t) => [index("time_entry_owner_start_idx").on(t.workspaceId, t.userId, t.start)],
);

export const apiToken = sqliteTable(
  "api_token",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspaceId").notNull().references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** SHA-256 do token. O valor em claro nunca é gravado. */
    tokenHash: text("tokenHash").notNull().unique(),
    prefix: text("prefix").notNull(),
    timezone: text("timezone").notNull().default("America/Sao_Paulo"),
    createdAt: text("createdAt").notNull(),
    lastUsedAt: text("lastUsedAt"),
  },
  (t) => [index("api_token_userId_idx").on(t.userId)],
);

export const schema = {
  user,
  session,
  account,
  verification,
  twoFactor,
  rateLimit,
  organization,
  member,
  // A chave precisa ser o `modelName` configurado no plugin (`org_invitation`),
  // e não o nome lógico `invitation`: o adapter do Drizzle resolve o modelo pelo
  // nome da TABELA. Com a chave errada ele acusa "Missing tables: org_invitation".
  org_invitation: orgInvitation,
  auditLog,
  note,
};
