import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Drizzle mirror of the SQL migrations in `migrations/`.
 *
 * The migrations are written by hand (drizzle-kit does not generate the
 * TRIGGERs for the last-admin invariant). This file exists to give typing to
 * the queries and for the Better Auth adapter — keep the two in sync.
 */

/**
 * Two levels of role, on purpose.
 *
 * PLATFORM (`user.role`) answers a single question: who is the installation's
 * superadmin. It decides nothing inside any workspace.
 *
 * WORKSPACE (`member.role`) is what decides reading and writing. It is per
 * workspace, so the same person can be `owner` in one and `viewer` in another.
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
  // admin plugin
  role: text("role").$type<PlatformRole>().notNull().default("user"),
  banned: integer("banned", { mode: "boolean" }).default(false),
  banReason: text("banReason"),
  banExpires: ts("banExpires"),
  // two-factor plugin
  twoFactorEnabled: integer("twoFactorEnabled", { mode: "boolean" }).default(false),
  // application
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
     * Remembers the last workspace used, to know where to redirect.
     * It NEVER authorizes: authorization comes from the slug in the URL,
     * checked against the membership. A single value per session does not
     * survive two tabs.
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
 * TOTP secret and recovery codes, already encrypted by Better Auth.
 * `verified` only becomes 1 when the person confirms the first code.
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

/** Better Auth rate limiting. `lastRequest` is Date.now() in MILLISECONDS. */
export const rateLimit = sqliteTable("rateLimit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull().default(0),
  lastRequest: integer("lastRequest").notNull().default(0),
});

/**
 * Workspace. It is the plugin's `organization` — the name in the product is
 * "workspace", the name in the table is what the plugin expects.
 */
export const organization = sqliteTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: ts("createdAt").notNull(),
    /** JSON serialized by the plugin. */
    metadata: text("metadata"),
  },
  (t) => [index("organization_slug_idx").on(t.slug)],
);

/** Who belongs to which workspace, and with what role. */
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
 * Invite to a workspace. The plugin calls it `invitation`; renamed here because
 * that name already belonged to this project's global invite table (which
 * migration 0004 retired). The `modelName` in src/lib/auth.ts makes the link.
 */
export const orgInvitation = sqliteTable(
  "org_invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    /** Nullable: that is what the plugin's runtime declares. */
    role: text("role").$type<WorkspaceRole>(),
    /** The adapter writes it even with teams turned off. */
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
     * SET NULL, not CASCADE: deleting a workspace must not delete the record
     * that it existed and of who did what in it.
     */
    workspaceId: text("workspaceId").references(() => organization.id, { onDelete: "set null" }),
  },
  (t) => [
    index("audit_log_createdAt_idx").on(t.createdAt),
    index("audit_log_workspaceId_idx").on(t.workspaceId),
  ],
);

/** DEMO MODULE — see the comment in migration 0000. */
export const note = sqliteTable(
  "note",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    authorId: text("authorId").references(() => user.id, { onDelete: "set null" }),
    /** All business data belongs to a workspace. */
    workspaceId: text("workspaceId").references(() => organization.id, { onDelete: "cascade" }),
    createdAt: ts("createdAt").notNull(),
    updatedAt: ts("updatedAt").notNull(),
  },
  (t) => [index("note_workspaceId_idx").on(t.workspaceId)],
);

/**
 * TIME TRACKING — see migration 0006.
 *
 * These mirrors exist for the typing and for the house rule (migration and
 * schema go together). The module itself (`src/lib/horas.ts`) speaks SQL
 * directly to D1: the report queries are more readable that way.
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
    /** Hourly rate. NULL = uses the workspace default (migration 0007). */
    hourlyRate: real("hourlyRate"),
  },
  (t) => [uniqueIndex("time_project_workspace_name_idx").on(t.workspaceId, t.name)],
);

/** The workspace's currency and default rate — see migration 0007. */
export const timeSettings = sqliteTable("time_settings", {
  workspaceId: text("workspaceId").primaryKey().references(() => organization.id, { onDelete: "cascade" }),
  currency: text("currency").notNull().default("BRL"),
  defaultRate: real("defaultRate").notNull().default(0),
});

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
    /** ISO-8601 in UTC. */
    start: text("start").notNull(),
    /** NULL = timer running. */
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
    /** SHA-256 of the token. The plaintext value is never stored. */
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
  // The key must be the `modelName` configured in the plugin (`org_invitation`),
  // not the logical name `invitation`: the Drizzle adapter resolves the model by
  // the TABLE name. With the wrong key it reports "Missing tables: org_invitation".
  org_invitation: orgInvitation,
  auditLog,
  note,
};
