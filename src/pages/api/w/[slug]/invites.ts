import type { APIRoute } from "astro";

import { WORKSPACE_ROLES, type WorkspaceRole } from "~/db/schema";
import { AUDIT, audit } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import { actor, deny, currentWorkspace } from "~/lib/guards";
import { codeFromAuthError, fail, handleAuthResponse, isEmail, ok, str } from "~/lib/http";
import { isAlreadyMember, hasPendingInvite } from "~/lib/members";
import { PERMISSIONS } from "~/lib/permissions";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = deny(locals, PERMISSIONS.MEMBERS_WRITE);
  if (denied) return denied;

  const ws = currentWorkspace(locals);
  const me = actor(locals);
  const form = await request.formData();
  const acao = str(form, "action");
  const PAGE = `/w/${ws.workspaceSlug}/members`;

  try {
    if (acao === "invite") {
      const email = str(form, "email").toLowerCase();
      const papel = str(form, "role") as WorkspaceRole;

      if (!isEmail(email)) return fail(PAGE, "invalid_email");
      // Validamos o papel ANTES do plugin: a validação dele une os papéis
      // padrão aos nossos, então "member" passaria — e criaria alguém com zero
      // permissões, um estado que não existe na nossa matriz.
      if (!(WORKSPACE_ROLES as readonly string[]).includes(papel)) return fail(PAGE, "invalid_role");
      // Ninguém convida para `owner`: dono se torna por transferência, que é
      // uma ação deliberada de quem já é dono.
      if (papel === "owner") return fail(PAGE, "invalid_role");

      if (await isAlreadyMember(locals.env, ws.workspaceId, email)) return fail(PAGE, "already_member");
      if (await hasPendingInvite(locals.env, ws.workspaceId, email)) {
        return fail(PAGE, "invite_pending");
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
      return ok(PAGE, "ok_invite_sent");
    }

    const id = str(form, "id");
    if (!id) return fail(PAGE, "fields");

    if (acao === "cancel") {
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
      return ok(PAGE, "ok_invite_cancelled");
    }

    if (acao === "resend") {
      const email = str(form, "email").toLowerCase();
      const papel = (str(form, "role") || "viewer") as WorkspaceRole;
      if (!isEmail(email)) return fail(PAGE, "invalid_email");

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
      return ok(PAGE, "ok_invite_sent");
    }

    return fail(PAGE, "fields");
  } catch (error) {
    console.error("convites do workspace:", error);
    return fail(PAGE, codeFromAuthError(error));
  }
};
