import type { WorkspaceRole } from "~/db/schema";
import type { AppEnv } from "~/lib/env";
import { DEFAULT_TZ, isValidTz } from "~/lib/horas";
import { isWorkspaceRole } from "~/lib/permissions";
import { generateToken, hashToken } from "~/lib/tokens";

/**
 * Personal tokens for the API and for MCP.
 *
 * Same rule as invites: the plaintext token exists only in the response that creates it.
 * The database stores the SHA-256, so a D1 leak gives nobody access.
 *
 * The token points to (person, workspace) and does NOT carry a role: the role is read
 * from the `member` table on every request. Demoting or removing someone from the
 * workspace takes effect immediately, with no need to remember to revoke a token.
 */

export const TOKEN_PREFIX = "hrs_";
const MAX_TOKENS_PER_PERSON = 20;

export type ListedToken = {
  id: string;
  name: string;
  prefix: string;
  timezone: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type Bearer = {
  tokenId: string;
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  tz: string;
};

export async function listTokens(env: AppEnv, owner: { userId: string; workspaceId: string }): Promise<ListedToken[]> {
  const r = await env.DB.prepare(
    `SELECT "id", "name", "prefix", "timezone", "createdAt", "lastUsedAt"
       FROM "api_token" WHERE "userId" = ?1 AND "workspaceId" = ?2 ORDER BY "createdAt" DESC`,
  )
    .bind(owner.userId, owner.workspaceId)
    .all<ListedToken>();
  return r.results ?? [];
}

/** Creates the token and returns the plaintext value — the only time it exists outside the hash. */
export async function createToken(
  env: AppEnv,
  input: { userId: string; workspaceId: string; name: string; timezone?: string },
): Promise<{ id: string; token: string } | { error: string }> {
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "api_token" WHERE "userId" = ?1`)
    .bind(input.userId)
    .first<{ n: number }>();
  if ((total?.n ?? 0) >= MAX_TOKENS_PER_PERSON) {
    return { error: `Limit of ${MAX_TOKENS_PER_PERSON} tokens. Revoke one you no longer use.` };
  }

  const token = TOKEN_PREFIX + generateToken();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO "api_token" ("id", "userId", "workspaceId", "name", "tokenHash", "prefix", "timezone", "createdAt")
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      id,
      input.userId,
      input.workspaceId,
      input.name.trim().slice(0, 60) || "Unnamed",
      await hashToken(token),
      token.slice(0, 10),
      isValidTz(input.timezone) ? input.timezone : DEFAULT_TZ,
      new Date().toISOString(),
    )
    .run();
  return { id, token };
}

/** Only revokes a token of the person themselves in that workspace. */
export async function revokeToken(env: AppEnv, input: { id: string; userId: string; workspaceId: string }): Promise<boolean> {
  const r = await env.DB.prepare(`DELETE FROM "api_token" WHERE "id" = ?1 AND "userId" = ?2 AND "workspaceId" = ?3`)
    .bind(input.id, input.userId, input.workspaceId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Extracts the token from `Authorization: Bearer …`. */
export function tokenFromHeader(request: Request): string | null {
  const m = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/**
 * Resolves a token to whoever it represents, or null.
 *
 * The JOIN with `member` is the authorization: without membership there is no
 * result. A banned account does not get through either.
 */
export async function authenticateToken(env: AppEnv, token: string | null): Promise<Bearer | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;

  // The lookup is by hash (unique index), so there is no byte-by-byte secret
  // comparison that leaks timing.
  const row = await env.DB.prepare(
    `SELECT t."id" AS tokenId, t."userId", t."workspaceId", t."timezone", t."lastUsedAt", m."role"
       FROM "api_token" t
       JOIN "member" m ON m."userId" = t."userId" AND m."organizationId" = t."workspaceId"
       JOIN "user" u ON u."id" = t."userId"
      WHERE t."tokenHash" = ?1 AND COALESCE(u."banned", 0) = 0`,
  )
    .bind(await hashToken(token))
    .first<{ tokenId: string; userId: string; workspaceId: string; timezone: string; lastUsedAt: string | null; role: string }>();

  if (!row || !isWorkspaceRole(row.role)) return null;

  // "Last used" with minute precision: avoids one database write per call.
  const now = new Date();
  if (!row.lastUsedAt || now.getTime() - Date.parse(row.lastUsedAt) > 60_000) {
    await env.DB.prepare(`UPDATE "api_token" SET "lastUsedAt" = ?1 WHERE "id" = ?2`)
      .bind(now.toISOString(), row.tokenId)
      .run()
      .catch((err) => console.error("api_token lastUsedAt:", err));
  }

  return {
    tokenId: row.tokenId,
    userId: row.userId,
    workspaceId: row.workspaceId,
    role: row.role,
    tz: row.timezone,
  };
}
