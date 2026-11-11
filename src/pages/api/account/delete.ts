import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import { isLastAdminError } from "~/lib/errors";
import { getDb } from "~/lib/auth";
import { organization } from "~/db/schema";
import { workspacesWhereSoleOwner } from "~/lib/workspaces";
import { eq } from "drizzle-orm";
import { actor, denyAccount } from "~/lib/guards";
import { fail, handleAuthResponse, ok, str } from "~/lib/http";

export const prerender = false;

const PAGE = "/dashboard/security";

/**
 * Eliminação da conta (LGPD, art. 18, VI).
 *
 * A trilha de auditoria é anonimizada em `deleteUser.afterDelete`, no auth.ts.
 * O trigger do banco ainda vale: o último administrador ativo não consegue se
 * apagar, e a mensagem explica o porquê em vez de mostrar erro cru.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyAccount(locals);
  if (denied) return denied;

  const form = await request.formData();
  const me = actor(locals);
  const senha = str(form, "password");

  // Digitar o próprio e-mail evita o clique impulsivo — apagar não tem volta.
  if (str(form, "confirmation").trim().toLowerCase() !== me.email.toLowerCase()) {
    return fail(PAGE, "confirm_email");
  }
  if (!senha) return fail(PAGE, "fields");

  // ------------------------------------------------------------------
  // Workspaces onde a pessoa é a ÚNICA owner
  //
  // O trigger `keep_one_owner_on_delete` impede remover o último owner de um
  // workspace que ainda existe — então apagar a conta direto seria recusado
  // pelo banco com uma mensagem crua. A regra:
  //
  //   • workspace só dela  → apaga o workspace ANTES (o cascade leva a
  //                          membership junto, e aí o usuário can sair)
  //   • workspace com mais gente → bloqueia e pede transferência, porque
  //                          apagar levaria o trabalho de todo mundo junto
  // ------------------------------------------------------------------
  const soDela = await workspacesWhereSoleOwner(locals.env, me.id);
  const compartilhados = soDela.filter((w) => w.totalMembros > 1);

  if (compartilhados.length > 0) {
    return fail(PAGE, "last_owner");
  }

  // Registrado ANTES: depois de apagar não há mais ator para registrar.
  await audit(locals.env, {
    action: AUDIT.SELF_ACCOUNT_DELETED,
    actorId: me.id,
    actorEmail: me.email,
    targetId: me.id,
    targetEmail: me.email,
    request,
  });

  try {
    // A ordem importa: apagar o usuário primeiro faria o cascade tentar remover
    // um owner de um workspace que ainda existe, e o trigger recusaria.
    const db = getDb(locals.env);
    for (const ws of soDela) {
      await db.delete(organization).where(eq(organization.id, ws.id));
    }

    const res = await callAuth(locals.auth, request, "/delete-user", { password: senha });
    if (!res.ok) {
      return handleAuthResponse(res, PAGE, PAGE, (c) => (c === "credentials" ? "current_password" : c));
    }
  } catch (error) {
    if (isLastAdminError(error)) return fail(PAGE, "last_admin");
    console.error("conta/apagar:", error);
    return fail(PAGE, "error");
  }

  return ok("/login", "ok_account_deleted");
};
