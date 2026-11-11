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
  const action = str(form, "action");
  const PAGE = `/w/${ws.workspaceSlug}/members`;

  try {
    if (action === "invite") {
      const email = str(form, "email").toLowerCase();
      const role = str(form, "role") as WorkspaceRole;

      if (!isEmail(email)) return fail(PAGE, "invalid_email");
      // We validate the role BEFORE the plugin: its validation merges the
      // default roles with ours, so "member" would pass — and would create
      // someone with zero permissions, a state that does not exist in our matrix.
      if (!(WORKSPACE_ROLES as readonly string[]).includes(role)) return fail(PAGE, "invalid_role");
      // Nobody invites to `owner`: one becomes owner by transfer, which is a
      // deliberate action by someone who already is one.
      if (role === "owner") return fail(PAGE, "invalid_role");

      if (await isAlreadyMember(locals.env, ws.workspaceId, email)) return fail(PAGE, "already_member");
      if (await hasPendingInvite(locals.env, ws.workspaceId, email)) {
        return fail(PAGE, "invite_pending");
      }

      const res = await callAuth(locals.auth, request, "/organization/invite-member", {
        email,
        role,
        organizationId: ws.workspaceId,
      });
      if (!res.ok) return handleAuthResponse(res, PAGE, PAGE);

      await audit(locals.env, {
        action: AUDIT.MEMBER_INVITED,
        actorId: me.id,
        actorEmail: me.email,
        targetEmail: email,
        workspaceId: ws.workspaceId,
        details: { role },
        request,
      });
      return ok(PAGE, "ok_invite_sent");
    }

    const id = str(form, "id");
    if (!id) return fail(PAGE, "fields");

    if (action === "cancel") {
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

    if (action === "resend") {
      const email = str(form, "email").toLowerCase();
      const role = (str(form, "role") || "viewer") as WorkspaceRole;
      if (!isEmail(email)) return fail(PAGE, "invalid_email");

      // `cancelPendingInvitationsOnReInvite` is on: the previous invite is
      // cancelled and a new one goes out, with a fresh expiry.
      const res = await callAuth(locals.auth, request, "/organization/invite-member", {
        email,
        role,
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
        details: { role, resend: true },
        request,
      });
      return ok(PAGE, "ok_invite_sent");
    }

    return fail(PAGE, "fields");
  } catch (error) {
    console.error("workspace invites:", error);
    return fail(PAGE, codeFromAuthError(error));
  }
};
