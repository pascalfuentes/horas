import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { isLastAdminError } from "~/lib/errors";
import { deleteWorkspace, workspacesWhereSoleOwner } from "~/lib/workspaces";
import { actor, denyAccount } from "~/lib/guards";
import { codeFromAuthError, fail, handleAuthResponse, ok, str } from "~/lib/http";
import { canAdministerPlatform } from "~/lib/permissions";
import { countPlatformAdmins } from "~/lib/platform";
import { withinLimit } from "~/lib/throttle";

export const prerender = false;

const PAGE = "/dashboard/security";

/**
 * Account deletion (LGPD, art. 18, VI).
 *
 * The audit trail is anonymized in `deleteUser.afterDelete`, in auth.ts.
 * The database trigger still holds: the last active administrator cannot
 * delete themselves, and the message explains why instead of showing a raw
 * error.
 *
 * Everything that can refuse the deletion is asked BEFORE anything is
 * destroyed. The workspaces have to go before the account (see below), so a
 * password checked only at the last step meant that a wrong password, or a
 * session someone else was sitting in front of, wiped the person's workspaces
 * and left the account standing.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyAccount(locals);
  if (denied) return denied;

  const form = await request.formData();
  const me = actor(locals);
  const password = str(form, "password");

  // Typing your own email prevents the impulsive click — deleting cannot be undone.
  if (str(form, "confirmation").trim().toLowerCase() !== me.email.toLowerCase()) {
    return fail(PAGE, "confirm_email");
  }
  if (!password) return fail(PAGE, "fields");

  // ------------------------------------------------------------------
  // Workspaces where the person is the ONLY owner
  //
  // The `keep_one_owner_on_delete` trigger prevents removing the last owner of
  // a workspace that still exists — so deleting the account directly would be
  // refused by the database with a raw message. The rule:
  //
  //   • workspace only theirs → deletes the workspace FIRST (the cascade takes
  //                          the membership along, and then the user can leave)
  //   • workspace with more people → blocks and asks for a transfer, because
  //                          deleting would take everyone's work along
  // ------------------------------------------------------------------
  const soleOwned = await workspacesWhereSoleOwner(locals.env, me.id);
  const shared = soleOwned.filter((w) => w.memberCount > 1);

  if (shared.length > 0) {
    return fail(PAGE, "last_owner");
  }

  // ------------------------------------------------------------------
  // The password, before anything else is touched
  //
  // Counted per person, not per address: whoever is guessing here already
  // holds a session, and this is the one question that session cannot answer.
  // ------------------------------------------------------------------
  if (!(await withinLimit(locals.env, `delete-account:${me.id}`, { max: 5, windowSeconds: 600 }))) {
    return fail(PAGE, "rate_limit");
  }
  try {
    await locals.auth.api.verifyPassword({ body: { password }, headers: request.headers });
  } catch (error) {
    const code = codeFromAuthError(error);
    return fail(PAGE, code === "credentials" ? "current_password" : code);
  }

  // The trigger would refuse this at the very end, with the workspaces already
  // gone. Asked here, it is only a message.
  if (canAdministerPlatform(me.role) && (await countPlatformAdmins(locals.env)) <= 1) {
    return fail(PAGE, "last_admin");
  }

  // Recorded BEFORE: after deleting there is no actor left to record.
  await audit(locals.env, {
    action: AUDIT.SELF_ACCOUNT_DELETED,
    actorId: me.id,
    actorEmail: me.email,
    targetId: me.id,
    targetEmail: me.email,
    request,
  });

  try {
    // Order matters: deleting the user first would make the cascade try to
    // remove an owner from a workspace that still exists, and the trigger would
    // refuse.
    for (const ws of soleOwned) {
      await deleteWorkspace(locals.env, ws.id);
    }

    // Straight to the endpoint, not through the HTTP handler: the password was
    // already counted and checked above, and the handler's rate limiter could
    // still say "too many requests" at this point, with the workspaces gone.
    const res = await locals.auth.api.deleteUser({
      body: { password },
      headers: request.headers,
      asResponse: true,
    });
    if (!res.ok) {
      return handleAuthResponse(res, PAGE, PAGE, (c) => (c === "credentials" ? "current_password" : c));
    }
  } catch (error) {
    if (isLastAdminError(error)) return fail(PAGE, "last_admin");
    console.error("account/delete:", error);
    return fail(PAGE, "error");
  }

  return ok("/login", "ok_account_deleted");
};
