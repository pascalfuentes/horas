import { and, eq } from "drizzle-orm";

import { member, organization, type WorkspaceRole } from "~/db/schema";
import { getDb } from "~/lib/auth";
import { isUniqueViolation } from "~/lib/errors";
import type { AppEnv } from "~/lib/env";

/**
 * Workspace = `organization` do Better Auth. O nome no produto é workspace; o
 * nome na tabela é o que o plugin espera.
 */

/** Slug legível a partir do nome: sem acento, sem espaço, sem borda suja. */
export function makeSlug(nome: string): string {
  const base = nome
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return base || "workspace";
}

/**
 * Cria um workspace e coloca a pessoa como `owner`.
 *
 * Insere direto pelo Drizzle em vez de chamar `auth.api.createOrganization`
 * porque isto roda DENTRO do hook de criação de usuário — chamar a API do
 * Better Auth de lá seria reentrante. Em troca, os `organizationHooks` não
 * disparam, então a auditoria é registrada por quem chama.
 *
 * `organization.slug` é UNIQUE: se o slug limpo já existir, tenta com sufixo
 * aleatório em vez de estourar.
 */
export async function createWorkspace(
  env: AppEnv,
  input: { nome: string; donoId: string },
): Promise<{ id: string; nome: string; slug: string }> {
  const db = getDb(env);
  const base = makeSlug(input.nome);

  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const slug = tentativa === 0 ? base : `${base}-${sufixo()}`;
    const id = crypto.randomUUID();

    try {
      await db.insert(organization).values({
        id,
        name: input.nome,
        slug,
        createdAt: new Date(),
      });
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }

    await db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: id,
      userId: input.donoId,
      role: "owner",
      createdAt: new Date(),
    });

    return { id, nome: input.nome, slug };
  }

  throw new Error("Não foi possível gerar um slug livre para o workspace.");
}

const sufixo = () => Math.random().toString(36).slice(2, 6);

export type Membership = {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  role: WorkspaceRole;
};

/** Todos os workspaces de uma pessoa, com o papel dela em cada um. */
export async function userWorkspaces(env: AppEnv, userId: string): Promise<Membership[]> {
  return getDb(env)
    .select({
      workspaceId: organization.id,
      workspaceName: organization.name,
      workspaceSlug: organization.slug,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .orderBy(organization.name)
    .all();
}

/**
 * A membership de uma pessoa num workspace, pelo slug.
 *
 * É esta função que autoriza o acesso: `null` significa "não é membro", e quem
 * chama deve tratar como 404 — não 403. Dizer "sem permissão" confirmaria que o
 * workspace existe, o que é informação de graça para quem estiver sondando.
 */
export async function membershipBySlug(
  env: AppEnv,
  input: { slug: string; userId: string },
): Promise<Membership | null> {
  const linha = await getDb(env)
    .select({
      workspaceId: organization.id,
      workspaceName: organization.name,
      workspaceSlug: organization.slug,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(organization.slug, input.slug), eq(member.userId, input.userId)))
    .get();

  return linha ?? null;
}

/** Workspaces onde a pessoa é a ÚNICA owner, com a contagem de membros. */
export async function workspacesWhereSoleOwner(
  env: AppEnv,
  userId: string,
): Promise<Array<{ id: string; nome: string; totalMembros: number }>> {
  const rows = await env.DB.prepare(
    `SELECT o."id", o."name" AS nome,
            (SELECT COUNT(*) FROM "member" WHERE "organizationId" = o."id") AS "totalMembros"
       FROM "member" m
       JOIN "organization" o ON o."id" = m."organizationId"
      WHERE m."userId" = ?1
        AND m."role" = 'owner'
        AND (SELECT COUNT(*) FROM "member"
              WHERE "organizationId" = o."id" AND "role" = 'owner') = 1`,
  )
    .bind(userId)
    .all<{ id: string; nome: string; totalMembros: number }>();

  return rows.results ?? [];
}
