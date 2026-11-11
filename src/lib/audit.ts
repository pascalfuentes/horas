import { getDb } from "~/lib/auth";
import { auditLog } from "~/db/schema";
import type { AppEnv } from "~/lib/env";

/**
 * Audit trail. It feels like overkill on day 1 and is the first thing you want
 * on the day someone asks "who demoted so-and-so?".
 */
export const AUDIT = {
  SETUP_FIRST_ADMIN: "setup.first_admin",
  WORKSPACE_CREATED: "workspace.created",
  WORKSPACE_RENAMED: "workspace.renamed",
  WORKSPACE_DELETED: "workspace.deleted",
  WORKSPACE_OWNER_TRANSFERRED: "workspace.owner_transferred",
  MEMBER_INVITED: "member.invited",
  MEMBER_INVITE_CANCELLED: "member.invite_cancelled",
  MEMBER_JOINED: "member.joined",
  MEMBER_ROLE_CHANGED: "member.role_changed",
  MEMBER_REMOVED: "member.removed",
  MEMBER_LEFT: "member.left",
  INVITE_CREATED: "invite.created",
  INVITE_RESENT: "invite.resent",
  INVITE_REVOKED: "invite.revoked",
  INVITE_ACCEPTED: "invite.accepted",
  USER_ROLE_CHANGED: "user.role_changed",
  USER_DISABLED: "user.disabled",
  USER_ENABLED: "user.enabled",
  USER_SESSIONS_REVOKED: "user.sessions_revoked",
  USER_2FA_RESET: "user.2fa_reset",
  SELF_PROFILE_UPDATED: "self.profile_updated",
  SELF_PASSWORD_CHANGED: "self.password_changed",
  SELF_EMAIL_CHANGE_REQUESTED: "self.email_change_requested",
  SELF_SESSION_REVOKED: "self.session_revoked",
  SELF_2FA_ENABLED: "self.2fa_enabled",
  SELF_2FA_DISABLED: "self.2fa_disabled",
  SELF_2FA_CODES_REGENERATED: "self.2fa_codes_regenerated",
  SELF_ACCOUNT_DELETED: "self.account_deleted",
  SELF_DATA_EXPORTED: "self.data_exported",
  SELF_API_TOKEN_CREATED: "self.api_token_created",
  SELF_API_TOKEN_REVOKED: "self.api_token_revoked",
} as const;

export type AuditAction = (typeof AUDIT)[keyof typeof AUDIT];

export const AUDIT_LABELS: Record<AuditAction, string> = {
  [AUDIT.SETUP_FIRST_ADMIN]: "created the first administrator",
  [AUDIT.WORKSPACE_CREATED]: "created the workspace",
  [AUDIT.WORKSPACE_RENAMED]: "renamed the workspace",
  [AUDIT.WORKSPACE_DELETED]: "deleted the workspace",
  [AUDIT.WORKSPACE_OWNER_TRANSFERRED]: "transferred ownership to",
  [AUDIT.MEMBER_INVITED]: "invited",
  [AUDIT.MEMBER_INVITE_CANCELLED]: "canceled the invitation for",
  [AUDIT.MEMBER_JOINED]: "joined the workspace",
  [AUDIT.MEMBER_ROLE_CHANGED]: "changed the role of",
  [AUDIT.MEMBER_REMOVED]: "removed",
  [AUDIT.MEMBER_LEFT]: "left the workspace",
  [AUDIT.INVITE_CREATED]: "invited",
  [AUDIT.INVITE_RESENT]: "resent the invitation to",
  [AUDIT.INVITE_REVOKED]: "revoked the invitation for",
  [AUDIT.INVITE_ACCEPTED]: "accepted the invitation",
  [AUDIT.USER_ROLE_CHANGED]: "changed the role of",
  [AUDIT.USER_DISABLED]: "disabled",
  [AUDIT.USER_ENABLED]: "re-enabled",
  [AUDIT.USER_SESSIONS_REVOKED]: "revoked the sessions of",
  [AUDIT.USER_2FA_RESET]: "reset two-step verification for",
  [AUDIT.SELF_PROFILE_UPDATED]: "updated their own profile",
  [AUDIT.SELF_PASSWORD_CHANGED]: "changed their own password",
  [AUDIT.SELF_EMAIL_CHANGE_REQUESTED]: "requested a change of their own email",
  [AUDIT.SELF_SESSION_REVOKED]: "revoked one of their own sessions",
  [AUDIT.SELF_2FA_ENABLED]: "enabled two-step verification",
  [AUDIT.SELF_2FA_DISABLED]: "disabled two-step verification",
  [AUDIT.SELF_2FA_CODES_REGENERATED]: "generated new recovery codes",
  [AUDIT.SELF_ACCOUNT_DELETED]: "deleted their own account",
  [AUDIT.SELF_DATA_EXPORTED]: "exported their own data",
  [AUDIT.SELF_API_TOKEN_CREATED]: "created an API/MCP token",
  [AUDIT.SELF_API_TOKEN_REVOKED]: "revoked an API/MCP token",
};

type Entry = {
  action: AuditAction;
  actorId?: string | null;
  actorEmail?: string | null;
  targetId?: string | null;
  targetEmail?: string | null;
  details?: Record<string, unknown>;
  /** Every event inside a workspace carries which one. */
  workspaceId?: string | null;
  request?: Request;
};

export async function audit(env: AppEnv, entry: Entry): Promise<void> {
  try {
    await getDb(env)
      .insert(auditLog)
      .values({
        id: crypto.randomUUID(),
        createdAt: new Date(),
        action: entry.action,
        actorId: entry.actorId ?? null,
        actorEmail: entry.actorEmail ?? null,
        targetId: entry.targetId ?? null,
        targetEmail: entry.targetEmail ?? null,
        details: entry.details ? JSON.stringify(entry.details) : null,
        workspaceId: entry.workspaceId ?? null,
        ip: entry.request ? clientIp(entry.request) : null,
      });
  } catch (error) {
    // Auditing never takes down the operation it is recording.
    console.error("Failed to write audit_log:", error);
  }
}

export function clientIp(request: Request): string | null {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}
