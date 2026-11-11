/**
 * Núcleo do controle de tempo: todas as operações de negócio em cima do D1.
 *
 * A API da web, a API por token e o servidor MCP usam SÓ o que `createStore`
 * devolve. O store nasce amarrado a um workspace e a uma pessoa, e toda query
 * filtra pelos dois — não existe função aqui que aceite outro dono por
 * parâmetro.
 */

// Cores de projeto do design system (project/sky, coral, sun, mint, violet, rose).
const COLORS = ["#5dcdf1", "#fd976d", "#fdd46b", "#4cc98c", "#9b8afb", "#f0705f"];

export const DEFAULT_TZ = "America/Sao_Paulo";

/** Erro com status HTTP, usado para respostas 400/404/409. */
export class HorasError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type Project = {
  id: number;
  name: string;
  client: string;
  color: string;
  archived: boolean;
  /** Valor por hora. null = usa o padrão do workspace. */
  hourly_rate: number | null;
  total_seconds: number;
};

export type Settings = {
  /** Código ISO 4217, só para formatação. */
  currency: string;
  /** Valor por hora dos projetos que não têm o seu. */
  default_rate: number;
};

export type Entry = {
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
  /** Valor do lançamento na moeda do workspace. Zero quando não é faturável. */
  amount: number;
};

export type EntryInput = {
  description?: string;
  project?: string | null;
  project_id?: number | string | null;
  tags?: string[] | string;
  billable?: boolean;
  start?: string;
  end?: string;
  duration_minutes?: number | null;
};

export type Filter = {
  from?: string | null;
  to?: string | null;
  project?: string | null;
  project_id?: number | string | null;
  q?: string | null;
  /** Só faturáveis (true) ou só não faturáveis (false). */
  billable?: boolean | string | null;
  /** Só lançamentos com esta tag (exata, sem diferenciar maiúsculas). */
  tag?: string | null;
  /** Só projetos deste cliente. */
  client?: string | null;
  limit?: number;
};

/* ---------- Datas e fuso ---------- */

/** O fuso é um nome IANA que este runtime conhece? */
export function isValidTz(tz: unknown): tz is string {
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

const centavos = (n: number) => Math.round(n * 100) / 100;

/** Escapa os curingas do LIKE; usar com `ESCAPE '\\'`. */
const escaparLike = (v: string) => v.replace(/[\\%_]/g, "\\$&");

/** undefined = não mexer; null = limpar; número >= 0 = gravar. */
function lerTaxa(v: unknown, campo: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new HorasError(`${campo} precisa ser um número entre 0 e 1.000.000.`);
  return centavos(n);
}

function lerBooleano(v: unknown): boolean | null {
  if (v === true || v === "1" || v === "true") return true;
  if (v === false || v === "0" || v === "false") return false;
  return null;
}

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
  project_rate: number | null;
};

function shapeEntry(row: LinhaEntrada | null, taxaPadrao: number): Entry | null {
  if (!row) return null;
  const endMs = row.end ? Date.parse(row.end) : Date.now();
  const segundos = Math.max(0, Math.round((endMs - Date.parse(row.start)) / 1000));
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
    duration_seconds: segundos,
    amount: row.billable ? centavos((segundos / 3600) * (row.project_rate ?? taxaPadrao)) : 0,
  };
}

const ENTRY_SELECT = `
  SELECT e.*, p."name" AS project_name, p."color" AS project_color, p."client" AS project_client, p."hourlyRate" AS project_rate
  FROM "time_entry" e LEFT JOIN "time_project" p ON p."id" = e."projectId"`;

export type Store = ReturnType<typeof createStore>;

/**
 * Operações de tempo de UMA pessoa em UM workspace.
 * `tz` define "hoje"/"esta semana" e como ler datas sem offset.
 */
export function createStore(db: D1Database, ctx: { workspaceId: string; userId: string; tz?: string }) {
  const { workspaceId: ws, userId: uid } = ctx;
  const tz = isValidTz(ctx.tz) ? ctx.tz : DEFAULT_TZ;

  const all = async <T>(sql: string, ...args: unknown[]) => (await db.prepare(sql).bind(...args).all<T>()).results ?? [];
  const first = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).first<T>();
  const run = async (sql: string, ...args: unknown[]) => (await db.prepare(sql).bind(...args).run()).meta;
  const nowIso = () => new Date().toISOString();

  /* ----- Settings do workspace (moeda e taxa padrão) ----- */

  // Lidos uma vez por requisição: todo lançamento precisa da taxa padrão para
  // calcular o valor, e o store vive só o tempo de uma requisição.
  let ajustesEmCache: Promise<Settings> | null = null;

  function getSettings(): Promise<Settings> {
    ajustesEmCache ??= first<{ currency: string; defaultRate: number }>(
      'SELECT "currency", "defaultRate" FROM "time_settings" WHERE "workspaceId" = ?1',
      ws,
    ).then((r) => ({ currency: r?.currency ?? "BRL", default_rate: r?.defaultRate ?? 0 }));
    return ajustesEmCache;
  }

  async function updateSettings(patch: { currency?: unknown; default_rate?: unknown } = {}): Promise<Settings> {
    const atual = await getSettings();
    let currency = atual.currency;
    if (patch.currency !== undefined) {
      currency = String(patch.currency).trim().toUpperCase();
      try {
        new Intl.NumberFormat("en", { style: "currency", currency });
      } catch {
        throw new HorasError(`Moeda inválida: ${String(patch.currency)}. Use um código como BRL, USD ou EUR.`);
      }
    }
    const taxa = lerTaxa(patch.default_rate, "default_rate");
    await run(
      `INSERT INTO "time_settings" ("workspaceId", "currency", "defaultRate") VALUES (?1, ?2, ?3)
       ON CONFLICT ("workspaceId") DO UPDATE SET "currency" = ?2, "defaultRate" = ?3`,
      ws,
      currency,
      taxa === undefined ? atual.default_rate : (taxa ?? 0),
    );
    ajustesEmCache = null;
    return getSettings();
  }

  const taxaPadrao = async () => (await getSettings()).default_rate;

  /* ----- Projetos (do workspace; os totais são só das horas desta pessoa) ----- */

  async function listProjects({ includeArchived = false }: { includeArchived?: boolean } = {}): Promise<Project[]> {
    const rows = await all<{ id: number; name: string; client: string; color: string; archived: number; hourlyRate: number | null; total: number }>(
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
      hourly_rate: r.hourlyRate,
      total_seconds: Math.round(r.total),
    }));
  }

  async function getProject(id: number | string): Promise<Project> {
    const p = (await listProjects({ includeArchived: true })).find((x) => x.id === Number(id));
    if (!p) throw new HorasError(`Project ${id} não encontrado.`, 404);
    return p;
  }

  async function createProject(input: { name?: string; client?: string; color?: string; hourly_rate?: unknown } = {}): Promise<Project> {
    const name = texto(input.name, 80);
    if (!name) throw new HorasError("O projeto precisa de um nome.");
    if (await first('SELECT 1 AS x FROM "time_project" WHERE "workspaceId" = ?1 AND "name" = ?2', ws, name)) {
      throw new HorasError(`Já existe um projeto chamado "${name}".`, 409);
    }
    const total = await first<{ n: number }>('SELECT COUNT(*) AS n FROM "time_project" WHERE "workspaceId" = ?1', ws);
    if ((total?.n ?? 0) >= 500) throw new HorasError("Limite de 500 projetos por workspace.");
    const meta = await run(
      'INSERT INTO "time_project" ("workspaceId", "name", "client", "color", "createdAt", "hourlyRate") VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      ws,
      name,
      texto(input.client, 80),
      corValida(input.color) ? input.color : COLORS[(total?.n ?? 0) % COLORS.length],
      nowIso(),
      lerTaxa(input.hourly_rate, "hourly_rate") ?? null,
    );
    return getProject(meta.last_row_id);
  }

  async function updateProject(
    id: number | string,
    patch: { name?: string; client?: string; color?: string; archived?: boolean; hourly_rate?: unknown } = {},
  ): Promise<Project> {
    const cur = await getProject(id);
    const name = patch.name !== undefined ? texto(patch.name, 80) : cur.name;
    if (!name) throw new HorasError("O projeto precisa de um nome.");
    if (await first('SELECT 1 AS x FROM "time_project" WHERE "workspaceId" = ?1 AND "name" = ?2 AND "id" != ?3', ws, name, cur.id)) {
      throw new HorasError(`Já existe um projeto chamado "${name}".`, 409);
    }
    const taxa = lerTaxa(patch.hourly_rate, "hourly_rate");
    await run(
      'UPDATE "time_project" SET "name" = ?1, "client" = ?2, "color" = ?3, "archived" = ?4, "hourlyRate" = ?7 WHERE "id" = ?5 AND "workspaceId" = ?6',
      name,
      patch.client !== undefined ? texto(patch.client, 80) : cur.client,
      corValida(patch.color) ? patch.color : cur.color,
      (patch.archived !== undefined ? patch.archived : cur.archived) ? 1 : 0,
      cur.id,
      ws,
      taxa === undefined ? cur.hourly_rate : taxa,
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

  async function getEntry(id: number | string): Promise<Entry> {
    const row = await first<LinhaEntrada>(`${ENTRY_SELECT} WHERE e."id" = ?1 AND e."workspaceId" = ?2 AND e."userId" = ?3`, Number(id), ws, uid);
    if (!row) throw new HorasError(`Entry ${id} não encontrada.`, 404);
    return shapeEntry(row, await taxaPadrao())!;
  }

  /** Timer rodando agora, se houver. */
  async function getRunning(): Promise<Entry | null> {
    return shapeEntry(
      await first<LinhaEntrada>(`${ENTRY_SELECT} WHERE e."workspaceId" = ?1 AND e."userId" = ?2 AND e."end" IS NULL LIMIT 1`, ws, uid),
      await taxaPadrao(),
    );
  }

  /** Para o timer que está rodando. Devolve null se não havia nenhum. */
  async function stopTimer({ end }: { end?: string } = {}): Promise<Entry | null> {
    const running = await getRunning();
    if (!running) return null;
    const endIso = end ? toIso(end, "end", tz) : nowIso();
    if (endIso < running.start) throw new HorasError("O fim não can ser antes do início.");
    await run('UPDATE "time_entry" SET "end" = ?1 WHERE "id" = ?2 AND "end" IS NULL', endIso, running.id);
    return getEntry(running.id);
  }

  /** Inicia um timer. Se já houver um rodando, ele é parado antes. */
  async function startTimer(input: EntryInput = {}): Promise<{ entry: Entry; stopped: Entry | null }> {
    const start = input.start ? toIso(input.start, "start", tz) : nowIso();
    if (Date.parse(start) > Date.now() + 60000) throw new HorasError("Um timer não can começar no futuro.");
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
  async function createEntry(input: EntryInput = {}): Promise<Entry> {
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

  async function updateEntry(id: number | string, patch: EntryInput = {}): Promise<Entry> {
    const cur = await getEntry(id);
    const start = patch.start ? toIso(patch.start, "start", tz) : cur.start;
    let end = patch.end ? toIso(patch.end, "end", tz) : cur.end;
    if (patch.duration_minutes !== undefined && patch.duration_minutes !== null) {
      const mins = Number(patch.duration_minutes);
      if (!(mins > 0)) throw new HorasError("duration_minutes precisa ser maior que zero.");
      end = new Date(Date.parse(start) + mins * 60000).toISOString();
    }
    if (end && end <= start) throw new HorasError("O fim precisa ser depois do início.");
    if (!end && Date.parse(start) > Date.now() + 60000) throw new HorasError("Um timer rodando não can começar no futuro.");
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
  async function listEntries({ from, to, project, project_id, q, billable, tag, client, limit = 500 }: Filter = {}): Promise<Entry[]> {
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
    const faturavel = lerBooleano(billable);
    if (faturavel !== null) where.push('e."billable" = ?'), args.push(faturavel ? 1 : 0);
    if (client) where.push('p."client" = ? COLLATE NOCASE'), args.push(String(client).trim());
    if (tag) {
      // As tags são um array JSON em texto; procurar pela tag ENTRE ASPAS evita
      // que "web" case com "webflow".
      where.push(`e."tags" LIKE ? ESCAPE '\\'`), args.push(`%${escaparLike(JSON.stringify(String(tag).trim().slice(0, 40)))}%`);
    }
    if (q) {
      const termo = `%${escaparLike(String(q).slice(0, 100))}%`;
      where.push(`(e."description" LIKE ? ESCAPE '\\' OR e."tags" LIKE ? ESCAPE '\\')`), args.push(termo, termo);
    }
    const max = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    const rows = await all<LinhaEntrada>(`${ENTRY_SELECT} WHERE ${where.join(" AND ")} ORDER BY e."start" DESC LIMIT ?`, ...args, max);
    const padrao = await taxaPadrao();
    return rows.map((r) => shapeEntry(r, padrao)!);
  }

  /** Tags que a pessoa já usou neste workspace, das mais usadas para as menos. */
  async function listTags(): Promise<Array<{ tag: string; entries: number }>> {
    const rows = await all<{ tags: string }>(
      `SELECT "tags" FROM "time_entry" WHERE "workspaceId" = ?1 AND "userId" = ?2 AND "tags" != '[]' ORDER BY "start" DESC LIMIT 3000`,
      ws,
      uid,
    );
    const conta = new Map<string, number>();
    for (const r of rows) for (const t of JSON.parse(r.tags) as string[]) conta.set(t, (conta.get(t) ?? 0) + 1);
    return [...conta.entries()].sort((a, b) => b[1] - a[1]).map(([tag, entries]) => ({ tag, entries }));
  }

  /** Relatório agregado de um período. */
  async function summary(filter: Filter = {}) {
    const entries = await listEntries({ ...filter, limit: 5000 });
    const { currency } = await getSettings();

    type Grupo = { seconds: number; amount: number; entries: number };
    const novo = (): Grupo => ({ seconds: 0, amount: 0, entries: 0 });
    const somar = <K, T extends Grupo>(mapa: Map<K, T>, chave: K, base: () => T, e: Entry) => {
      const g = mapa.get(chave) ?? base();
      g.seconds += e.duration_seconds;
      g.amount += e.amount;
      g.entries += 1;
      mapa.set(chave, g);
    };

    const byProject = new Map<number, Grupo & { project_id: number | null; project: string; client: string; color: string }>();
    const byClient = new Map<string, Grupo & { client: string }>();
    const byTag = new Map<string, Grupo & { tag: string }>();
    const byDesc = new Map<string, Grupo & { description: string; project: string | null }>();
    const byDay = new Map<string, Grupo & { day: string }>();
    let total = 0;
    let billable = 0;
    let amount = 0;

    for (const e of entries) {
      total += e.duration_seconds;
      amount += e.amount;
      if (e.billable) billable += e.duration_seconds;
      const pk = e.project_id ?? 0;
      somar(byProject, pk, () => ({ ...novo(), project_id: e.project_id, project: e.project ?? "(sem projeto)", client: e.client ?? "", color: e.project_color ?? "#9ca3af" }), e);
      const cliente = e.client || "(sem cliente)";
      somar(byClient, cliente.toLowerCase(), () => ({ ...novo(), client: cliente }), e);
      // Um lançamento com duas tags conta nas duas: a soma por tag can passar do total.
      for (const t of e.tags.length ? e.tags : ["(sem tag)"]) somar(byTag, t.toLowerCase(), () => ({ ...novo(), tag: t }), e);
      somar(byDesc, `${pk}|${e.description}`, () => ({ ...novo(), description: e.description || "(sem descrição)", project: e.project ?? null }), e);
      const dia = localDay(e.start, tz);
      somar(byDay, dia, () => ({ ...novo(), day: dia }), e);
    }

    const fechar = <T extends Grupo>(mapa: Map<unknown, T>) =>
      [...mapa.values()]
        .sort((a, b) => b.seconds - a.seconds)
        .map((g) => ({ ...g, amount: centavos(g.amount), hours: Math.round((g.seconds / 3600) * 100) / 100 }));

    return {
      from: filter.from ?? null,
      to: filter.to ?? null,
      timezone: tz,
      currency,
      total_seconds: total,
      total_hours: Math.round((total / 3600) * 100) / 100,
      billable_seconds: billable,
      billable_amount: centavos(amount),
      entries: entries.length,
      by_project: fechar(byProject),
      by_client: fechar(byClient),
      by_tag: fechar(byTag),
      by_day: fechar(byDay).sort((a, b) => a.day.localeCompare(b.day)),
      by_description: fechar(byDesc),
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
    getSettings,
    updateSettings,
    listTags,
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
