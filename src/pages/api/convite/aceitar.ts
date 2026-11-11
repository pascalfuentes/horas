import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import { actor, denyConta } from "~/lib/guards";
import { codeFromAuthError, fail, handleAuthResponse, ok, str } from "~/lib/http";

export const prerender = false;

/**
 * Aceitar ou recusar um convite de workspace.
 *
 * Duas travas que o próprio plugin aplica, e que são o ponto do fluxo:
 *
 *   • o e-mail da SESSÃO precisa ser o do convite (YOU_ARE_NOT_THE_RECIPIENT).
 *     Sem isso, quem interceptasse o link entraria com a própria conta.
 *   • o e-mail precisa estar VERIFICADO. Sem isso, bastaria cadastrar-se com o
 *     endereço de um convidado para herdar o convite dele.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyConta(locals);
  if (denied) return denied;

  const form = await request.formData();
  const id = str(form, "id");
  const recusar = str(form, "acao") === "recusar";
  const back = `/convite/${encodeURIComponent(id)}`;

  if (!id) return fail("/workspaces", "campos");

  const me = actor(locals);

  try {
    const res = await callAuth(
      locals.auth,
      request,
      recusar ? "/organization/reject-invitation" : "/organization/accept-invitation",
      { invitationId: id },
    );
    if (!res.ok) return handleAuthResponse(res, "/workspaces", back);

    if (recusar) return ok("/workspaces");

    const corpo = (await res.clone().json().catch(() => null)) as
      | { invitation?: { organizationId?: string } }
      | null;

    await audit(locals.env, {
      action: AUDIT.MEMBER_JOINED,
      actorId: me.id,
      actorEmail: me.email,
      workspaceId: corpo?.invitation?.organizationId ?? null,
      request,
    });

    return ok("/dashboard", "ok_convite_aceito");
  } catch (error) {
    console.error("aceitar convite:", error);
    return fail(back, codeFromAuthError(error));
  }
};
