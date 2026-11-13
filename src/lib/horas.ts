/**
 * Time tracking core: every business operation on top of D1.
 *
 * The web API, the token API and the MCP server use ONLY what `createStore`
 * returns. The store is born bound to one workspace and one person, and every
 * query filters by both — no function here accepts another owner as a
 * parameter.
 */

import type { ImportError, Parsed } from "~/lib/horas-import";

// Project colors from the design system (project/sky, coral, sun, mint, violet, rose).
const COLORS = ["#5dcdf1", "#fd976d", "#fdd46b", "#4cc98c", "#9b8afb", "#f0705f"];

export const DEFAULT_TZ = "America/Sao_Paulo";

/** Projects a workspace may have; shared by manual creation and import. */
const MAX_PROJECTS = 500;

/** Error with an HTTP status, used for 400/404/409 responses. */
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
  /** New entries on this project start as billable. */
  billable: boolean;
  /** Hourly rate. null = uses the workspace default. */
  hourly_rate: number | null;
  /** Currency this project is billed in (ISO 4217). null = the workspace currency. */
  currency: string | null;
  total_seconds: number;
  /** This person's entries on the project, and how many of them are billable. */
  entries: number;
  billable_entries: number;
};

/** An amount of money in one currency. A period can add up to several. */
export type Amount = { currency: string; amount: number };

export type Settings = {
  /** ISO 4217 code, for formatting only. */
  currency: string;
  /** Hourly rate for projects that do not have their own. */
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
  /** Entry amount, in `currency`. Zero when not billable. */
  amount: number;
  /** The project's currency, or the workspace currency when the project has none. */
  currency: string;
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
  /** Billable only (true) or non-billable only (false). */
  billable?: boolean | string | null;
  /** Only entries with this tag (exact, case-insensitive). */
  tag?: string | null;
  /** Only projects of this client. */
  client?: string | null;
  limit?: number;
};

/* ---------- Dates and timezone ---------- */

/** Is the timezone an IANA name this runtime knows? */
export function isValidTz(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Difference (ms) between wall-clock time in the timezone and UTC, at that instant. */
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

/** Wall-clock time in the timezone -> UTC instant in ms. `m` is 1-12. */
function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, h, mi, s);
  const guess = wall - tzOffset(wall, tz);
  return wall - tzOffset(guess, tz);
}

/** Day (YYYY-MM-DD) of an instant, as seen in the timezone. */
function localDay(when: string | number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(when));
}

/**
 * Normalizes a date to ISO UTC. Dates without an offset ("2026-11-11T09:00") are
 * read in the person's timezone — that is how an AI usually sends "today at 9am".
 */
function toIso(value: unknown, field: string, tz: string): string {
  if (typeof value === "string") {
    const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/);
    if (m) return new Date(zonedToUtc(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), tz)).toISOString();
  }
  const d = new Date(value as string);
  if (value === null || value === undefined || value === "" || Number.isNaN(d.getTime())) {
    throw new HorasError(`Invalid date in "${field}": ${String(value)}`);
  }
  return d.toISOString();
}

/** Period bound in ISO. "YYYY-MM-DD" at the end of the period includes the whole day. */
function rangeBound(value: string, isEnd: boolean, tz: string): string {
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(zonedToUtc(+m[1], +m[2], +m[3] + (isEnd ? 1 : 0), 0, 0, 0, tz)).toISOString();
  return toIso(value, isEnd ? "to" : "from", tz);
}

/* ---------- Formatting ---------- */

function tagsJson(tags: unknown): string {
  const list = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : [];
  const clean = [...new Set(list.map((t) => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
  return JSON.stringify(clean);
}

const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

const cents = (n: number) => Math.round(n * 100) / 100;

/** Escapes the LIKE wildcards; use with `ESCAPE '\\'`. */
const escapeLike = (v: string) => v.replace(/[\\%_]/g, "\\$&");

/** undefined = leave as is; null = clear; number >= 0 = store. */
function readRate(v: unknown, field: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new HorasError(`${field} must be a number between 0 and 1,000,000.`);
  return cents(n);
}

function readBoolean(v: unknown): boolean | null {
  if (v === true || v === "1" || v === "true") return true;
  if (v === false || v === "0" || v === "false") return false;
  return null;
}

const isValidColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);

type EntryRow = {
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
  project_currency: string | null;
};

function shapeEntry(row: EntryRow | null, settings: Settings): Entry | null {
  if (!row) return null;
  const { default_rate: defaultRate, currency } = settings;
  const endMs = row.end ? Date.parse(row.end) : Date.now();
  const seconds = Math.max(0, Math.round((endMs - Date.parse(row.start)) / 1000));
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
    duration_seconds: seconds,
    amount: row.billable ? cents((seconds / 3600) * (row.project_rate ?? defaultRate)) : 0,
    currency: row.project_currency ?? currency,
  };
}

const ENTRY_SELECT = `
  SELECT e.*, p."name" AS project_name, p."color" AS project_color, p."client" AS project_client, p."hourlyRate" AS project_rate, p."currency" AS project_currency
  FROM "time_entry" e LEFT JOIN "time_project" p ON p."id" = e."projectId"`;

export type Store = ReturnType<typeof createStore>;

/**
 * Time operations of ONE person in ONE workspace.
 * `tz` defines "today"/"this week" and how dates without an offset are read.
 */
export function createStore(db: D1Database, ctx: { workspaceId: string; userId: string; tz?: string }) {
  const { workspaceId: ws, userId: uid } = ctx;
  const tz = isValidTz(ctx.tz) ? ctx.tz : DEFAULT_TZ;

  const all = async <T>(sql: string, ...args: unknown[]) => (await db.prepare(sql).bind(...args).all<T>()).results ?? [];
  const first = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).first<T>();
  const run = async (sql: string, ...args: unknown[]) => (await db.prepare(sql).bind(...args).run()).meta;
  const nowIso = () => new Date().toISOString();

  /* ----- Workspace settings (currency and default rate) ----- */

  // Read once per request: every entry needs the default rate to compute its
  // amount, and the store only lives for the duration of one request.
  let settingsCache: Promise<Settings> | null = null;

  function getSettings(): Promise<Settings> {
    settingsCache ??= first<{ currency: string; defaultRate: number }>(
      'SELECT "currency", "defaultRate" FROM "time_settings" WHERE "workspaceId" = ?1',
      ws,
    ).then((r) => ({ currency: r?.currency ?? "BRL", default_rate: r?.defaultRate ?? 0 }));
    return settingsCache;
  }

  async function updateSettings(patch: { currency?: unknown; default_rate?: unknown } = {}): Promise<Settings> {
    const current = await getSettings();
    let currency = current.currency;
    if (patch.currency !== undefined) {
      currency = String(patch.currency).trim().toUpperCase();
      try {
        new Intl.NumberFormat("en", { style: "currency", currency });
      } catch {
        throw new HorasError(`Invalid currency: ${String(patch.currency)}. Use a code such as BRL, USD or EUR.`);
      }
    }
    const rate = readRate(patch.default_rate, "default_rate");
    await run(
      `INSERT INTO "time_settings" ("workspaceId", "currency", "defaultRate") VALUES (?1, ?2, ?3)
       ON CONFLICT ("workspaceId") DO UPDATE SET "currency" = ?2, "defaultRate" = ?3`,
      ws,
      currency,
      rate === undefined ? current.default_rate : (rate ?? 0),
    );
    settingsCache = null;
    return getSettings();
  }

  
  /* ----- Projects (of the workspace; totals only cover this person's hours) ----- */

  async function listProjects({ includeArchived = false }: { includeArchived?: boolean } = {}): Promise<Project[]> {
    const rows = await all<{ id: number; name: string; client: string; color: string; archived: number; billable: number; hourlyRate: number | null; currency: string | null; total: number; entries: number; billableEntries: number }>(
      `SELECT p.*, COALESCE(SUM((julianday(COALESCE(e."end", 'now')) - julianday(e."start")) * 86400), 0) AS total,
              COUNT(e."id") AS entries, COALESCE(SUM(e."billable"), 0) AS billableEntries
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
      billable: !!r.billable,
      hourly_rate: r.hourlyRate,
      currency: r.currency,
      total_seconds: Math.round(r.total),
      entries: r.entries,
      billable_entries: r.billableEntries,
    }));
  }

  async function getProject(id: number | string): Promise<Project> {
    const p = (await listProjects({ includeArchived: true })).find((x) => x.id === Number(id));
    if (!p) throw new HorasError(`Project ${id} not found.`, 404);
    return p;
  }

  /**
   * Reads a project currency: undefined = not sent, null = "use the workspace
   * currency" (also when it is the same as the workspace's).
   */
  async function readCurrency(value: unknown): Promise<string | null | undefined> {
    if (value === undefined) return undefined;
    if (value === null || String(value).trim() === "") return null;
    const code = String(value).trim().toUpperCase();
    try {
      new Intl.NumberFormat("en", { style: "currency", currency: code });
    } catch {
      throw new HorasError(`Invalid currency: ${String(value)}. Use a code such as BRL, USD or EUR.`);
    }
    return code === (await getSettings()).currency ? null : code;
  }

  /** The workspace default rate is in the workspace currency; it cannot price another one. */
  function requireOwnRate(currency: string | null, rate: number | null): void {
    if (currency && rate === null) throw new HorasError(`A project billed in ${currency} needs its own hourly rate: the workspace default rate is in another currency.`);
  }

  async function createProject(input: { name?: string; client?: string; color?: string; hourly_rate?: unknown; billable?: unknown; currency?: unknown } = {}): Promise<Project> {
    const name = text(input.name, 80);
    if (!name) throw new HorasError("The project needs a name.");
    if (await first('SELECT 1 AS x FROM "time_project" WHERE "workspaceId" = ?1 AND "name" = ?2', ws, name)) {
      throw new HorasError(`A project named "${name}" already exists.`, 409);
    }
    const total = await first<{ n: number }>('SELECT COUNT(*) AS n FROM "time_project" WHERE "workspaceId" = ?1', ws);
    if ((total?.n ?? 0) >= MAX_PROJECTS) throw new HorasError(`Limit of ${MAX_PROJECTS} projects per workspace.`);
    const newCurrency = (await readCurrency(input.currency)) ?? null;
    requireOwnRate(newCurrency, readRate(input.hourly_rate, "hourly_rate") ?? null);
    const meta = await run(
      'INSERT INTO "time_project" ("workspaceId", "name", "client", "color", "createdAt", "hourlyRate", "billable", "currency") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
      ws,
      name,
      text(input.client, 80),
      isValidColor(input.color) ? input.color : COLORS[(total?.n ?? 0) % COLORS.length],
      nowIso(),
      readRate(input.hourly_rate, "hourly_rate") ?? null,
      readBoolean(input.billable) ? 1 : 0,
      newCurrency,
    );
    return getProject(meta.last_row_id);
  }

  async function updateProject(
    id: number | string,
    patch: { name?: string; client?: string; color?: string; archived?: boolean; hourly_rate?: unknown; billable?: unknown; currency?: unknown; apply_to_entries?: unknown } = {},
  ): Promise<Project & { entries_updated?: number }> {
    const cur = await getProject(id);
    const name = patch.name !== undefined ? text(patch.name, 80) : cur.name;
    if (!name) throw new HorasError("The project needs a name.");
    if (await first('SELECT 1 AS x FROM "time_project" WHERE "workspaceId" = ?1 AND "name" = ?2 AND "id" != ?3', ws, name, cur.id)) {
      throw new HorasError(`A project named "${name}" already exists.`, 409);
    }
    const rate = readRate(patch.hourly_rate, "hourly_rate");
    const newRate = rate === undefined ? cur.hourly_rate : rate;
    const sentCurrency = await readCurrency(patch.currency);
    const newCurrency = sentCurrency === undefined ? cur.currency : sentCurrency;
    const newBillable = patch.billable !== undefined && patch.billable !== null ? readBoolean(patch.billable) === true : cur.billable;
    // Only checked when one of the two changes: an archive toggle must not fail on old data.
    if (rate !== undefined || sentCurrency !== undefined) requireOwnRate(newCurrency, newRate);
    await run(
      'UPDATE "time_project" SET "name" = ?1, "client" = ?2, "color" = ?3, "archived" = ?4, "hourlyRate" = ?7, "billable" = ?8, "currency" = ?9 WHERE "id" = ?5 AND "workspaceId" = ?6',
      name,
      patch.client !== undefined ? text(patch.client, 80) : cur.client,
      isValidColor(patch.color) ? patch.color : cur.color,
      (patch.archived !== undefined ? patch.archived : cur.archived) ? 1 : 0,
      cur.id,
      ws,
      newRate,
      newBillable ? 1 : 0,
      newCurrency,
    );
    // "Billable by default" only reaches new entries. On request, this person's
    // existing entries on the project follow it too (never another member's).
    if (readBoolean(patch.apply_to_entries) === true) {
      const meta = await run(
        'UPDATE "time_entry" SET "billable" = ?1 WHERE "projectId" = ?2 AND "workspaceId" = ?3 AND "userId" = ?4 AND "billable" != ?1',
        newBillable ? 1 : 0,
        cur.id,
        ws,
        uid,
      );
      return { ...(await getProject(cur.id)), entries_updated: meta.changes ?? 0 };
    }
    return getProject(cur.id);
  }

  /** Deletes the project. The entries (of every member) remain, without a project. */
  async function deleteProject(id: number | string): Promise<{ deleted: true; id: number }> {
    const cur = await getProject(id);
    await run('UPDATE "time_entry" SET "projectId" = NULL WHERE "projectId" = ?1 AND "workspaceId" = ?2', cur.id, ws);
    await run('DELETE FROM "time_project" WHERE "id" = ?1 AND "workspaceId" = ?2', cur.id, ws);
    return { deleted: true, id: cur.id };
  }

  /**
   * Resolves a project by id or name. An unknown name creates the project —
   * that is what lets an AI say "start a timer on project X" with no setup.
   * Returns `undefined` when nothing was given (= leave as is).
   */
  async function resolveProject(ref: { project_id?: number | string | null; project?: string | null }): Promise<number | null | undefined> {
    if (ref.project_id !== undefined) {
      if (ref.project_id === null || ref.project_id === "" || Number(ref.project_id) === 0) return null;
      return (await getProject(ref.project_id)).id;
    }
    if (ref.project === undefined) return undefined;
    const name = text(ref.project, 80);
    if (!name) return null;
    const row = await first<{ id: number }>('SELECT "id" FROM "time_project" WHERE "workspaceId" = ?1 AND "name" = ?2', ws, name);
    return row ? row.id : (await createProject({ name })).id;
  }

  /**
   * Whether a new entry is billable: what the caller said, or, when it said
   * nothing, the default of the project it goes on.
   */
  async function billableFor(input: EntryInput, projectId: number | null): Promise<number> {
    if (input.billable !== undefined && input.billable !== null) return input.billable ? 1 : 0;
    if (!projectId) return 0;
    const p = await first<{ billable: number }>('SELECT "billable" FROM "time_project" WHERE "id" = ?1 AND "workspaceId" = ?2', projectId, ws);
    return p?.billable ? 1 : 0;
  }

  /* ----- Entries ----- */

  async function getEntry(id: number | string): Promise<Entry> {
    const row = await first<EntryRow>(`${ENTRY_SELECT} WHERE e."id" = ?1 AND e."workspaceId" = ?2 AND e."userId" = ?3`, Number(id), ws, uid);
    if (!row) throw new HorasError(`Entry ${id} not found.`, 404);
    return shapeEntry(row, await getSettings())!;
  }

  /** Timer running right now, if any. */
  async function getRunning(): Promise<Entry | null> {
    return shapeEntry(
      await first<EntryRow>(`${ENTRY_SELECT} WHERE e."workspaceId" = ?1 AND e."userId" = ?2 AND e."end" IS NULL LIMIT 1`, ws, uid),
      await getSettings(),
    );
  }

  /** Stops the running timer. Returns null if there was none. */
  async function stopTimer({ end }: { end?: string } = {}): Promise<Entry | null> {
    const running = await getRunning();
    if (!running) return null;
    const endIso = end ? toIso(end, "end", tz) : nowIso();
    if (endIso < running.start) throw new HorasError("The end cannot be before the start.");
    await run('UPDATE "time_entry" SET "end" = ?1 WHERE "id" = ?2 AND "end" IS NULL', endIso, running.id);
    return getEntry(running.id);
  }

  /** Starts a timer. If one is already running, it is stopped first. */
  async function startTimer(input: EntryInput = {}): Promise<{ entry: Entry; stopped: Entry | null }> {
    const start = input.start ? toIso(input.start, "start", tz) : nowIso();
    if (Date.parse(start) > Date.now() + 60000) throw new HorasError("A timer cannot start in the future.");
    const projectId = (await resolveProject(input)) ?? null;
    const running = await getRunning();
    const stopped = running ? await stopTimer({ end: start > running.start ? start : undefined }) : null;
    const meta = await run(
      `INSERT INTO "time_entry" ("workspaceId", "userId", "description", "projectId", "tags", "billable", "start", "createdAt")
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ws,
      uid,
      text(input.description, 500),
      projectId,
      tagsJson(input.tags),
      await billableFor(input, projectId),
      start,
      nowIso(),
    );
    return { entry: await getEntry(meta.last_row_id), stopped };
  }

  /**
   * Creates an already finished entry (manual entry).
   * Accepts start+end, start+duration_minutes, end+duration_minutes or just
   * duration_minutes (ends now).
   */
  async function createEntry(input: EntryInput = {}): Promise<Entry> {
    const mins = input.duration_minutes !== undefined && input.duration_minutes !== null ? Number(input.duration_minutes) : null;
    if (mins !== null && !(mins > 0)) throw new HorasError("duration_minutes must be greater than zero.");
    let start = input.start ? toIso(input.start, "start", tz) : null;
    let end = input.end ? toIso(input.end, "end", tz) : null;
    if (start && !end && mins) end = new Date(Date.parse(start) + mins * 60000).toISOString();
    if (!start && mins) {
      end = end || nowIso();
      start = new Date(Date.parse(end) - mins * 60000).toISOString();
    }
    if (!start || !end) throw new HorasError("Provide start and end, or duration_minutes.");
    if (end <= start) throw new HorasError("The end must be after the start.");
    const projectId = (await resolveProject(input)) ?? null;
    const meta = await run(
      `INSERT INTO "time_entry" ("workspaceId", "userId", "description", "projectId", "tags", "billable", "start", "end", "createdAt")
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ws,
      uid,
      text(input.description, 500),
      projectId,
      tagsJson(input.tags),
      await billableFor(input, projectId),
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
      if (!(mins > 0)) throw new HorasError("duration_minutes must be greater than zero.");
      end = new Date(Date.parse(start) + mins * 60000).toISOString();
    }
    if (end && end <= start) throw new HorasError("The end must be after the start.");
    if (!end && Date.parse(start) > Date.now() + 60000) throw new HorasError("A running timer cannot start in the future.");
    const projectId = await resolveProject(patch);
    await run(
      `UPDATE "time_entry" SET "description" = ?1, "projectId" = ?2, "tags" = ?3, "billable" = ?4, "start" = ?5, "end" = ?6
        WHERE "id" = ?7 AND "workspaceId" = ?8 AND "userId" = ?9`,
      patch.description !== undefined ? text(patch.description, 500) : cur.description,
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

  /** Lists entries, newest first. */
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
    const billableFilter = readBoolean(billable);
    if (billableFilter !== null) where.push('e."billable" = ?'), args.push(billableFilter ? 1 : 0);
    if (client) where.push('p."client" = ? COLLATE NOCASE'), args.push(String(client).trim());
    if (tag) {
      // Tags are a JSON array stored as text; searching for the QUOTED tag keeps
      // "web" from matching "webflow".
      where.push(`e."tags" LIKE ? ESCAPE '\\'`), args.push(`%${escapeLike(JSON.stringify(String(tag).trim().slice(0, 40)))}%`);
    }
    if (q) {
      const term = `%${escapeLike(String(q).slice(0, 100))}%`;
      where.push(`(e."description" LIKE ? ESCAPE '\\' OR e."tags" LIKE ? ESCAPE '\\')`), args.push(term, term);
    }
    const max = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    const rows = await all<EntryRow>(`${ENTRY_SELECT} WHERE ${where.join(" AND ")} ORDER BY e."start" DESC LIMIT ?`, ...args, max);
    const settings = await getSettings();
    return rows.map((r) => shapeEntry(r, settings)!);
  }

  /** Tags the person has already used in this workspace, most used first. */
  async function listTags(): Promise<Array<{ tag: string; entries: number }>> {
    const rows = await all<{ tags: string }>(
      `SELECT "tags" FROM "time_entry" WHERE "workspaceId" = ?1 AND "userId" = ?2 AND "tags" != '[]' ORDER BY "start" DESC LIMIT 3000`,
      ws,
      uid,
    );
    const counts = new Map<string, number>();
    for (const r of rows) for (const t of JSON.parse(r.tags) as string[]) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag, entries]) => ({ tag, entries }));
  }

  /** Aggregated report for a period. */
  async function summary(filter: Filter = {}) {
    const entries = await listEntries({ ...filter, limit: 5000 });
    const { currency } = await getSettings();

    // Money is added per currency: a period can mix projects billed in several.
    type Group = { seconds: number; money: Map<string, number>; entries: number };
    const blank = (): Group => ({ seconds: 0, money: new Map(), entries: 0 });
    const addMoney = (money: Map<string, number>, e: Entry) => {
      if (e.amount) money.set(e.currency, (money.get(e.currency) ?? 0) + e.amount);
    };
    /** Per-currency list (workspace currency first) plus the plain number when there is only one. */
    const amounts = (money: Map<string, number>) => {
      const list: Amount[] = [...money.entries()]
        .map(([c, a]) => ({ currency: c, amount: cents(a) }))
        .sort((a, b) => (a.currency === currency ? -1 : b.currency === currency ? 1 : a.currency.localeCompare(b.currency)));
      return { amounts: list, amount: list.length === 0 ? 0 : list.length === 1 ? list[0].amount : null };
    };
    const add = <K, T extends Group>(map: Map<K, T>, key: K, base: () => T, e: Entry) => {
      const g = map.get(key) ?? base();
      g.seconds += e.duration_seconds;
      addMoney(g.money, e);
      g.entries += 1;
      map.set(key, g);
    };

    const byProject = new Map<number, Group & { project_id: number | null; project: string; client: string; color: string }>();
    const byClient = new Map<string, Group & { client: string }>();
    const byTag = new Map<string, Group & { tag: string }>();
    const byDesc = new Map<string, Group & { description: string; project: string | null }>();
    const byDay = new Map<string, Group & { day: string }>();
    let total = 0;
    let billable = 0;
    const money = new Map<string, number>();

    for (const e of entries) {
      total += e.duration_seconds;
      addMoney(money, e);
      if (e.billable) billable += e.duration_seconds;
      const pk = e.project_id ?? 0;
      add(byProject, pk, () => ({ ...blank(), project_id: e.project_id, project: e.project ?? "(no project)", client: e.client ?? "", color: e.project_color ?? "#9ca3af" }), e);
      const clientName = e.client || "(no client)";
      add(byClient, clientName.toLowerCase(), () => ({ ...blank(), client: clientName }), e);
      // An entry with two tags counts in both: the per-tag sum can exceed the total.
      for (const t of e.tags.length ? e.tags : ["(no tag)"]) add(byTag, t.toLowerCase(), () => ({ ...blank(), tag: t }), e);
      add(byDesc, `${pk}|${e.description}`, () => ({ ...blank(), description: e.description || "(no description)", project: e.project ?? null }), e);
      const dayKey = localDay(e.start, tz);
      add(byDay, dayKey, () => ({ ...blank(), day: dayKey }), e);
    }

    const finish = <T extends Group>(map: Map<unknown, T>) =>
      [...map.values()]
        .sort((a, b) => b.seconds - a.seconds)
        .map(({ money: m, ...g }) => ({ ...g, ...amounts(m), hours: Math.round((g.seconds / 3600) * 100) / 100 }));

    return {
      from: filter.from ?? null,
      to: filter.to ?? null,
      timezone: tz,
      currency,
      total_seconds: total,
      total_hours: Math.round((total / 3600) * 100) / 100,
      billable_seconds: billable,
      // `billable_amount` is null when the period mixes currencies; `billable_amounts` always has them all.
      billable_amount: amounts(money).amount,
      billable_amounts: amounts(money).amounts,
      entries: entries.length,
      by_project: finish(byProject),
      by_client: finish(byClient),
      by_tag: finish(byTag),
      by_day: finish(byDay).sort((a, b) => a.day.localeCompare(b.day)),
      by_description: finish(byDesc),
    };
  }

  /** Current status: running timer and totals for today and the week (Monday to Sunday). */
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

  /* ----- Backup and import ----- */

  /**
   * Everything this person has in this workspace, in a format `importData`
   * reads back. Projects go by name, not id, so the file can be restored into
   * another workspace or another account.
   */
  async function exportBackup() {
    const [settings, projects, rows] = await Promise.all([
      getSettings(),
      listProjects({ includeArchived: true }),
      all<{ description: string; project: string | null; tags: string; billable: number; start: string; end: string }>(
        `SELECT e."description", p."name" AS project, e."tags", e."billable", e."start", e."end"
           FROM "time_entry" e LEFT JOIN "time_project" p ON p."id" = e."projectId"
          WHERE e."workspaceId" = ?1 AND e."userId" = ?2 AND e."end" IS NOT NULL
          ORDER BY e."start"`,
        ws,
        uid,
      ),
    ]);
    return {
      format: "horas-backup",
      version: 1,
      exported_at: nowIso(),
      timezone: tz,
      settings,
      projects: projects.map((p) => ({ name: p.name, client: p.client, color: p.color, archived: p.archived, billable: p.billable, hourly_rate: p.hourly_rate, currency: p.currency })),
      entries: rows.map((r) => ({
        description: r.description,
        project: r.project ?? "",
        tags: JSON.parse(r.tags) as string[],
        billable: !!r.billable,
        start: r.start,
        end: r.end,
      })),
    };
  }

  /**
   * Imports a parsed file. With `dryRun`, nothing is written and the result
   * says what WOULD happen — that is what the preview on screen shows.
   *
   * An entry with the same start, end and description as one already here is
   * skipped, so importing the same file twice does not duplicate anything.
   */
  async function importData(parsed: Parsed, { dryRun = false }: { dryRun?: boolean } = {}) {
    const errors: ImportError[] = [...parsed.errors];
    const ready: Array<{ description: string; project: string; client: string; tags: string; billable: number; start: string; end: string }> = [];

    for (const item of parsed.items) {
      try {
        const start = toIso(item.start, "start", tz);
        // "+N" is the parser's way of saying "N seconds after the start".
        const end = item.end.startsWith("+")
          ? new Date(Date.parse(start) + Number(item.end.slice(1)) * 1000).toISOString()
          : toIso(item.end, "end", tz);
        if (end <= start) throw new HorasError("The end must be after the start.");
        ready.push({
          description: text(item.description, 500),
          project: text(item.project, 80),
          client: text(item.client, 80),
          tags: tagsJson(item.tags),
          billable: item.billable ? 1 : 0,
          start,
          end,
        });
      } catch (err) {
        errors.push({ row: item.row, message: err instanceof HorasError ? err.message : "Invalid entry." });
      }
    }

    // Duplicates: against what is already stored, and within the file itself.
    const seen = new Set<string>();
    if (ready.length) {
      const starts = ready.map((r) => r.start).sort();
      const existing = await all<{ start: string; end: string | null; description: string }>(
        `SELECT "start", "end", "description" FROM "time_entry"
          WHERE "workspaceId" = ?1 AND "userId" = ?2 AND "start" >= ?3 AND "start" <= ?4`,
        ws,
        uid,
        starts[0],
        starts[starts.length - 1],
      );
      for (const e of existing) seen.add(`${e.start}|${e.end}|${e.description}`);
    }
    const fresh = ready.filter((r) => {
      const key = `${r.start}|${r.end}|${r.description}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const duplicates = ready.length - fresh.length;

    // Projects: matched by name (case-insensitive); missing ones are created.
    const projectRows = () => all<{ id: number; name: string }>('SELECT "id", "name" FROM "time_project" WHERE "workspaceId" = ?1', ws);
    let existingProjects = await projectRows();
    const known = new Set(existingProjects.map((p) => p.name.toLowerCase()));
    const wanted = new Map<string, { name: string; client: string; color: string | null; archived: number; billable: number; rate: number | null; currency: string | null }>();
    for (const p of parsed.projects) {
      const name = text(p.name, 80);
      if (!name || known.has(name.toLowerCase())) continue;
      const rate = typeof p.hourly_rate === "number" && p.hourly_rate >= 0 ? cents(p.hourly_rate) : null;
      wanted.set(name.toLowerCase(), { name, client: text(p.client, 80), color: isValidColor(p.color) ? p.color : null, archived: p.archived ? 1 : 0, billable: p.billable ? 1 : 0, rate, currency: typeof p.currency === "string" && /^[A-Za-z]{3}$/.test(p.currency) && rate !== null ? p.currency.toUpperCase() : null });
    }
    for (const r of fresh) {
      const k = r.project.toLowerCase();
      if (!r.project || known.has(k) || wanted.has(k)) continue;
      wanted.set(k, { name: r.project, client: r.client, color: null, archived: 0, billable: 0, rate: null, currency: null });
    }
    if (existingProjects.length + wanted.size > MAX_PROJECTS) {
      throw new HorasError(`This import would exceed the limit of ${MAX_PROJECTS} projects per workspace.`);
    }

    const result = {
      source: parsed.source,
      dry_run: dryRun,
      rows: parsed.items.length + parsed.errors.length,
      to_import: fresh.length,
      imported: 0,
      duplicates,
      invalid: errors.length,
      new_projects: [...wanted.values()].map((p) => p.name),
      settings_restored: false,
      date_order: parsed.dateOrder,
      // The earliest entry, so the preview can show how the dates were read.
      sample: fresh.length ? [...fresh].sort((a, b) => (a.start < b.start ? -1 : 1)).map((r) => ({ description: r.description, start: r.start, end: r.end }))[0] : null,
      // The first few are enough to show what is wrong with the file.
      errors: errors.sort((a, b) => a.row - b.row).slice(0, 20),
    };
    if (dryRun) return result;

    const now = nowIso();
    if (wanted.size) {
      // One statement for all projects: the rows travel as a single JSON
      // parameter, which stays clear of D1's cap on bound parameters.
      const payload = [...wanted.values()].map((p, i) => ({ ...p, color: p.color ?? COLORS[(existingProjects.length + i) % COLORS.length] }));
      await run(
        `INSERT INTO "time_project" ("workspaceId", "name", "client", "color", "archived", "createdAt", "hourlyRate", "billable", "currency")
         SELECT ?1, json_extract(value, '$.name'), json_extract(value, '$.client'), json_extract(value, '$.color'),
                json_extract(value, '$.archived'), ?2, json_extract(value, '$.rate'), json_extract(value, '$.billable'), json_extract(value, '$.currency')
           FROM json_each(?3)`,
        ws,
        now,
        JSON.stringify(payload),
      );
      existingProjects = await projectRows();
    }
    const projectId = new Map(existingProjects.map((p) => [p.name.toLowerCase(), p.id]));

    // Entries go in chunks, same JSON-parameter technique.
    for (let i = 0; i < fresh.length; i += 400) {
      const chunk = fresh.slice(i, i + 400).map((r) => ({
        d: r.description,
        p: r.project ? (projectId.get(r.project.toLowerCase()) ?? null) : null,
        t: r.tags,
        b: r.billable,
        s: r.start,
        e: r.end,
      }));
      await run(
        `INSERT INTO "time_entry" ("workspaceId", "userId", "description", "projectId", "tags", "billable", "start", "end", "createdAt")
         SELECT ?1, ?2, json_extract(value, '$.d'), json_extract(value, '$.p'), json_extract(value, '$.t'),
                json_extract(value, '$.b'), json_extract(value, '$.s'), json_extract(value, '$.e'), ?3
           FROM json_each(?4)`,
        ws,
        uid,
        now,
        JSON.stringify(chunk),
      );
    }
    result.imported = fresh.length;

    // A backup restores currency and default rate only into a workspace that
    // has never set them; it never overwrites a choice already made here.
    if (parsed.settings && !(await first('SELECT 1 AS x FROM "time_settings" WHERE "workspaceId" = ?1', ws))) {
      await updateSettings(parsed.settings);
      result.settings_restored = true;
    }
    return result;
  }

  return {
    tz,
    exportBackup,
    importData,
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
