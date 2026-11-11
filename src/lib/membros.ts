import { and, desc, eq, gt, sql } from "drizzle-orm";

import {
  member,
  organization,
  orgInvitation,
  user as userTable,
  type WorkspaceRole,
} from "~/db/schema";
import { getDb } from "~/lib/auth";
import type { AppEnv } from "~/lib/env";

/** Membros de um workspace, com os dados da pessoa. */
export type MembroDoWorkspace = {
  memberId: string;
  userId: string;
  nome: string;
  email: string;
  role: WorkspaceRole;
  desde: Date;
};

export async function listarMembros(env: AppEnv, workspaceId: string): Promise<MembroDoWorkspace[]> {
  return getDb(env)
    .select({
      memberId: member.id,
      userId: member.userId,
      nome: userTable.name,
      email: userTable.email,
      role: member.role,
      desde: member.createdAt,
    })
    .from(member)
    .innerJoin(userTable, eq(userTable.id, member.userId))
    .where(eq(member.organizationId, workspaceId))
    .orderBy(member.createdAt)
    .all();
}

export type ConviteDoWorkspace = {
  id: string;
  email: string;
  role: WorkspaceRole | null;
  status: string;
  expiraEm: Date;
  criadoEm: Date;
  convidadoPor: string | null;
};

export async function listarConvites(env: AppEnv, workspaceId: string): Promise<ConviteDoWorkspace[]> {
  return getDb(env)
    .select({
      id: orgInvitation.id,
      email: orgInvitation.email,
      role: orgInvitation.role,
      status: orgInvitation.status,
      expiraEm: orgInvitation.expiresAt,
      criadoEm: orgInvitation.createdAt,
      convidadoPor: userTable.email,
    })
    .from(orgInvitation)
    .leftJoin(userTable, eq(userTable.id, orgInvitation.inviterId))
    .where(eq(orgInvitation.organizationId, workspaceId))
    .orderBy(desc(orgInvitation.createdAt))
    .limit(100)
    .all();
}

/** Um convite pendente e ainda válido não é "expirado" nem "cancelado". */
export function estaPendente(c: ConviteDoWorkspace): boolean {
  return c.status === "pending" && c.expiraEm.getTime() > Date.now();
}

export function situacaoDoConvite(c: ConviteDoWorkspace): string {
  if (c.status === "accepted") return "aceito";
  if (c.status === "rejected") return "recusado";
  if (c.status === "canceled") return "cancelado";
  return c.expiraEm.getTime() <= Date.now() ? "expirado" : "pendente";
}

/**
 * Transfere a propriedade do workspace.
 *
 * A ORDEM importa: promove a pessoa nova primeiro (o workspace fica com dois
 * owners por um instante) e só então rebaixa quem transferiu. Na ordem inversa,
 * o trigger `keep_one_owner_on_update` abortaria — e estaria certo, porque o
 * workspace ficaria sem dono no meio do caminho.
 *
 * Quem transfere vira `admin`: continua podendo trabalhar, perde só o que é
 * exclusivo de dono (excluir o workspace e transferir de novo).
 */
export async function transferirPropriedade(
  env: AppEnv,
  input: { workspaceId: string; deMemberId: string; paraMemberId: string },
): Promise<void> {
  const db = getDb(env);

  await db
    .update(member)
    .set({ role: "owner" })
    .where(and(eq(member.id, input.paraMemberId), eq(member.organizationId, input.workspaceId)));

  await db
    .update(member)
    .set({ role: "admin" })
    .where(and(eq(member.id, input.deMemberId), eq(member.organizationId, input.workspaceId)));
}

/** Quantos owners ativos o workspace tem. Usado para mensagens, não para garantir. */
export async function contarOwners(env: AppEnv, workspaceId: string): Promise<number> {
  const row = await getDb(env)
    .select({ n: sql<number>`count(*)` })
    .from(member)
    .where(and(eq(member.organizationId, workspaceId), eq(member.role, "owner")))
    .get();
  return Number(row?.n ?? 0);
}

/** A membership de uma pessoa específica dentro do workspace. */
export async function membroPorId(env: AppEnv, workspaceId: string, memberId: string) {
  return getDb(env)
    .select({
      memberId: member.id,
      userId: member.userId,
      role: member.role,
      email: userTable.email,
      nome: userTable.name,
    })
    .from(member)
    .innerJoin(userTable, eq(userTable.id, member.userId))
    .where(and(eq(member.id, memberId), eq(member.organizationId, workspaceId)))
    .get();
}

/** Já existe convite pendente para este e-mail neste workspace? */
export async function temConvitePendente(
  env: AppEnv,
  workspaceId: string,
  email: string,
): Promise<boolean> {
  const row = await getDb(env)
    .select({ id: orgInvitation.id })
    .from(orgInvitation)
    .where(
      and(
        eq(orgInvitation.organizationId, workspaceId),
        eq(orgInvitation.email, email.trim().toLowerCase()),
        eq(orgInvitation.status, "pending"),
      ),
    )
    .get();
  return Boolean(row);
}

/** Essa pessoa já é membro deste workspace? */
export async function jaEMembro(env: AppEnv, workspaceId: string, email: string): Promise<boolean> {
  const row = await getDb(env)
    .select({ id: member.id })
    .from(member)
    .innerJoin(userTable, eq(userTable.id, member.userId))
    .where(and(eq(member.organizationId, workspaceId), eq(userTable.email, email.trim().toLowerCase())))
    .get();
  return Boolean(row);
}

/** Convite que espera por uma pessoa, visto do lado de quem foi convidado. */
export type ConvitePendente = {
  id: string;
  workspaceNome: string;
  role: WorkspaceRole;
  convidadoPor: string | null;
  expiraEm: Date;
};

/**
 * Convites válidos endereçados a este e-mail, em qualquer workspace.
 *
 * Existe para quem já está logado: sem isso o único caminho até um convite é o
 * link do e-mail, e quem apagou a mensagem fica sem saída.
 *
 * Casa por e-mail, não por usuário, porque é o e-mail que o convite endereça —
 * a mesma chave que o plugin confere na hora de aceitar. Aqui isso só decide o
 * que aparece na tela; quem autoriza o aceite continua sendo o plugin.
 *
 * O teto de 20 é anti-abuso: criar workspace é livre, então alguém poderia
 * abrir dezenas e convidar a mesma pessoa de cada um para entulhar a tela dela.
 */
export async function convitesPendentesPara(
  env: AppEnv,
  email: string,
): Promise<ConvitePendente[]> {
  const linhas = await getDb(env)
    .select({
      id: orgInvitation.id,
      workspaceNome: organization.name,
      role: orgInvitation.role,
      convidadoPor: userTable.email,
      expiraEm: orgInvitation.expiresAt,
    })
    .from(orgInvitation)
    .innerJoin(organization, eq(organization.id, orgInvitation.organizationId))
    .leftJoin(userTable, eq(userTable.id, orgInvitation.inviterId))
    .where(
      and(
        eq(orgInvitation.email, email.trim().toLowerCase()),
        eq(orgInvitation.status, "pending"),
        gt(orgInvitation.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(orgInvitation.createdAt))
    .limit(20)
    .all();

  // `role` é nullable no runtime do plugin; o convite sem papel cai no menor.
  return linhas.map((l) => ({ ...l, role: l.role ?? "viewer" }));
}
