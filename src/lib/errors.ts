/**
 * Erros do D1 chegam embrulhados: `DrizzleQueryError` → `D1_ERROR` → `Error`.
 * A mensagem que interessa ("LAST_ADMIN", "UNIQUE constraint failed") está lá
 * no fundo, então `String(error).includes(...)` não encontra nada. Esta função
 * anda a cadeia de `cause`.
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

/** O trigger de `migrations/0001_invariants.sql` aborta com esta mensagem. */
export const isLastAdminError = (error: unknown) => errorChainIncludes(error, "LAST_ADMIN");

/** Todo workspace precisa de um dono — trigger de `0005_workspace_invariants.sql`. */
export const isLastOwnerError = (error: unknown) => errorChainIncludes(error, "LAST_OWNER");

/** Violação de índice único (ex.: convite pendente duplicado). */
export const isUniqueViolation = (error: unknown) => errorChainIncludes(error, "UNIQUE constraint failed");
