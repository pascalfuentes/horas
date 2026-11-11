/**
 * Mensagens de feedback viajam como CÓDIGO na querystring, nunca como texto
 * livre. Assim nada que o usuário digitou volta refletido na URL.
 */
export const MESSAGES: Record<string, string> = {
  // erros
  campos: "Preencha todos os campos obrigatórios.",
  credenciais: "E-mail ou senha incorretos.",
  senha_curta: "A senha precisa de pelo menos 10 caracteres.",
  senha_confirma: "As senhas não conferem.",
  senha_atual: "A senha atual está incorreta.",
  email_invalido: "Informe um e-mail válido.",
  email_em_uso: "Não foi possível usar este e-mail.",
  convite_invalido: "Convite inválido, expirado ou já utilizado.",
  convite_duplicado: "Já existe um convite pendente para este e-mail.",
  usuario_existe: "Já existe uma conta com este e-mail.",
  ultimo_admin: "Esta é a única conta de administrador ativa. Promova outra pessoa antes.",
  nao_e_destinatario:
    "Este convite é para outro e-mail. Entre com a conta do endereço que recebeu o convite.",
  convite_expirado: "Este convite expirou ou já foi usado. Peça outro.",
  ja_e_membro: "Essa pessoa já participa deste workspace.",
  convite_pendente: "Já existe um convite pendente para esse e-mail.",
  proprio_membro: "Você não pode fazer isso com a sua própria participação.",
  papel_invalido: "Papel inválido.",
  ultimo_owner:
    "Você é a única pessoa dona de um workspace que tem outros membros. Transfira a propriedade antes de apagar a conta.",
  sem_permissao: "Você não tem permissão para esta ação.",
  email_nao_verificado: "Confirme seu e-mail antes de entrar. Reenviamos o link, se precisar.",
  turnstile: "Não foi possível confirmar que você não é um robô. Tente de novo.",
  social_indisponivel: "Esse método de login não está disponível.",
  social_falhou:
    "Não foi possível entrar com essa conta. Se ela estiver desativada, fale com um administrador.",
  limite: "Muitas tentativas. Espere um pouco e tente de novo.",
  proprio_papel: "Você não pode mudar o próprio papel.",
  proprio_status: "Você não pode desativar a própria conta.",
  confirmacao_nome: "Digite o nome do workspace exatamente como aparece para confirmar.",
  confirmacao_email: "Digite seu e-mail exatamente como aparece na conta para confirmar.",
  erro: "Algo deu errado. Tente de novo.",
  codigo_invalido: "Código incorreto. Confira o app e tente de novo.",
  codigo_travado: "Muitas tentativas erradas. Espere 15 minutos.",
  dois_fatores_ativo: "A verificação em duas etapas já está ativa nesta conta.",
  dois_fatores_obrigatorio: "Contas de administrador precisam da verificação em duas etapas.",

  // sucessos
  ok_perfil: "Perfil atualizado.",
  ok_senha: "Senha alterada. As outras sessões foram encerradas.",
  ok_email: "Enviamos um link de confirmação para o seu e-mail atual.",
  ok_convite: "Convite enviado.",
  ok_convite_reenviado: "Convite reenviado.",
  ok_convite_revogado: "Convite revogado.",
  ok_papel: "Papel atualizado.",
  ok_desativado: "Usuário desativado.",
  ok_ativado: "Usuário reativado.",
  ok_sessoes: "Sessões revogadas.",
  ok_2fa_resetado: "Verificação em duas etapas removida. A pessoa vai configurar de novo no próximo acesso.",
  sem_2fa: "Esta conta não tem verificação em duas etapas ativa.",
  ok_sessao: "Sessão encerrada.",
  ok_reset: "Se existir uma conta com este e-mail, enviamos o link de redefinição.",
  ok_cadastro: "Conta criada. Confirme o e-mail para entrar.",
  ok_verificacao_reenviada: "Se o endereço precisar de confirmação, enviamos o link de novo.",
  ok_email_verificado: "E-mail confirmado. Agora é só entrar.",
  ok_nota: "Anotação salva.",
  ok_workspace_criado: "Workspace criado. Você é o dono dele.",
  ok_workspace_renomeado: "Workspace renomeado.",
  ok_workspace_excluido: "Workspace excluído.",
  ok_convite_enviado: "Convite enviado.",
  ok_convite_cancelado: "Convite cancelado.",
  ok_membro_papel: "Papel atualizado.",
  ok_membro_removido: "Membro removido.",
  ok_saiu: "Você saiu do workspace.",
  ok_transferido: "Propriedade transferida. Você agora é administrador.",
  ok_convite_aceito: "Convite aceito. Bem-vindo!",
  ok_conta_apagada: "Sua conta foi apagada.",
  ok_2fa_ativado: "Verificação em duas etapas ativada.",
  ok_2fa_desativado: "Verificação em duas etapas desativada.",
  ok_2fa_codigos: "Novos códigos de recuperação gerados. Os antigos não valem mais.",
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
  if (status === 429) return "limite";

  if (raw.includes("TOO_MANY") || raw.includes("RATE")) return "limite";
  if (raw.includes("INVALID_EMAIL_OR_PASSWORD") || raw.includes("INVALID_PASSWORD")) return "credenciais";
  if (raw.includes("PASSWORD_TOO_SHORT")) return "senha_curta";
  if (raw.includes("USER_ALREADY_EXISTS") || raw.includes("EXISTING")) return "usuario_existe";
  if (raw.includes("BANNED")) return "credenciais";
  if (raw.includes("NOT_THE_RECIPIENT")) return "nao_e_destinatario";
  if (raw.includes("INVITATION_NOT_FOUND")) return "convite_expirado";
  if (raw.includes("ALREADY_MEMBER") || raw.includes("ALREADY_EXISTS_IN_ORGANIZATION")) return "ja_e_membro";
  if (raw.includes("INVITATION_ALREADY")) return "convite_pendente";
  if (raw.includes("EMAIL_NOT_VERIFIED")) return "email_nao_verificado";
  // Nomes vindos de TWO_FACTOR_ERROR_CODES do Better Auth.
  if (raw.includes("TEMPORARILY_LOCKED") || raw.includes("TOO_MANY_ATTEMPTS")) return "codigo_travado";
  if (raw.includes("ALREADY_ENABLED")) return "dois_fatores_ativo";
  if (raw.includes("INVALID_CODE") || raw.includes("INVALID_BACKUP_CODE") || raw.includes("OTP_HAS_EXPIRED")) {
    return "codigo_invalido";
  }
  if (raw.includes("CONVITE") || raw.includes("INVALID_TOKEN") || raw.includes("EXPIRED")) return "convite_invalido";
  if (raw.includes("EMAIL")) return "email_em_uso";
  return "erro";
}

/**
 * Evita open redirect: só aceita caminho relativo da própria aplicação.
 * `//evil.com` e `https://evil.com` são descartados.
 */
export function safeNext(value: string, fallback = "/dashboard"): string {
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}
