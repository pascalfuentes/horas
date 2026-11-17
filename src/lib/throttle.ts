import type { AppEnv } from "~/lib/env";

/**
 * A small counter for the things Better Auth's rate limiter does not see: it
 * only counts requests that go through its own router, by address and path.
 * What is counted here has another key (a person, an e-mail address) or never
 * reaches that router at all.
 *
 * It lives in the same `rateLimit` table, under keys that start with `app:` so
 * the two never collide. Better Auth prunes rows older than its longest window
 * (10 minutes with the rules in `auth.ts`), so a window here must not be
 * longer than that: a longer one would be forgotten early.
 */

/** The longest window that survives Better Auth's pruning, in seconds. */
export const MAX_WINDOW_SECONDS = 600;

type Rule = {
  /** How many times the thing may happen inside the window. */
  max: number;
  /** Size of the window, in seconds. At most `MAX_WINDOW_SECONDS`. */
  windowSeconds: number;
};

/**
 * Counts one more event under `key` and says whether it is still within the
 * limit. One statement, so two requests at the same instant cannot both read
 * the old count.
 *
 * Fails open: if the database refuses the count, the event is allowed. The
 * counter is an extra lock, never the only one, and a broken counter must not
 * lock everybody out.
 *
 * @param env The Worker's bindings; only the database is used.
 * @param key What is being counted, e.g. `delete-account:<user id>`.
 * @param rule The limit and its window.
 * @returns `true` when the event is within the limit.
 */
export async function withinLimit(env: Pick<AppEnv, "DB">, key: string, rule: Rule): Promise<boolean> {
  const now = Date.now();
  const windowMs = Math.min(rule.windowSeconds, MAX_WINDOW_SECONDS) * 1000;

  try {
    const row = await env.DB.prepare(
      `INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest") VALUES (?1, ?2, 1, ?3)
       ON CONFLICT("key") DO UPDATE SET
         "count" = CASE WHEN ?3 - "lastRequest" >= ?4 THEN 1 ELSE "count" + 1 END,
         "lastRequest" = CASE WHEN ?3 - "lastRequest" >= ?4 THEN ?3 ELSE "lastRequest" END
       RETURNING "count"`,
    )
      .bind(crypto.randomUUID(), `app:${key}`, now, windowMs)
      .first<{ count: number }>();
    return (row?.count ?? 1) <= rule.max;
  } catch (error) {
    console.error("throttle:", error);
    return true;
  }
}
