import type { APIRoute } from "astro";

import { WORKSPACE_ROLES, type WorkspaceRole } from "~/db/schema";
import { AUDIT, audit } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import { isLastOwnerError } from "~/lib/errors";
import { actor, deny, denyAccount, currentWorkspace } from "~/lib/guards";
import { codeFromAuthError, fail, handleAuthResponse, ok, str } from "~/lib/http";
import { memberById, transferOwnership } from "~/lib/members";
import { PERMISSIONS } from "~/lib/permissions";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  // Sair do workspace é a única ação aqui que NÃO exige members:write — é sobre
  // a sua própria participação. Quem tem só `viewer` também can sair.
  const denied = str(await peek(request), "action") === "leave"
    ? denyAccount(locals)
    : deny(locals, PERMISSIONS.MEMBERS_WRITE);
  if (denied) return denied;

  const ws = currentWorkspace(locals);
  const me = actor(locals);
  const form = await request.formData();
  const acao = str(form, "action");
  const PAGE = `/w/${ws.workspaceSlug}/members`;

  try {
    if (acao === "leave") {
      // O trigger `keep_one_owner_on_delete` recusa se você for o último dono —
      // e está certo: o workspace ficaria órfão. Transfira antes.
      const res = await callAuth(locals.auth, request, "/organization/leave", {
        organizationId: ws.workspaceId,
      });
      if (!res.ok) return handleAuthResponse(res, "/workspaces", PAGE);

      await audit(locals.env, {
        action: AUDIT.MEMBER_LEFT,
        actorId: me.id,
        actorEmail: me.email,
        workspaceId: ws.workspaceId,
        request,
      });
      return ok("/workspaces", "ok_left");
    }

    const memberId = str(form, "memberId");
    if (!memberId) return fail(PAGE, "fields");

    const alvo = await memberById(locals.env, ws.workspaceId, memberId);
    if (!alvo) return fail(PAGE, "fields");

    if (acao === "role") {
      const papel = str(form, "role") as WorkspaceRole;
      // A checagem do próprio membro vem primeiro para a mensagem dizer o que
      // de fato aconteceu: quem tenta mudar o próprio papel sendo dono ouviria
      // "papel inválido", que não explica nada.
      if (alvo.userId === me.id) return fail(PAGE, "own_membership");
      if (!(WORKSPACE_ROLES as readonly string[]).includes(papel)) return fail(PAGE, "invalid_role");
      // Virar dono é transferência, não troca de papel: tem ação própria.
      if (papel === "owner" || alvo.role === "owner") return fail(PAGE, "invalid_role");

      const res = await callAuth(locals.auth, request, "/organization/update-member-role", {
        memberId,
        role: papel,
        organizationId: ws.workspaceId,
      });
      if (!res.ok) return handleAuthResponse(res, PAGE, PAGE);

      await audit(locals.env, {
        action: AUDIT.MEMBER_ROLE_CHANGED,
        actorId: me.id,
        actorEmail: me.email,
        targetId: alvo.userId,
        targetEmail: alvo.email,
        workspaceId: ws.workspaceId,
        details: { de: alvo.role, para: papel },
        request,
      });
      return ok(PAGE, "ok_member_role");
    }

    if (acao === "remove") {
      if (alvo.userId === me.id) return fail(PAGE, "own_membership");

      const res = await callAuth(locals.auth, request, "/organization/remove-member", {
        memberIdOrEmail: memberId,
        organizationId: ws.workspaceId,
      });
      if (!res.ok) return handleAuthResponse(res, PAGE, PAGE);

      await audit(locals.env, {
        action: AUDIT.MEMBER_REMOVED,
        actorId: me.id,
        actorEmail: me.email,
        targetId: alvo.userId,
        targetEmail: alvo.email,
        workspaceId: ws.workspaceId,
        request,
      });
      return ok(PAGE, "ok_member_removed");
    }

    if (acao === "transfer") {
      const podeTransferir = deny(locals, PERMISSIONS.WORKSPACE_TRANSFER);
      if (podeTransferir) return podeTransferir;
      if (alvo.userId === me.id) return fail(PAGE, "own_membership");

      const meuMembro = await memberById(locals.env, ws.workspaceId, str(form, "myMemberId"));
      if (!meuMembro || meuMembro.userId !== me.id) return fail(PAGE, "fields");

      await transferOwnership(locals.env, {
        workspaceId: ws.workspaceId,
        deMemberId: meuMembro.memberId,
        paraMemberId: alvo.memberId,
      });

      await audit(locals.env, {
        action: AUDIT.WORKSPACE_OWNER_TRANSFERRED,
        actorId: me.id,
        actorEmail: me.email,
        targetId: alvo.userId,
        targetEmail: alvo.email,
        workspaceId: ws.workspaceId,
        request,
      });
      return ok(PAGE, "ok_transferred");
    }

    return fail(PAGE, "fields");
  } catch (error) {
    if (isLastOwnerError(error)) return fail(PAGE, "last_owner");
    console.error("membros do workspace:", error);
    return fail(PAGE, codeFromAuthError(error));
  }
};

/**
 * O corpo só can ser lido uma vez, e a escolha do guard depende da ação. Lê de
 * um clone para decidir, e o handler lê o original.
 */
async function peek(request: Request): Promise<FormData> {
  return request.clone().formData();
}
