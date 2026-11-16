import { and, desc, eq, gt } from "drizzle-orm";

import { session } from "~/db/schema";
import { getDb } from "~/lib/auth";
import type { AppEnv } from "~/lib/env";

/**
 * The sessions of the signed-in person, for the Security page.
 *
 * They are read straight from the table instead of asking Better Auth's
 * `listSessions`: that route only answers a session younger than `freshAge`
 * (15 minutes here) and throws for any other, which took the whole Security
 * page down a quarter of an hour after every login. It is that strict because
 * its answer carries the tokens of the other sessions. Nothing here does: a
 * session is named by its id, and the token never leaves the server.
 */

/** What the page shows of one session. */
export interface OwnSession {
  id: string;
  /** Whether it is the session making the request. */
  current: boolean;
  createdAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * The sessions of a person that are still valid, latest first.
 * @param env
 * @param userId The signed-in person.
 * @param currentToken Token of the session making the request, to mark it.
 */
export async function ownSessions(env: AppEnv, userId: string, currentToken: string): Promise<OwnSession[]> {
  const rows = await getDb(env)
    .select({
      id: session.id,
      token: session.token,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    })
    .from(session)
    .where(and(eq(session.userId, userId), gt(session.expiresAt, new Date())))
    .orderBy(desc(session.createdAt));
  return rows.map(({ token, ...rest }) => ({ ...rest, current: token === currentToken }));
}

/**
 * The token of one of the person's own sessions, to hand to Better Auth when
 * that session is to be ended.
 * @param env
 * @param userId The signed-in person: a session of anyone else is not found.
 * @param id Session id, as the Security page sent it.
 * @returns The token, or null when the person has no such session.
 */
export async function ownSessionToken(env: AppEnv, userId: string, id: string): Promise<string | null> {
  const row = await getDb(env)
    .select({ token: session.token })
    .from(session)
    .where(and(eq(session.id, id), eq(session.userId, userId)))
    .get();
  return row ? row.token : null;
}
