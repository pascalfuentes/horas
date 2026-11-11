import type { WorkspaceRole } from "~/db/schema";
import type { AppEnv } from "~/lib/env";
import { DEFAULT_TZ, tzValido } from "~/lib/horas";
import { ehPapelDeWorkspace } from "~/lib/permissions";
import { generateToken, hashToken } from "~/lib/tokens";

/**
 * Tokens pessoais para a API e para o MCP.
 *
 * Mesma regra dos convites: o token em claro existe só na resposta que o cria.
 * O banco guarda o SHA-256, então um vazamento do D1 não dá acesso a ninguém.
 *
 * O token aponta para (pessoa, workspace) e NÃO carrega papel: o papel é lido
 * da tabela `member` a cada requisição. Rebaixar ou remover alguém do workspace
 * vale na hora, sem precisar lembrar de revogar token.
 */

export const TOKEN_PREFIXO = "hrs_";
const MAX_TOKENS_POR_PESSOA = 20;

export type TokenListado = {
  id: string;
  name: string;
  prefix: string;
  timezone: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type Portador = {
  tokenId: string;
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  tz: string;
};

export async function listarTokens(env: AppEnv, dono: { userId: string; workspaceId: string }): Promise<TokenListado[]> {
  const r = await env.DB.prepare(
    `SELECT "id", "name", "prefix", "timezone", "createdAt", "lastUsedAt"
       FROM "api_token" WHERE "userId" = ?1 AND "workspaceId" = ?2 ORDER BY "createdAt" DESC`,
  )
    .bind(dono.userId, dono.workspaceId)
    .all<TokenListado>();
  return r.results ?? [];
}

/** Cria o token e devolve o valor em claro — a única vez que ele existe fora do hash. */
export async function criarToken(
  env: AppEnv,
  input: { userId: string; workspaceId: string; name: string; timezone?: string },
): Promise<{ id: string; token: string } | { erro: string }> {
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "api_token" WHERE "userId" = ?1`)
    .bind(input.userId)
    .first<{ n: number }>();
  if ((total?.n ?? 0) >= MAX_TOKENS_POR_PESSOA) {
    return { erro: `Limite de ${MAX_TOKENS_POR_PESSOA} tokens. Revogue algum que não usa mais.` };
  }

  const token = TOKEN_PREFIXO + generateToken();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO "api_token" ("id", "userId", "workspaceId", "name", "tokenHash", "prefix", "timezone", "createdAt")
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      id,
      input.userId,
      input.workspaceId,
      input.name.trim().slice(0, 60) || "Sem nome",
      await hashToken(token),
      token.slice(0, 10),
      tzValido(input.timezone) ? input.timezone : DEFAULT_TZ,
      new Date().toISOString(),
    )
    .run();
  return { id, token };
}

/** Só revoga token da própria pessoa naquele workspace. */
export async function revogarToken(env: AppEnv, input: { id: string; userId: string; workspaceId: string }): Promise<boolean> {
  const r = await env.DB.prepare(`DELETE FROM "api_token" WHERE "id" = ?1 AND "userId" = ?2 AND "workspaceId" = ?3`)
    .bind(input.id, input.userId, input.workspaceId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Extrai o token de `Authorization: Bearer …`. */
export function tokenDoCabecalho(request: Request): string | null {
  const m = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/**
 * Resolve um token para quem ele representa, ou null.
 *
 * O JOIN com `member` é a autorização: sem membership não há resultado. Conta
 * banida também não passa.
 */
export async function autenticarToken(env: AppEnv, token: string | null): Promise<Portador | null> {
  if (!token || !token.startsWith(TOKEN_PREFIXO) || token.length > 200) return null;

  // A busca é pelo hash (índice único), então não há comparação de segredo
  // byte a byte que vaze tempo.
  const linha = await env.DB.prepare(
    `SELECT t."id" AS tokenId, t."userId", t."workspaceId", t."timezone", t."lastUsedAt", m."role"
       FROM "api_token" t
       JOIN "member" m ON m."userId" = t."userId" AND m."organizationId" = t."workspaceId"
       JOIN "user" u ON u."id" = t."userId"
      WHERE t."tokenHash" = ?1 AND COALESCE(u."banned", 0) = 0`,
  )
    .bind(await hashToken(token))
    .first<{ tokenId: string; userId: string; workspaceId: string; timezone: string; lastUsedAt: string | null; role: string }>();

  if (!linha || !ehPapelDeWorkspace(linha.role)) return null;

  // "Último uso" com precisão de minuto: evita uma escrita no banco por chamada.
  const agora = new Date();
  if (!linha.lastUsedAt || agora.getTime() - Date.parse(linha.lastUsedAt) > 60_000) {
    await env.DB.prepare(`UPDATE "api_token" SET "lastUsedAt" = ?1 WHERE "id" = ?2`)
      .bind(agora.toISOString(), linha.tokenId)
      .run()
      .catch((erro) => console.error("api_token lastUsedAt:", erro));
  }

  return {
    tokenId: linha.tokenId,
    userId: linha.userId,
    workspaceId: linha.workspaceId,
    role: linha.role,
    tz: linha.timezone,
  };
}
