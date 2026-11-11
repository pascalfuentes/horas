import type { APIRoute } from "astro";

import { WORKSPACE_ROLES, type WorkspaceRole } from "~/db/schema";
import { AUDIT, audit } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import { actor, deny, workspaceAtual } from "~/lib/guards";
import { codeFromAuthError, fail, handleAuthResponse, isEmail, ok, str } from "~/lib/http";
import { jaEMembro, temConvitePendente } from "~/lib/membros";
import { PERMISSIONS } from "~/lib/permissions";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = deny(locals, PERMISSIONS.MEMBERS_WRITE);
  if (denied) return denied;

  const ws = workspaceAtual(locals);
  const me = actor(locals);
  const form = await request.formData();
  const acao = str(form, "acao");
  const PAGE = `/w/${ws.workspaceSlug}/membros`;

  try {
    if (acao === "convidar") {
      const email = str(form, "email").toLowerCase();
      const papel = str(form, "papel") as WorkspaceRole;

      if (!isEmail(email)) return fail(PAGE, "email_invalido");
      // Validamos o papel ANTES do plugin: a validação dele une os papéis
      // padrão aos nossos, então "member" passaria — e criaria alguém com zero
      // permissões, um estado que não existe na nossa matriz.
      if (!(WORKSPACE_ROLES as readonly string[]).includes(papel)) return fail(PAGE, "papel_invalido");
      // Ninguém convida para `owner`: dono se torna por transferência, que é
      // uma ação deliberada de quem já é dono.
      if (papel === "owner") return fail(PAGE, "papel_invalido");

      if (await jaEMembro(locals.env, ws.workspaceId, email)) return fail(PAGE, "ja_e_membro");
      if (await temConvitePendente(locals.env, ws.workspaceId, email)) {
        return fail(PAGE, "convite_pendente");
      }

      const res = await callAuth(locals.auth, request, "/organization/invite-member", {
        email,
        role: papel,
        organizationId: ws.workspaceId,
      });
      if (!res.ok) return handleAuthResponse(res, PAGE, PAGE);

      await audit(locals.env, {
        action: AUDIT.MEMBER_INVITED,
        actorId: me.id,
        actorEmail: me.email,
        targetEmail: email,
        workspaceId: ws.workspaceId,
        details: { papel },
        request,
      });
      return ok(PAGE, "ok_convite_enviado");
    }

    const id = str(form, "id");
    if (!id) return fail(PAGE, "campos");

    if (acao === "cancelar") {
      const res = await callAuth(locals.auth, request, "/organization/cancel-invitation", {
        invitationId: id,
      });
      if (!res.ok) return handleAuthResponse(res, PAGE, PAGE);

      await audit(locals.env, {
        action: AUDIT.MEMBER_INVITE_CANCELLED,
        actorId: me.id,
        actorEmail: me.email,
        targetEmail: str(form, "email") || null,
        workspaceId: ws.workspaceId,
        request,
      });
      return ok(PAGE, "ok_convite_cancelado");
    }

    if (acao === "reenviar") {
      const email = str(form, "email").toLowerCase();
      const papel = (str(form, "papel") || "viewer") as WorkspaceRole;
      if (!isEmail(email)) return fail(PAGE, "email_invalido");

      // `cancelPendingInvitationsOnReInvite` está ligado: o convite anterior é
      // cancelado e um novo sai, com validade nova.
      const res = await callAuth(locals.auth, request, "/organization/invite-member", {
        email,
        role: papel,
        organizationId: ws.workspaceId,
        resend: true,
      });
      if (!res.ok) return handleAuthResponse(res, PAGE, PAGE);

      await audit(locals.env, {
        action: AUDIT.MEMBER_INVITED,
        actorId: me.id,
        actorEmail: me.email,
        targetEmail: email,
        workspaceId: ws.workspaceId,
        details: { papel, reenvio: true },
        request,
      });
      return ok(PAGE, "ok_convite_enviado");
    }

    return fail(PAGE, "campos");
  } catch (error) {
    console.error("convites do workspace:", error);
    return fail(PAGE, codeFromAuthError(error));
  }
};
