import { getDb } from "~/lib/auth";
import { auditLog } from "~/db/schema";
import type { AppEnv } from "~/lib/env";

/**
 * Trilha de auditoria. Parece exagero no dia 1 e é a primeira coisa que você
 * quer no dia em que alguém pergunta "quem rebaixou o fulano?".
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
  [AUDIT.SETUP_FIRST_ADMIN]: "criou o primeiro administrador",
  [AUDIT.WORKSPACE_CREATED]: "criou o workspace",
  [AUDIT.WORKSPACE_RENAMED]: "renomeou o workspace",
  [AUDIT.WORKSPACE_DELETED]: "excluiu o workspace",
  [AUDIT.WORKSPACE_OWNER_TRANSFERRED]: "transferiu a propriedade para",
  [AUDIT.MEMBER_INVITED]: "convidou",
  [AUDIT.MEMBER_INVITE_CANCELLED]: "cancelou o convite de",
  [AUDIT.MEMBER_JOINED]: "entrou no workspace",
  [AUDIT.MEMBER_ROLE_CHANGED]: "mudou o papel de",
  [AUDIT.MEMBER_REMOVED]: "removeu",
  [AUDIT.MEMBER_LEFT]: "saiu do workspace",
  [AUDIT.INVITE_CREATED]: "convidou",
  [AUDIT.INVITE_RESENT]: "reenviou convite para",
  [AUDIT.INVITE_REVOKED]: "revogou convite de",
  [AUDIT.INVITE_ACCEPTED]: "aceitou o convite",
  [AUDIT.USER_ROLE_CHANGED]: "mudou o papel de",
  [AUDIT.USER_DISABLED]: "desativou",
  [AUDIT.USER_ENABLED]: "reativou",
  [AUDIT.USER_SESSIONS_REVOKED]: "revogou as sessões de",
  [AUDIT.USER_2FA_RESET]: "destravou a verificação em duas etapas de",
  [AUDIT.SELF_PROFILE_UPDATED]: "atualizou o próprio perfil",
  [AUDIT.SELF_PASSWORD_CHANGED]: "trocou a própria senha",
  [AUDIT.SELF_EMAIL_CHANGE_REQUESTED]: "pediu troca do próprio e-mail",
  [AUDIT.SELF_SESSION_REVOKED]: "revogou uma sessão própria",
  [AUDIT.SELF_2FA_ENABLED]: "ativou a verificação em duas etapas",
  [AUDIT.SELF_2FA_DISABLED]: "desativou a verificação em duas etapas",
  [AUDIT.SELF_2FA_CODES_REGENERATED]: "gerou novos códigos de recuperação",
  [AUDIT.SELF_ACCOUNT_DELETED]: "apagou a própria conta",
  [AUDIT.SELF_DATA_EXPORTED]: "exportou os próprios dados",
  [AUDIT.SELF_API_TOKEN_CREATED]: "criou um token de API/MCP",
  [AUDIT.SELF_API_TOKEN_REVOKED]: "revogou um token de API/MCP",
};

type Entry = {
  action: AuditAction;
  actorId?: string | null;
  actorEmail?: string | null;
  targetId?: string | null;
  targetEmail?: string | null;
  details?: Record<string, unknown>;
  /** Todo evento dentro de um workspace carrega de qual. */
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
    // Auditoria nunca derruba a operação que ela está registrando.
    console.error("Falha ao gravar audit_log:", error);
  }
}

export function clientIp(request: Request): string | null {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}
