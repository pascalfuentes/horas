/**
 * D1 errors arrive wrapped: `DrizzleQueryError` → `D1_ERROR` → `Error`.
 * The message that matters ("LAST_ADMIN", "UNIQUE constraint failed") is down
 * at the bottom, so `String(error).includes(...)` finds nothing. This function
 * walks the `cause` chain.
 */
export function errorChainIncludes(error: unknown, needle: string): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 10; depth++) {
    const node = current as { message?: unknown; cause?: unknown };
    if (typeof node.message === "string" && node.message.includes(needle)) return true;
    current = node.cause;
  }
  return false;
}

/** The trigger in `migrations/0001_invariants.sql` aborts with this message. */
export const isLastAdminError = (error: unknown) => errorChainIncludes(error, "LAST_ADMIN");

/** Every workspace needs an owner — trigger in `0005_workspace_invariants.sql`. */
export const isLastOwnerError = (error: unknown) => errorChainIncludes(error, "LAST_OWNER");

/** Unique index violation (e.g. duplicate pending invite). */
export const isUniqueViolation = (error: unknown) => errorChainIncludes(error, "UNIQUE constraint failed");
