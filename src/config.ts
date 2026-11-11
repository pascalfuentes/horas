/**
 * Configuração da aplicação que fica NO CÓDIGO (não é segredo, não muda entre
 * ambientes). Ids de infraestrutura ficam em `wrangler.local.jsonc`; chaves
 * ficam em secrets do Worker.
 *
 * `npm run new-project` reescreve o APP_NAME daqui.
 */

/** Aparece na barra superior e no nome do app dentro do Better Auth. */
export const APP_NAME = "Horas";

/** Quanto tempo um convite vale antes de expirar. */
export const INVITE_TTL_DAYS = 7;

/**
 * Quem responde pelos dados na política de privacidade.
 *
 * Vem de `vars` no wrangler (wrangler.local.jsonc neste deploy), e não daqui,
 * pelo mesmo motivo dos ids: o repositório do template não deve carregar o
 * e-mail pessoal de ninguém. Os valores abaixo são só o fallback.
 */
export function operator(env: { OPERATOR_NAME?: string; OPERATOR_CONTACT?: string }) {
  return {
    nome: env.OPERATOR_NAME || APP_NAME,
    contato: env.OPERATOR_CONTACT || "contato@exemplo.com",
  };
}

/**
 * Exige 2FA de quem é administrador.
 *
 * Não tranca ninguém para fora: um admin sem 2FA entra normalmente e é levado
 * para a tela de configuração, onde fica até ativar. É bloqueio de navegação,
 * não de acesso.
 *
 * Ligado por padrão porque a conta de administrador convida gente e muda
 * papéis — quem entra nela se convida de volta quantas vezes quiser.
 */
export const REQUIRE_2FA_FOR_ADMINS = true;
