import { canAdministerPlatform, can, type Permission } from "~/lib/permissions";

export { isLastAdminError } from "~/lib/errors";

/**
 * Autorização para handlers.
 *
 * Regra da casa: o middleware é o portão grosso (está logado? é membro deste
 * workspace?), e CADA handler que escreve ainda chama o guard com a permissão
 * exata. Esconder o botão na interface não é autorização; barrar o método no
 * servidor é.
 *
 * São três guards porque são três perguntas diferentes.
 */

/**
 * Rotas da PRÓPRIA CONTA: nome, senha, e-mail, sessões, 2FA, exportar, apagar.
 *
 * Basta estar autenticado. Toda pessoa mexe na própria conta, qualquer que seja
 * o papel dela em qualquer workspace — inclusive quem é só `viewer`. "Somente
 * leitura" vale para os dados de negócio, não para a própria senha.
 */
export function denyAccount(locals: App.Locals): Response | null {
  if (!locals.user) return new Response("Não autenticado", { status: 401 });
  return null;
}

/**
 * Rotas DENTRO DE UM WORKSPACE.
 *
 * Exige membership — que o middleware já resolveu a partir do slug na URL. Sem
 * workspace no contexto, nega: uma rota de workspace sem workspace resolvido é
 * um erro de programação, e o lado seguro de errar é fechado.
 */
export function deny(locals: App.Locals, permission: Permission): Response | null {
  if (!locals.user) return new Response("Não autenticado", { status: 401 });
  if (!locals.membership) return new Response("Workspace não encontrado", { status: 404 });
  if (!can(locals.membership.role, permission)) {
    return new Response("Sem permissão", { status: 403 });
  }
  return null;
}

/**
 * Área de administração da PLATAFORMA.
 *
 * Ser superadmin não dá passe livre dentro de workspace alheio: para agir num
 * workspace é preciso ser membro dele, como qualquer pessoa.
 */
export function denyPlatform(locals: App.Locals): Response | null {
  if (!locals.user) return new Response("Não autenticado", { status: 401 });
  if (!canAdministerPlatform(locals.user.role)) {
    return new Response("Sem permissão", { status: 403 });
  }
  return null;
}

/** O usuário logado, tipado como não-nulo. Só use depois de um guard. */
export function actor(locals: App.Locals): { id: string; email: string; role: string } {
  const u = locals.user!;
  return { id: u.id, email: u.email, role: String(u.role ?? "user") };
}

/** O workspace do contexto, tipado como não-nulo. Só use depois de `deny()`. */
export function currentWorkspace(locals: App.Locals) {
  return locals.membership!;
}
