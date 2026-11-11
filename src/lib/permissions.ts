import { WORKSPACE_ROLES, type WorkspaceRole } from "~/db/schema";

/**
 * Role × permission matrix INSIDE A WORKSPACE.
 *
 * The rule is declared ONCE here and checked on the server in every handler
 * that writes. Hiding a button in the interface is not authorization — the UI
 * uses `can()` only to avoid showing an action that would fail anyway.
 *
 * Do not confuse it with the PLATFORM role (`user.role`), which answers another
 * question: who operates the installation. See `canAdministerPlatform()`.
 */
export const PERMISSIONS = {
  /** Read the workspace's business data. */
  CONTENT_READ: "content:read",
  /** Create, edit and delete the workspace's business data. */
  CONTENT_WRITE: "content:write",

  /** See the member list and the pending invites. */
  MEMBERS_READ: "members:read",
  /** Invite, change role, remove a member. */
  MEMBERS_WRITE: "members:write",

  /** See the workspace settings. */
  WORKSPACE_READ: "workspace:read",
  /** Rename, change the slug, and in the future connect integrations. */
  WORKSPACE_WRITE: "workspace:write",
  /** Delete the entire workspace. */
  WORKSPACE_DELETE: "workspace:delete",
  /** Hand ownership over to another person. */
  WORKSPACE_TRANSFER: "workspace:transfer",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * Notice what is NOT here: managing your own account.
 *
 * The account exists outside any workspace — the same person can be `owner` in
 * one and `viewer` in another, and there is only one password. Guarding that
 * by workspace role would mix two different questions. What handles it is
 * `denyAccount()` in `src/lib/guards.ts`.
 */

const P = PERMISSIONS;

const MATRIX: Record<WorkspaceRole, readonly Permission[]> = {
  owner: [
    P.CONTENT_READ,
    P.CONTENT_WRITE,
    P.MEMBERS_READ,
    P.MEMBERS_WRITE,
    P.WORKSPACE_READ,
    P.WORKSPACE_WRITE,
    P.WORKSPACE_DELETE,
    P.WORKSPACE_TRANSFER,
  ],
  admin: [
    P.CONTENT_READ,
    P.CONTENT_WRITE,
    P.MEMBERS_READ,
    P.MEMBERS_WRITE,
    P.WORKSPACE_READ,
    P.WORKSPACE_WRITE,
  ],
  editor: [P.CONTENT_READ, P.CONTENT_WRITE, P.MEMBERS_READ, P.WORKSPACE_READ],
  viewer: [P.CONTENT_READ, P.MEMBERS_READ, P.WORKSPACE_READ],
};

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/** Can the person, with this role in the workspace, do this? */
export function can(role: unknown, permission: Permission): boolean {
  if (!isWorkspaceRole(role)) return false;
  return MATRIX[role].includes(permission);
}

/**
 * Platform superadmin — another question, another answer.
 *
 * It gives no free pass in any workspace: to act inside a workspace, you must
 * be a member of it like anyone else. All this unlocks is the INSTALLATION's
 * administration area.
 */
export function canAdministerPlatform(platformRole: unknown): boolean {
  return platformRole === "admin";
}

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Administrator",
  editor: "Editor",
  viewer: "Viewer",
};

/** Platform role — another axis, other labels. */
export const PLATFORM_ROLE_LABELS: Record<string, string> = {
  admin: "Platform superadmin",
  user: "User",
};

export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  owner: "Everything, including deleting the workspace and transferring ownership.",
  admin: "Manages members, invitations and settings. Can't delete the workspace.",
  editor: "Creates and edits content. Can't manage members.",
  viewer: "Read-only access to content.",
};
