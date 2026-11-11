/**
 * Núcleo do controle de tempo: todas as operações de negócio em cima do D1.
 *
 * A API da web, a API por token e o servidor MCP usam SÓ o que `createStore`
 * devolve. O store nasce amarrado a um workspace e a uma pessoa, e toda query
 * filtra pelos dois — não existe função aqui que aceite outro dono por
 * parâmetro.
 */

const COLORS = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16"];

export const DEFAULT_TZ = "America/Sao_Paulo";

/** Erro com status HTTP, usado para respostas 400/404/409. */
export class HorasError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type Projeto = {
  id: number;
  name: string;
  client: string;
  color: string;
  archived: boolean;
  total_seconds: number;
};

export type Entrada = {
  id: number;
  description: string;
  project_id: number | null;
  project: string | null;
  project_color: string | null;
  client: string | null;
  tags: string[];
  billable: boolean;
  start: string;
  end: string | null;
  running: boolean;
  duration_seconds: number;
};

export type EntradaInput = {
  description?: string;
  project?: string | null;
  project_id?: number | string | null;
  tags?: string[] | string;
  billable?: boolean;
  start?: string;
  end?: string;
  duration_minutes?: number | null;
};

export type Filtro = {
  from?: string | null;
  to?: string | null;
  project?: string | null;
  project_id?: number | string | null;
  q?: string | null;
  limit?: number;
};

/* ---------- Datas e fuso ---------- */

/** O fuso é um nome IANA que este runtime conhece? */
export function tzValido(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Diferença (ms) entre o horário de parede no fuso e o UTC, naquele instante. */
function tzOffset(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(ms));
  const v: Record<string, number> = {};
  for (const p of parts) v[p.type] = Number(p.value);
  return Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second) - Math.floor(ms / 1000) * 1000;
}

/** Horário de parede no fuso -> instante UTC em ms. `m` é 1-12. */
function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, h, mi, s);
  const guess = wall - tzOffset(wall, tz);
  return wall - tzOffset(guess, tz);
}

/** Dia (YYYY-MM-DD) de um instante, visto no fuso. */
function localDay(when: string | number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(when));
}

/**
 * Normaliza uma data para ISO UTC. Datas sem offset ("2026-11-11T09:00") são
 * lidas no fuso da pessoa — é assim que uma IA costuma mandar "hoje às 9h".
 */
function toIso(value: unknown, field: string, tz: string): string {
  if (typeof value === "string") {
    const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/);
    if (m) return new Date(zonedToUtc(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), tz)).toISOString();
  }
  const d = new Date(value as string);
  if (value === null || value === undefined || value === "" || Number.isNaN(d.getTime())) {
    throw new HorasError(`Data inválida em "${field}": ${String(value)}`);
  }
  return d.toISOString();
}

/** Limite de período em ISO. "YYYY-MM-DD" no fim do período inclui o dia inteiro. */
function rangeBound(value: string, isEnd: boolean, tz: string): string {
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(zonedToUtc(+m[1], +m[2], +m[3] + (isEnd ? 1 : 0), 0, 0, 0, tz)).toISOString();
  return toIso(value, isEnd ? "to" : "from", tz);
}

/* ---------- Formatação ---------- */

function tagsJson(tags: unknown): string {
  const list = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : [];
  const limpas = [...new Set(list.map((t) => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
  return JSON.stringify(limpas);
}

const texto = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

const corValida = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);

type LinhaEntrada = {
  id: number;
  description: string;
  projectId: number | null;
  tags: string;
  billable: number;
  start: string;
  end: string | null;
  project_name: string | null;
  project_color: string | null;
  project_client: string | null;
};

function shapeEntry(row: LinhaEntrada | null): Entrada | null {
  if (!row) return null;
  const endMs = row.end ? Date.parse(row.end) : Date.now();
  return {
    id: row.id,
    description: row.description,
    project_id: row.projectId,
    project: row.project_name ?? null,
    project_color: row.project_color ?? null,
    client: row.project_client ?? null,
    tags: JSON.parse(row.tags) as string[],
    billable: !!row.billable,
    start: row.start,
    end: row.end,
    running: !row.end,
    duration_seconds: Math.max(0, Math.round((endMs - Date.parse(row.start)) / 1000)),
  };
}

const ENTRY_SELECT = `
  SELECT e.*, p."name" AS project_name, p."color" AS project_color, p."client" AS project_client
  FROM "time_entry" e LEFT JOIN "time_project" p ON p."id" = e."projectId"`;

export type Store = ReturnType<typeof createStore>;

/**
 * Operações de tempo de UMA pessoa em UM workspace.
 * `tz` define "hoje"/"esta semana" e como ler datas sem offset.
 */
export function createStore(db: D1Database, ctx: { workspaceId: string; userId: string; tz?: string }) {
  const { workspaceId: ws, userId: uid } = ctx;
  const tz = tzValido(ctx.tz) ? ctx.tz : DEFAULT_TZ;

  const all = async <T>(sql: string, ...args: unknown[]) => (await db.prepare(sql).bind(...args).all<T>()).results ?? [];
  const first = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).first<T>();
  const run = async (sql: string, ...args: unknown[]) => (await db.prepare(sql).bind(...args).run()).meta;
  const nowIso = () => new Date().toISOString();

  /* ----- Projetos (do workspace; os totais são só das horas desta pessoa) ----- */

  async function listProjects({ includeArchived = false }: { includeArchived?: boolean } = {}): Promise<Projeto[]> {
    const rows = await all<{ id: number; name: string; client: string; color: string; archived: number; total: number }>(
      `SELECT p.*, COALESCE(SUM((julianday(COALESCE(e."end", 'now')) - julianday(e."start")) * 86400), 0) AS total
         FROM "time_project" p
         LEFT JOIN "time_entry" e ON e."projectId" = p."id" AND e."userId" = ?2
        WHERE p."workspaceId" = ?1 ${includeArchived ? "" : 'AND p."archived" = 0'}
        GROUP BY p."id" ORDER BY p."archived", p."name"`,
      ws,
      uid,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      client: r.client,
      color: r.color,
      archived: !!r.archived,
      total_seconds: Math.round(r.total),
    }));
  }

  async function getProject(id: number | string): Promise<Projeto> {
    const p = (await listProjects({ includeArchived: true })).find((x) => x.id === Number(id));
    if (!p) throw new HorasError(`Projeto ${id} não encontrado.`, 404);
    return p;
  }

  async function createProject(input: { name?: string; client?: string; color?: string } = {}): Promise<Projeto> {
    const name = texto(input.name, 80);
    if (!name) throw new HorasError("O projeto precisa de um nome.");
    if (await first('SELECT 1 AS x FROM "time_project" WHERE "workspaceId" = ?1 AND "name" = ?2', ws, name)) {
      throw new HorasError(`Já existe um projeto chamado "${name}".`, 409);
    }
    const total = await first<{ n: number }>('SELECT COUNT(*) AS n FROM "time_project" WHERE "workspaceId" = ?1', ws);
    if ((total?.n ?? 0) >= 500) throw new HorasError("Limite de 500 projetos por workspace.");
    const meta = await run(
      'INSERT INTO "time_project" ("workspaceId", "name", "client", "color", "createdAt") VALUES (?1, ?2, ?3, ?4, ?5)',
      ws,
      name,
      texto(input.client, 80),
      corValida(input.color) ? input.color : COLORS[(total?.n ?? 0) % COLORS.length],
      nowIso(),
    );
    return getProject(meta.last_row_id);
  }

  async function updateProject(
    id: number | string,
    patch: { name?: string; client?: string; color?: string; archived?: boolean } = {},
  ): Promise<Projeto> {
    const cur = await getProject(id);
    const name = patch.name !== undefined ? texto(patch.name, 80) : cur.name;
    if (!name) throw new HorasError("O projeto precisa de um nome.");
    if (await first('SELECT 1 AS x FROM "time_project" WHERE "workspaceId" = ?1 AND "name" = ?2 AND "id" != ?3', ws, name, cur.id)) {
      throw new HorasError(`Já existe um projeto chamado "${name}".`, 409);
    }
    await run(
      'UPDATE "time_project" SET "name" = ?1, "client" = ?2, "color" = ?3, "archived" = ?4 WHERE "id" = ?5 AND "workspaceId" = ?6',
      name,
      patch.client !== undefined ? texto(patch.client, 80) : cur.client,
      corValida(patch.color) ? patch.color : cur.color,
      (patch.archived !== undefined ? patch.archived : cur.archived) ? 1 : 0,
      cur.id,
      ws,
    );
    return getProject(cur.id);
  }

  /** Apaga o projeto. As entradas (de todos os membros) continuam, sem projeto. */
  async function deleteProject(id: number | string): Promise<{ deleted: true; id: number }> {
    const cur = await getProject(id);
    await run('UPDATE "time_entry" SET "projectId" = NULL WHERE "projectId" = ?1 AND "workspaceId" = ?2', cur.id, ws);
    await run('DELETE FROM "time_project" WHERE "id" = ?1 AND "workspaceId" = ?2', cur.id, ws);
    return { deleted: true, id: cur.id };
  }

  /**
   * Resolve um projeto por id ou nome. Nome desconhecido cria o projeto —
   * é o que deixa uma IA dizer "comece um timer no projeto X" sem preparo.
   * Devolve `undefined` quando nada foi informado (= não mexer).
   */
  async function resolveProject(ref: { project_id?: number | string | null; project?: string | null }): Promise<number | null | undefined> {
    if (ref.project_id !== undefined) {
      if (ref.project_id === null || ref.project_id === "" || Number(ref.project_id) === 0) return null;
      return (await getProject(ref.project_id)).id;
    }
    if (ref.project === undefined) return undefined;
    const name = texto(ref.project, 80);
    if (!name) return null;
    const row = await first<{ id: number }>('SELECT "id" FROM "time_project" WHERE "workspaceId" = ?1 AND "name" = ?2', ws, name);
    return row ? row.id : (await createProject({ name })).id;
  }

  /* ----- Entradas ----- */

  async function getEntry(id: number | string): Promise<Entrada> {
    const row = await first<LinhaEntrada>(`${ENTRY_SELECT} WHERE e."id" = ?1 AND e."workspaceId" = ?2 AND e."userId" = ?3`, Number(id), ws, uid);
    if (!row) throw new HorasError(`Entrada ${id} não encontrada.`, 404);
    return shapeEntry(row)!;
  }

  /** Timer rodando agora, se houver. */
  async function getRunning(): Promise<Entrada | null> {
    return shapeEntry(
      await first<LinhaEntrada>(`${ENTRY_SELECT} WHERE e."workspaceId" = ?1 AND e."userId" = ?2 AND e."end" IS NULL LIMIT 1`, ws, uid),
    );
  }

  /** Para o timer que está rodando. Devolve null se não havia nenhum. */
  async function stopTimer({ end }: { end?: string } = {}): Promise<Entrada | null> {
    const running = await getRunning();
    if (!running) return null;
    const endIso = end ? toIso(end, "end", tz) : nowIso();
    if (endIso < running.start) throw new HorasError("O fim não pode ser antes do início.");
    await run('UPDATE "time_entry" SET "end" = ?1 WHERE "id" = ?2 AND "end" IS NULL', endIso, running.id);
    return getEntry(running.id);
  }

  /** Inicia um timer. Se já houver um rodando, ele é parado antes. */
  async function startTimer(input: EntradaInput = {}): Promise<{ entry: Entrada; stopped: Entrada | null }> {
    const start = input.start ? toIso(input.start, "start", tz) : nowIso();
    if (Date.parse(start) > Date.now() + 60000) throw new HorasError("Um timer não pode começar no futuro.");
    const projectId = (await resolveProject(input)) ?? null;
    const running = await getRunning();
    const stopped = running ? await stopTimer({ end: start > running.start ? start : undefined }) : null;
    const meta = await run(
      `INSERT INTO "time_entry" ("workspaceId", "userId", "description", "projectId", "tags", "billable", "start", "createdAt")
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ws,
      uid,
      texto(input.description, 500),
      projectId,
      tagsJson(input.tags),
      input.billable ? 1 : 0,
      start,
      nowIso(),
    );
    return { entry: await getEntry(meta.last_row_id), stopped };
  }

  /**
   * Cria uma entrada já fechada (lançamento manual).
   * Aceita start+end, start+duration_minutes, end+duration_minutes ou só
   * duration_minutes (termina agora).
   */
  async function createEntry(input: EntradaInput = {}): Promise<Entrada> {
    const mins = input.duration_minutes !== undefined && input.duration_minutes !== null ? Number(input.duration_minutes) : null;
    if (mins !== null && !(mins > 0)) throw new HorasError("duration_minutes precisa ser maior que zero.");
    let start = input.start ? toIso(input.start, "start", tz) : null;
    let end = input.end ? toIso(input.end, "end", tz) : null;
    if (start && !end && mins) end = new Date(Date.parse(start) + mins * 60000).toISOString();
    if (!start && mins) {
      end = end || nowIso();
      start = new Date(Date.parse(end) - mins * 60000).toISOString();
    }
    if (!start || !end) throw new HorasError("Informe start e end, ou duration_minutes.");
    if (end <= start) throw new HorasError("O fim precisa ser depois do início.");
    const meta = await run(
      `INSERT INTO "time_entry" ("workspaceId", "userId", "description", "projectId", "tags", "billable", "start", "end", "createdAt")
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ws,
      uid,
      texto(input.description, 500),
      (await resolveProject(input)) ?? null,
      tagsJson(input.tags),
      input.billable ? 1 : 0,
      start,
      end,
      nowIso(),
    );
    return getEntry(meta.last_row_id);
  }

  async function updateEntry(id: number | string, patch: EntradaInput = {}): Promise<Entrada> {
    const cur = await getEntry(id);
    const start = patch.start ? toIso(patch.start, "start", tz) : cur.start;
    let end = patch.end ? toIso(patch.end, "end", tz) : cur.end;
    if (patch.duration_minutes !== undefined && patch.duration_minutes !== null) {
      const mins = Number(patch.duration_minutes);
      if (!(mins > 0)) throw new HorasError("duration_minutes precisa ser maior que zero.");
      end = new Date(Date.parse(start) + mins * 60000).toISOString();
    }
    if (end && end <= start) throw new HorasError("O fim precisa ser depois do início.");
    if (!end && Date.parse(start) > Date.now() + 60000) throw new HorasError("Um timer rodando não pode começar no futuro.");
    const projectId = await resolveProject(patch);
    await run(
      `UPDATE "time_entry" SET "description" = ?1, "projectId" = ?2, "tags" = ?3, "billable" = ?4, "start" = ?5, "end" = ?6
        WHERE "id" = ?7 AND "workspaceId" = ?8 AND "userId" = ?9`,
      patch.description !== undefined ? texto(patch.description, 500) : cur.description,
      projectId === undefined ? cur.project_id : projectId,
      patch.tags !== undefined ? tagsJson(patch.tags) : JSON.stringify(cur.tags),
      (patch.billable !== undefined ? patch.billable : cur.billable) ? 1 : 0,
      start,
      end,
      cur.id,
      ws,
      uid,
    );
    return getEntry(cur.id);
  }

  async function deleteEntry(id: number | string): Promise<{ deleted: true; id: number }> {
    const cur = await getEntry(id);
    await run('DELETE FROM "time_entry" WHERE "id" = ?1 AND "workspaceId" = ?2 AND "userId" = ?3', cur.id, ws, uid);
    return { deleted: true, id: cur.id };
  }

  /** Lista entradas, mais recentes primeiro. */
  async function listEntries({ from, to, project, project_id, q, limit = 500 }: Filtro = {}): Promise<Entrada[]> {
    const where = ['e."workspaceId" = ?', 'e."userId" = ?'];
    const args: unknown[] = [ws, uid];
    if (from) where.push('e."start" >= ?'), args.push(rangeBound(from, false, tz));
    if (to) where.push('e."start" < ?'), args.push(rangeBound(to, true, tz));
    if (project_id !== undefined && project_id !== null && project_id !== "") {
      if (Number(project_id) === 0) where.push('e."projectId" IS NULL');
      else where.push('e."projectId" = ?'), args.push(Number(project_id));
    } else if (project) {
      where.push('p."name" = ?'), args.push(String(project).trim());
    }
    if (q) {
      const termo = `%${String(q).slice(0, 100).replace(/[\\%_]/g, "\\$&")}%`;
      where.push(`(e."description" LIKE ? ESCAPE '\\' OR e."tags" LIKE ? ESCAPE '\\')`), args.push(termo, termo);
    }
    const max = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    const rows = await all<LinhaEntrada>(`${ENTRY_SELECT} WHERE ${where.join(" AND ")} ORDER BY e."start" DESC LIMIT ?`, ...args, max);
    return rows.map((r) => shapeEntry(r)!);
  }

  /** Relatório agregado de um período. */
  async function summary(filter: Filtro = {}) {
    const entries = await listEntries({ ...filter, limit: 5000 });
    const byProject = new Map<number, { project_id: number | null; project: string; color: string; seconds: number; entries: number }>();
    const byDay = new Map<string, number>();
    const byDesc = new Map<string, { description: string; project: string | null; seconds: number; entries: number }>();
    let total = 0;
    let billable = 0;
    for (const e of entries) {
      const s = e.duration_seconds;
      total += s;
      if (e.billable) billable += s;
      const pk = e.project_id ?? 0;
      const p = byProject.get(pk) ?? { project_id: e.project_id, project: e.project ?? "(sem projeto)", color: e.project_color ?? "#9ca3af", seconds: 0, entries: 0 };
      p.seconds += s;
      p.entries += 1;
      byProject.set(pk, p);
      const day = localDay(e.start, tz);
      byDay.set(day, (byDay.get(day) ?? 0) + s);
      const dk = `${pk}|${e.description}`;
      const d = byDesc.get(dk) ?? { description: e.description || "(sem descrição)", project: e.project ?? null, seconds: 0, entries: 0 };
      d.seconds += s;
      d.entries += 1;
      byDesc.set(dk, d);
    }
    const hours = <T extends { seconds: number }>(x: T) => ({ ...x, hours: Math.round((x.seconds / 3600) * 100) / 100 });
    return {
      from: filter.from ?? null,
      to: filter.to ?? null,
      timezone: tz,
      total_seconds: total,
      total_hours: Math.round((total / 3600) * 100) / 100,
      billable_seconds: billable,
      entries: entries.length,
      by_project: [...byProject.values()].sort((a, b) => b.seconds - a.seconds).map(hours),
      by_day: [...byDay.entries()].sort().map(([day, seconds]) => hours({ day, seconds })),
      by_description: [...byDesc.values()].sort((a, b) => b.seconds - a.seconds).map(hours),
    };
  }

  /** Situação atual: timer rodando e totais de hoje e da semana (segunda a domingo). */
  async function status() {
    const today = localDay(Date.now(), tz);
    const [y, m, d] = today.split("-").map(Number);
    const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    const monday = new Date(Date.UTC(y, m - 1, d - weekday)).toISOString().slice(0, 10);
    const week = await summary({ from: monday });
    return {
      now: nowIso(),
      timezone: tz,
      today,
      running: await getRunning(),
      today_seconds: week.by_day.find((x) => x.day === today)?.seconds ?? 0,
      week_seconds: week.total_seconds,
    };
  }

  return {
    tz,
    listProjects,
    getProject,
    createProject,
    updateProject,
    deleteProject,
    getEntry,
    getRunning,
    startTimer,
    stopTimer,
    createEntry,
    updateEntry,
    deleteEntry,
    listEntries,
    summary,
    status,
  };
}
