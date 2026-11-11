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
  // Leaving the workspace is the only action here that does NOT require
  // members:write — it is about your own membership. Someone with only `viewer`
  // can leave too.
  const denied = str(await peek(request), "action") === "leave"
    ? denyAccount(locals)
    : deny(locals, PERMISSIONS.MEMBERS_WRITE);
  if (denied) return denied;

  const ws = currentWorkspace(locals);
  const me = actor(locals);
  const form = await request.formData();
  const action = str(form, "action");
  const PAGE = `/w/${ws.workspaceSlug}/members`;

  try {
    if (action === "leave") {
      // The `keep_one_owner_on_delete` trigger refuses if you are the last
      // owner — and rightly so: the workspace would be orphaned. Transfer first.
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

    const target = await memberById(locals.env, ws.workspaceId, memberId);
    if (!target) return fail(PAGE, "fields");

    if (action === "role") {
      const role = str(form, "role") as WorkspaceRole;
      // The own-member check comes first so the message says what actually
      // happened: an owner trying to change their own role would hear
      // "invalid role", which explains nothing.
      if (target.userId === me.id) return fail(PAGE, "own_membership");
      if (!(WORKSPACE_ROLES as readonly string[]).includes(role)) return fail(PAGE, "invalid_role");
      // Becoming owner is a transfer, not a role change: it has its own action.
      if (role === "owner" || target.role === "owner") return fail(PAGE, "invalid_role");

      const res = await callAuth(locals.auth, request, "/organization/update-member-role", {
        memberId,
        role,
        organizationId: ws.workspaceId,
      });
      if (!res.ok) return handleAuthResponse(res, PAGE, PAGE);

      await audit(locals.env, {
        action: AUDIT.MEMBER_ROLE_CHANGED,
        actorId: me.id,
        actorEmail: me.email,
        targetId: target.userId,
        targetEmail: target.email,
        workspaceId: ws.workspaceId,
        details: { from: target.role, to: role },
        request,
      });
      return ok(PAGE, "ok_member_role");
    }

    if (action === "remove") {
      if (target.userId === me.id) return fail(PAGE, "own_membership");

      const res = await callAuth(locals.auth, request, "/organization/remove-member", {
        memberIdOrEmail: memberId,
        organizationId: ws.workspaceId,
      });
      if (!res.ok) return handleAuthResponse(res, PAGE, PAGE);

      await audit(locals.env, {
        action: AUDIT.MEMBER_REMOVED,
        actorId: me.id,
        actorEmail: me.email,
        targetId: target.userId,
        targetEmail: target.email,
        workspaceId: ws.workspaceId,
        request,
      });
      return ok(PAGE, "ok_member_removed");
    }

    if (action === "transfer") {
      const transferDenied = deny(locals, PERMISSIONS.WORKSPACE_TRANSFER);
      if (transferDenied) return transferDenied;
      if (target.userId === me.id) return fail(PAGE, "own_membership");

      const myMember = await memberById(locals.env, ws.workspaceId, str(form, "myMemberId"));
      if (!myMember || myMember.userId !== me.id) return fail(PAGE, "fields");

      await transferOwnership(locals.env, {
        workspaceId: ws.workspaceId,
        fromMemberId: myMember.memberId,
        toMemberId: target.memberId,
      });

      await audit(locals.env, {
        action: AUDIT.WORKSPACE_OWNER_TRANSFERRED,
        actorId: me.id,
        actorEmail: me.email,
        targetId: target.userId,
        targetEmail: target.email,
        workspaceId: ws.workspaceId,
        request,
      });
      return ok(PAGE, "ok_transferred");
    }

    return fail(PAGE, "fields");
  } catch (error) {
    if (isLastOwnerError(error)) return fail(PAGE, "last_owner");
    console.error("workspace members:", error);
    return fail(PAGE, codeFromAuthError(error));
  }
};

/**
 * The body can only be read once, and the choice of guard depends on the
 * action. Reads from a clone to decide, and the handler reads the original.
 */
async function peek(request: Request): Promise<FormData> {
  return request.clone().formData();
}
