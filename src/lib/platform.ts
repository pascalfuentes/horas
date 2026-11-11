import { count, eq, sql } from "drizzle-orm";

import { user as userTable } from "~/db/schema";
import { getDb } from "~/lib/auth";
import type { AppEnv } from "~/lib/env";

/**
 * Consultas sobre a PLATAFORMA (a instalação inteira), não sobre um workspace.
 */

export async function countUsers(env: AppEnv): Promise<number> {
  const row = await getDb(env).select({ n: sql<number>`count(*)` }).from(userTable).get();
  return Number(row?.n ?? 0);
}

/**
 * Superadmins ativos. É esta contagem que decide se `/setup` ainda funciona:
 * com cadastro aberto, "banco vazio" virou uma corrida — bastava alguém se
 * cadastrar antes para o superadmin ficar impossível de criar.
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
