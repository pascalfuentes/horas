import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import { actor, deny, currentWorkspace } from "~/lib/guards";
import { codeFromAuthError, fail, handleAuthResponse, ok, str } from "~/lib/http";
import { PERMISSIONS } from "~/lib/permissions";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const ws = currentWorkspace(locals);
  const me = actor(locals);
  const form = await request.formData();
  const action = str(form, "action");
  const PAGE = `/w/${ws.workspaceSlug}/settings`;

  try {
    if (action === "rename") {
      const denied = deny(locals, PERMISSIONS.WORKSPACE_WRITE);
      if (denied) return denied;

      const name = str(form, "name");
      if (!name) return fail(PAGE, "fields");

      // Only the name changes; the slug stays. Changing the slug would break
      // every link already shared for this workspace, including those in emails.
      const res = await callAuth(locals.auth, request, "/organization/update", {
        organizationId: ws.workspaceId,
        data: { name: name.slice(0, 60) },
      });
      if (!res.ok) return handleAuthResponse(res, PAGE, PAGE);

      await audit(locals.env, {
        action: AUDIT.WORKSPACE_RENAMED,
        actorId: me.id,
        actorEmail: me.email,
        workspaceId: ws.workspaceId,
        details: { from: ws.workspaceName, to: name },
        request,
      });
      return ok(PAGE, "ok_workspace_renamed");
    }

    if (action === "delete") {
      const denied = deny(locals, PERMISSIONS.WORKSPACE_DELETE);
      if (denied) return denied;

      // Typing the name prevents the impulsive click — deleting takes along
      // everyone's content and membership, and cannot be undone.
      if (str(form, "confirmation").trim() !== ws.workspaceName) {
        return fail(PAGE, "confirm_name");
      }

      // Recorded BEFORE: after deleting, the audit_log FK becomes NULL and
      // there would be no workspace left to point to.
      await audit(locals.env, {
        action: AUDIT.WORKSPACE_DELETED,
        actorId: me.id,
        actorEmail: me.email,
        workspaceId: ws.workspaceId,
        details: { name: ws.workspaceName, slug: ws.workspaceSlug },
        request,
      });

      const res = await callAuth(locals.auth, request, "/organization/delete", {
        organizationId: ws.workspaceId,
      });
      if (!res.ok) return handleAuthResponse(res, "/workspaces", PAGE);

      return ok("/workspaces", "ok_workspace_deleted");
    }

    return fail(PAGE, "fields");
  } catch (error) {
    console.error("workspace settings:", error);
    return fail(PAGE, codeFromAuthError(error));
  }
};
