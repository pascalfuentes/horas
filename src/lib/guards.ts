import { canAdministerPlatform, can, type Permission } from "~/lib/permissions";

export { isLastAdminError } from "~/lib/errors";

/**
 * Authorization for handlers.
 *
 * House rule: the middleware is the coarse gate (are you signed in? are you a
 * member of this workspace?), and EVERY handler that writes still calls the
 * guard with the exact permission. Hiding the button in the interface is not
 * authorization; blocking the method on the server is.
 *
 * There are three guards because there are three different questions.
 */

/**
 * Routes for YOUR OWN ACCOUNT: name, password, email, sessions, 2FA, export,
 * delete.
 *
 * Being authenticated is enough. Everyone manages their own account, whatever
 * their role in any workspace — including those who are only a `viewer`.
 * "Read-only" applies to business data, not to your own password.
 */
export function denyAccount(locals: App.Locals): Response | null {
  if (!locals.user) return new Response("Not authenticated", { status: 401 });
  return null;
}

/**
 * Routes INSIDE A WORKSPACE.
 *
 * Requires membership — which the middleware has already resolved from the slug
 * in the URL. With no workspace in context, it denies: a workspace route with
 * no resolved workspace is a programming error, and the safe side to err on is
 * closed.
 */
export function deny(locals: App.Locals, permission: Permission): Response | null {
  if (!locals.user) return new Response("Not authenticated", { status: 401 });
  if (!locals.membership) return new Response("Workspace not found", { status: 404 });
  if (!can(locals.membership.role, permission)) {
    return new Response("Permission denied", { status: 403 });
  }
  return null;
}

/**
 * PLATFORM administration area.
 *
 * Being a superadmin is no free pass inside someone else's workspace: to act
 * in a workspace you must be a member of it, like anyone else.
 */
export function denyPlatform(locals: App.Locals): Response | null {
  if (!locals.user) return new Response("Not authenticated", { status: 401 });
  if (!canAdministerPlatform(locals.user.role)) {
    return new Response("Permission denied", { status: 403 });
  }
  return null;
}

/** The signed-in user, typed as non-null. Only use after a guard. */
export function actor(locals: App.Locals): { id: string; email: string; role: string } {
  const u = locals.user!;
  return { id: u.id, email: u.email, role: String(u.role ?? "user") };
}

/** The workspace in context, typed as non-null. Only use after `deny()`. */
export function currentWorkspace(locals: App.Locals) {
  return locals.membership!;
}
