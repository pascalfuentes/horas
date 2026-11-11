import { WORKSPACE_ROLES, type WorkspaceRole } from "~/db/schema";

/**
 * Matriz papel × permissão DENTRO DE UM WORKSPACE.
 *
 * A regra é declarada UMA vez aqui e checada no servidor em cada handler que
 * escreve. Esconder botão na interface não é autorização — a UI usa `pode()` só
 * para não mostrar ação que vai falhar de qualquer jeito.
 *
 * Não confunda com o papel de PLATAFORMA (`user.role`), que responde outra
 * pergunta: quem opera a instalação. Ver `podeAdministrarPlataforma()`.
 */
export const PERMISSIONS = {
  /** Ler os dados de negócio do workspace. */
  CONTENT_READ: "content:read",
  /** Criar, editar e apagar dados de negócio do workspace. */
  CONTENT_WRITE: "content:write",

  /** Ver a lista de membros e os convites pendentes. */
  MEMBERS_READ: "members:read",
  /** Convidar, trocar papel, remover membro. */
  MEMBERS_WRITE: "members:write",

  /** Ver as configurações do workspace. */
  WORKSPACE_READ: "workspace:read",
  /** Renomear, trocar slug, e futuramente conectar integrações. */
  WORKSPACE_WRITE: "workspace:write",
  /** Excluir o workspace inteiro. */
  WORKSPACE_DELETE: "workspace:delete",
  /** Passar a propriedade para outra pessoa. */
  WORKSPACE_TRANSFER: "workspace:transfer",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * Repare no que NÃO está aqui: mexer na própria conta.
 *
 * A conta existe fora de qualquer workspace — a mesma pessoa pode ser `owner`
 * num e `viewer` noutro, e a senha é uma só. Guardar isso por papel de
 * workspace misturaria duas perguntas diferentes. Quem cuida disso é
 * `denyConta()` em `src/lib/guards.ts`.
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

export function ehPapelDeWorkspace(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/** A pessoa, com este papel no workspace, pode fazer isto? */
export function pode(role: unknown, permission: Permission): boolean {
  if (!ehPapelDeWorkspace(role)) return false;
  return MATRIX[role].includes(permission);
}

/**
 * Superadmin da plataforma — outra pergunta, outra resposta.
 *
 * Não dá passe livre em workspace nenhum: para agir dentro de um workspace,
 * precisa ser membro dele como qualquer pessoa. O que isto libera é só a área
 * de administração da INSTALAÇÃO.
 */
export function podeAdministrarPlataforma(platformRole: unknown): boolean {
  return platformRole === "admin";
}

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Dono",
  admin: "Administrador",
  editor: "Editor",
  viewer: "Leitor",
};

/** Papel de plataforma — outro eixo, outros rótulos. */
export const PLATFORM_ROLE_LABELS: Record<string, string> = {
  admin: "Superadmin da plataforma",
  user: "Usuário",
};

export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  owner: "Tudo, incluindo excluir o workspace e transferir a propriedade.",
  admin: "Gerencia membros, convites e configurações. Não exclui o workspace.",
  editor: "Cria e edita conteúdo. Não mexe em membros.",
  viewer: "Só leitura do conteúdo.",
};
