/**
 * Mensagens de feedback viajam como CÓDIGO na querystring, nunca como texto
 * livre. Assim nada que o usuário digitou volta refletido na URL.
 */
export const MESSAGES: Record<string, string> = {
  // erros
  fields: "Preencha todos os campos obrigatórios.",
  credentials: "E-mail ou senha incorretos.",
  password_short: "A senha precisa de pelo menos 10 caracteres.",
  password_mismatch: "As senhas não conferem.",
  current_password: "A senha atual está incorreta.",
  invalid_email: "Informe um e-mail válido.",
  email_in_use: "Não foi possível usar este e-mail.",
  invalid_invite: "Convite inválido, expirado ou já utilizado.",
  duplicate_invite: "Já existe um convite pendente para este e-mail.",
  user_exists: "Já existe uma conta com este e-mail.",
  last_admin: "Esta é a única conta de administrador ativa. Promova outra pessoa antes.",
  not_recipient:
    "Este convite é para outro e-mail. Entre com a conta do endereço que recebeu o convite.",
  invite_expired: "Este convite expirou ou já foi usado. Peça outro.",
  already_member: "Essa pessoa já participa deste workspace.",
  invite_pending: "Já existe um convite pendente para esse e-mail.",
  own_membership: "Você não can fazer isso com a sua própria participação.",
  invalid_role: "Papel inválido.",
  last_owner:
    "Você é a única pessoa dona de um workspace que tem outros membros. Transfira a propriedade antes de apagar a conta.",
  no_permission: "Você não tem permissão para esta ação.",
  email_not_verified: "Confirme seu e-mail antes de entrar. Reenviamos o link, se precisar.",
  turnstile: "Não foi possível confirmar que você não é um robô. Tente de novo.",
  social_unavailable: "Esse método de login não está disponível.",
  social_failed:
    "Não foi possível entrar com essa conta. Se ela estiver desativada, fale com um administrador.",
  rate_limit: "Muitas tentativas. Espere um pouco e tente de novo.",
  own_role: "Você não can mudar o próprio papel.",
  own_status: "Você não can desativar a própria conta.",
  confirm_name: "Digite o nome do workspace exatamente como aparece para confirmar.",
  confirm_email: "Digite seu e-mail exatamente como aparece na conta para confirmar.",
  error: "Algo deu errado. Tente de novo.",
  invalid_code: "Código incorreto. Confira o app e tente de novo.",
  code_locked: "Muitas tentativas erradas. Espere 15 minutos.",
  two_factor_active: "A verificação em duas etapas já está ativa nesta conta.",
  two_factor_required: "Contas de administrador precisam da verificação em duas etapas.",

  // sucessos
  ok_profile: "Perfil atualizado.",
  ok_password: "Senha alterada. As outras sessões foram encerradas.",
  ok_email: "Enviamos um link de confirmação para o seu e-mail atual.",
  ok_invite: "Convite enviado.",
  ok_invite_resent: "Convite reenviado.",
  ok_invite_revoked: "Convite revogado.",
  ok_role: "Papel atualizado.",
  ok_disabled: "Usuário desativado.",
  ok_enabled: "Usuário reativado.",
  ok_sessions: "Sessões revogadas.",
  ok_2fa_reset: "Verificação em duas etapas removida. A pessoa vai configurar de novo no próximo acesso.",
  no_2fa: "Esta conta não tem verificação em duas etapas ativa.",
  ok_session: "Sessão encerrada.",
  ok_reset: "Se existir uma conta com este e-mail, enviamos o link de redefinição.",
  ok_signup: "Conta criada. Confirme o e-mail para entrar.",
  ok_verification_resent: "Se o endereço precisar de confirmação, enviamos o link de novo.",
  ok_email_verified: "E-mail confirmado. Agora é só entrar.",
  ok_note: "Anotação salva.",
  ok_workspace_created: "Workspace criado. Você é o dono dele.",
  ok_workspace_renamed: "Workspace renomeado.",
  ok_workspace_deleted: "Workspace excluído.",
  ok_invite_sent: "Convite enviado.",
  ok_invite_cancelled: "Convite cancelado.",
  ok_member_role: "Papel atualizado.",
  ok_member_removed: "Membro removido.",
  ok_left: "Você saiu do workspace.",
  ok_transferred: "Propriedade transferida. Você agora é administrador.",
  ok_invite_accepted: "Convite aceito. Bem-vindo!",
  ok_account_deleted: "Sua conta foi apagada.",
  ok_2fa_enabled: "Verificação em duas etapas ativada.",
  ok_2fa_disabled: "Verificação em duas etapas desativada.",
  ok_2fa_codes: "Novos códigos de recuperação gerados. Os antigos não valem mais.",
};

export function messageFor(code: string | null): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? null;
}

/** Redireciona de volta para `path` com um código de erro. */
export function fail(path: string, code: keyof typeof MESSAGES | string, extra?: string): Response {
  const url = `${path}${path.includes("?") ? "&" : "?"}e=${encodeURIComponent(code)}${extra ?? ""}`;
  return new Response(null, { status: 303, headers: { Location: url } });
}

/** Redireciona de volta para `path` com um código de sucesso. */
export function ok(path: string, code?: keyof typeof MESSAGES | string): Response {
  const url = code ? `${path}${path.includes("?") ? "&" : "?"}ok=${encodeURIComponent(code)}` : path;
  return new Response(null, { status: 303, headers: { Location: url } });
}

export function isEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

export function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Cloudflare Turnstile. Sem `TURNSTILE_SECRET_KEY` configurada, passa direto —
 * o template roda sem exigir que você crie um widget primeiro.
 */
export async function verifyTurnstile(
  secret: string | undefined,
  token: string,
  ip: string | null,
): Promise<boolean> {
  if (!secret) return true;
  if (!token) return false;

  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  if (ip) body.set("remoteip", ip);

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

/**
 * Better Auth devolve `Response` com os cookies de sessão. Formulários HTML
 * precisam de um 303, não de JSON — então transplantamos os Set-Cookie.
 */
export function redirectWithCookies(from: Response, location: string): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of from.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

/**
 * Com `asResponse: true`, o Better Auth NÃO lança em erro — devolve um
 * `Response` 4xx com `{ code, message }` no corpo. Redirecionar sem olhar o
 * status manda a pessoa para o dashboard como se tivesse entrado, ela é
 * expulsa de volta para o login e não recebe explicação nenhuma.
 *
 * Toda chamada com `asResponse` passa por aqui.
 */
export async function handleAuthResponse(
  res: Response,
  onSuccess: string,
  onFailure: string,
  /** Reescreve o código de erro antes de redirecionar (ex.: "senha atual errada"). */
  rewrite?: (code: string) => string,
): Promise<Response> {
  if (res.ok) return redirectWithCookies(res, onSuccess);

  const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
  const code = mapAuthCode(`${body?.code ?? ""} ${body?.message ?? ""}`, res.status);
  return fail(onFailure, rewrite ? rewrite(code) : code);
}

/** Erro lançado pelo Better Auth → código de mensagem nosso. */
export function codeFromAuthError(error: unknown): string {
  const raw = `${(error as { body?: { code?: string; message?: string } })?.body?.code ?? ""} ${
    (error as { message?: string })?.message ?? ""
  }`;
  return mapAuthCode(raw, (error as { statusCode?: number })?.statusCode);
}

/** Nunca vaza detalhe interno: mapeia para as mensagens de `MESSAGES`. */
function mapAuthCode(input: string, status?: number): string {
  const raw = input.toUpperCase();
  if (status === 429) return "rate_limit";

  if (raw.includes("TOO_MANY") || raw.includes("RATE")) return "rate_limit";
  if (raw.includes("INVALID_EMAIL_OR_PASSWORD") || raw.includes("INVALID_PASSWORD")) return "credentials";
  if (raw.includes("PASSWORD_TOO_SHORT")) return "password_short";
  if (raw.includes("USER_ALREADY_EXISTS") || raw.includes("EXISTING")) return "user_exists";
  if (raw.includes("BANNED")) return "credentials";
  if (raw.includes("NOT_THE_RECIPIENT")) return "not_recipient";
  if (raw.includes("INVITATION_NOT_FOUND")) return "invite_expired";
  if (raw.includes("ALREADY_MEMBER") || raw.includes("ALREADY_EXISTS_IN_ORGANIZATION")) return "already_member";
  if (raw.includes("INVITATION_ALREADY")) return "invite_pending";
  if (raw.includes("EMAIL_NOT_VERIFIED")) return "email_not_verified";
  // Nomes vindos de TWO_FACTOR_ERROR_CODES do Better Auth.
  if (raw.includes("TEMPORARILY_LOCKED") || raw.includes("TOO_MANY_ATTEMPTS")) return "code_locked";
  if (raw.includes("ALREADY_ENABLED")) return "two_factor_active";
  if (raw.includes("INVALID_CODE") || raw.includes("INVALID_BACKUP_CODE") || raw.includes("OTP_HAS_EXPIRED")) {
    return "invalid_code";
  }
  if (raw.includes("CONVITE") || raw.includes("INVALID_TOKEN") || raw.includes("EXPIRED")) return "invalid_invite";
  if (raw.includes("EMAIL")) return "email_in_use";
  return "error";
}

/**
 * Evita open redirect: só aceita caminho relativo da própria aplicação.
 * `//evil.com` e `https://evil.com` são descartados.
 */
export function safeNext(value: string, fallback = "/dashboard"): string {
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}
