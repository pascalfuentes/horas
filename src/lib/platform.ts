import { count, eq, sql } from "drizzle-orm";

import { user as userTable } from "~/db/schema";
import { getDb } from "~/lib/auth";
import type { AppEnv } from "~/lib/env";

/**
 * Queries about the PLATFORM (the whole installation), not about a workspace.
 */

export async function countUsers(env: AppEnv): Promise<number> {
  const row = await getDb(env).select({ n: sql<number>`count(*)` }).from(userTable).get();
  return Number(row?.n ?? 0);
}

/**
 * Active superadmins. This count is what decides whether `/setup` still works:
 * with open signup, "empty database" became a race — someone signing up first
 * was enough to make the superadmin impossible to create.
 */
export async function countPlatformAdmins(env: AppEnv): Promise<number> {
  const row = await getDb(env)
    .select({ n: count() })
    .from(userTable)
    .where(sql`${userTable.role} = 'admin' AND coalesce(${userTable.banned}, 0) = 0`)
    .get();
  return Number(row?.n ?? 0);
}

export async function userByEmail(env: AppEnv, email: string) {
  return getDb(env)
    .select({ id: userTable.id, email: userTable.email, role: userTable.role })
    .from(userTable)
    .where(eq(userTable.email, email.trim().toLowerCase()))
    .get();
}
