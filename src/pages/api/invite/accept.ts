import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import { actor, denyAccount } from "~/lib/guards";
import { codeFromAuthError, fail, handleAuthResponse, ok, str } from "~/lib/http";

export const prerender = false;

/**
 * Accept or decline a workspace invite.
 *
 * Two locks the plugin itself applies, and which are the point of the flow:
 *
 *   • the SESSION email must be the invite's (YOU_ARE_NOT_THE_RECIPIENT).
 *     Without that, whoever intercepted the link would get in with their own
 *     account.
 *   • the email must be VERIFIED. Without that, signing up with an invitee's
 *     address would be enough to inherit their invite.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyAccount(locals);
  if (denied) return denied;

  const form = await request.formData();
  const id = str(form, "id");
  const decline = str(form, "action") === "decline";
  const back = `/invite/${encodeURIComponent(id)}`;

  if (!id) return fail("/workspaces", "fields");

  const me = actor(locals);

  try {
    const res = await callAuth(
      locals.auth,
      request,
      decline ? "/organization/reject-invitation" : "/organization/accept-invitation",
      { invitationId: id },
    );
    if (!res.ok) return handleAuthResponse(res, "/workspaces", back);

    if (decline) return ok("/workspaces");

    const body = (await res.clone().json().catch(() => null)) as
      | { invitation?: { organizationId?: string } }
      | null;

    await audit(locals.env, {
      action: AUDIT.MEMBER_JOINED,
      actorId: me.id,
      actorEmail: me.email,
      workspaceId: body?.invitation?.organizationId ?? null,
      request,
    });

    return ok("/dashboard", "ok_invite_accepted");
  } catch (error) {
    console.error("accept invite:", error);
    return fail(back, codeFromAuthError(error));
  }
};
