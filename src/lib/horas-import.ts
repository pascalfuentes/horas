/**
 * Reading files for import. Pure parsing: nothing here touches the database.
 *
 * Three sources are understood:
 *   - a Horas backup (the JSON produced by `exportBackup`),
 *   - a Horas CSV export,
 *   - Clockify's "Detailed report" CSV,
 * plus any CSV that has at least `start` and `end` (or `duration`) columns.
 *
 * Every source is reduced to the same list of `ImportItem`s, so the store has a
 * single import path regardless of where the file came from.
 */

export type ImportSource = "horas-backup" | "horas-csv" | "clockify-csv" | "generic-csv";

export type ImportItem = {
  /** 1-based position in the file, used in error messages. */
  row: number;
  description: string;
  project: string;
  client: string;
  tags: string[];
  billable: boolean;
  /**
   * ISO date-time. May come without an offset ("2026-11-10T09:00:00"), in which
   * case the store reads it in the user's timezone.
   */
  start: string;
  end: string;
};

export type ImportProject = {
  name: string;
  client?: string;
  color?: string;
  archived?: boolean;
  billable?: boolean;
  hourly_rate?: number | null;
  currency?: string | null;
};

export type ImportError = { row: number; message: string };

export type Parsed = {
  source: ImportSource;
  items: ImportItem[];
  errors: ImportError[];
  /** Only a backup carries project details and settings. */
  projects: ImportProject[];
  settings: { currency?: string; default_rate?: number } | null;
  /**
   * How day/month dates were read, when the file had any. Shown in the preview
   * so a wrong guess is caught before importing. Null when dates were ISO.
   */
  dateOrder: "mdy" | "dmy" | null;
};

/** How to read ambiguous dates such as 03/04/2026. */
export type DateOrder = "auto" | "mdy" | "dmy";

export class ImportFormatError extends Error {}

const MAX_ROWS = 5000;

/* ---------- CSV ---------- */

/**
 * RFC 4180 parser: quoted fields, doubled quotes, line breaks inside quotes.
 * The delimiter is `,` or `;`, whichever the header line uses more.
 */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const header = text.slice(0, text.search(/\r?\n|$/));
  const delimiter = (header.match(/;/g)?.length ?? 0) > (header.match(/,/g)?.length ?? 0) ? ";" : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines (a trailing newline, a spacer row) are not data.
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const truthy = (v: string) => /^(yes|y|true|1|sim|s)$/i.test(v.trim());

/** Our own CSV export prefixes formula-like cells with an apostrophe; undo it. */
const unguard = (v: string) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * "11/10/2026" or "2026-11-10" -> [year, month, day], or null.
 * `order` settles which of the first two numbers is the month.
 */
function readDate(value: string, order: "mdy" | "dmy"): [number, number, number] | null {
  const v = value.trim();
  let parts: [number, number, number] | null = null;
  let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) parts = [+m[1], +m[2], +m[3]];
  else {
    m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (m) parts = order === "mdy" ? [+m[3], +m[1], +m[2]] : [+m[3], +m[2], +m[1]];
  }
  if (!parts) return null;
  // Reject impossible dates instead of letting Date() roll them over
  // (month 13 would silently become January of the next year).
  const [y, mo, d] = parts;
  const real = new Date(Date.UTC(y, mo - 1, d));
  return real.getUTCFullYear() === y && real.getUTCMonth() === mo - 1 && real.getUTCDate() === d ? parts : null;
}

/** "09:00", "09:00:00", "9:00 AM", "09:00:00 PM" -> [hour, minute, second], or null. */
function readTime(value: string): [number, number, number] | null {
  const m = value.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]?\.?$|^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  if (m[5] !== undefined) return [+m[5], +m[6], +(m[7] ?? 0)];
  let h = +m[1] % 12;
  if (m[4].toLowerCase() === "p") h += 12;
  return [h, +m[2], +(m[3] ?? 0)];
}

/** "02:30:00", "2:30" or a decimal number of hours -> seconds, or null. */
function readDuration(value: string): number | null {
  const v = value.trim().replace(",", ".");
  const m = v.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +(m[3] ?? 0);
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 3600);
  return null;
}

const naiveIso = (d: [number, number, number], t: [number, number, number]) =>
  `${d[0]}-${pad(d[1])}-${pad(d[2])}T${pad(t[0])}:${pad(t[1])}:${pad(t[2])}`;

/**
 * Decides whether 03/04/2026 means March 4th or April 3rd by looking at every
 * date in the file. A date only votes when it is valid in exactly one order
 * (a 13 or higher in one position, 12 or lower in the other), so a single
 * malformed row cannot flip the reading of the whole file. Majority wins; with
 * no votes, month-first is assumed (Clockify's default).
 */
function detectOrder(dates: string[]): "mdy" | "dmy" {
  let mdy = 0;
  let dmy = 0;
  for (const value of dates) {
    const m = value.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{4}$/);
    if (!m) continue;
    const a = +m[1];
    const b = +m[2];
    if (a > 12 && a <= 31 && b >= 1 && b <= 12) dmy++;
    else if (b > 12 && b <= 31 && a >= 1 && a <= 12) mdy++;
  }
  return dmy > mdy ? "dmy" : "mdy";
}

function fromCsv(text: string, dateOrder: DateOrder): Parsed {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new ImportFormatError("The file has no rows to import.");

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const data = rows.slice(1);
  if (data.length > MAX_ROWS) {
    throw new ImportFormatError(`The file has ${data.length} rows. Import at most ${MAX_ROWS} at a time; split it by period.`);
  }

  const c = {
    description: col("description", "descrição", "descricao"),
    project: col("project", "projeto"),
    client: col("client", "cliente"),
    tags: col("tags", "tag"),
    billable: col("billable", "faturavel", "faturável"),
    start: col("start", "inicio", "início"),
    end: col("end", "fim"),
    startDate: col("start date"),
    startTime: col("start time"),
    endDate: col("end date"),
    endTime: col("end time"),
    duration: col("duration (h)", "duration", "duration (decimal)", "hours", "horas"),
  };

  const clockify = c.startDate >= 0 && c.startTime >= 0;
  const source: ImportSource = clockify ? "clockify-csv" : header.includes("amount") || header.includes("valor") ? "horas-csv" : "generic-csv";
  if (!clockify && c.start < 0) {
    throw new ImportFormatError(
      'Could not find the date columns. Expected "Start Date" and "Start Time" (Clockify) or "start" and "end" (Horas).',
    );
  }

  const order =
    dateOrder === "auto" ? detectOrder(clockify ? data.flatMap((r) => [r[c.startDate] ?? "", r[c.endDate] ?? ""]) : []) : dateOrder;

  const items: ImportItem[] = [];
  const errors: ImportError[] = [];
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");

  data.forEach((r, index) => {
    const row = index + 2; // 1 for the header, 1 because rows are 1-based
    let start = "";
    let end = "";

    if (clockify) {
      const sd = readDate(cell(r, c.startDate), order);
      const st = readTime(cell(r, c.startTime));
      if (!sd || !st) return errors.push({ row, message: `Unreadable start: "${cell(r, c.startDate)} ${cell(r, c.startTime)}".` });
      start = naiveIso(sd, st);
      const ed = readDate(cell(r, c.endDate), order);
      const et = readTime(cell(r, c.endTime));
      if (ed && et) end = naiveIso(ed, et);
    } else {
      start = cell(r, c.start);
      end = cell(r, c.end);
      if (!start) return errors.push({ row, message: "Missing start." });
    }

    // No end column, or an empty one: fall back to the duration.
    if (!end) {
      const seconds = readDuration(cell(r, c.duration));
      if (!seconds) return errors.push({ row, message: "Missing end and duration." });
      end = `+${seconds}`; // resolved by the store once the start is a real instant
    }

    const rawTags = cell(r, c.tags);
    items.push({
      row,
      description: unguard(cell(r, c.description)),
      project: unguard(cell(r, c.project)),
      client: unguard(cell(r, c.client)),
      // Clockify separates tags with ", "; our own export uses spaces.
      tags: (clockify || rawTags.includes(",") ? rawTags.split(",") : rawTags.split(/\s+/)).map((t) => unguard(t.trim())).filter(Boolean),
      billable: truthy(cell(r, c.billable)),
      start,
      end,
    });
  });

  return { source, items, errors, projects: [], settings: null, dateOrder: clockify ? order : null };
}

/* ---------- Backup ---------- */

function fromBackup(data: Record<string, unknown>): Parsed {
  if (data.format !== "horas-backup") {
    throw new ImportFormatError('This JSON is not a Horas backup (missing "format": "horas-backup").');
  }
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (entries.length > MAX_ROWS) {
    throw new ImportFormatError(`The backup has ${entries.length} entries. Import at most ${MAX_ROWS} at a time.`);
  }

  const items: ImportItem[] = [];
  const errors: ImportError[] = [];
  entries.forEach((raw, index) => {
    const row = index + 1;
    const e = (raw ?? {}) as Record<string, unknown>;
    if (typeof e.start !== "string" || typeof e.end !== "string") return errors.push({ row, message: "Entry without start or end." });
    items.push({
      row,
      description: typeof e.description === "string" ? e.description : "",
      project: typeof e.project === "string" ? e.project : "",
      client: "",
      tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
      billable: e.billable === true,
      start: e.start,
      end: e.end,
    });
  });

  const projects: ImportProject[] = (Array.isArray(data.projects) ? data.projects : [])
    .map((raw) => (raw ?? {}) as Record<string, unknown>)
    .filter((p) => typeof p.name === "string" && p.name.trim() !== "")
    .map((p) => ({
      name: String(p.name),
      client: typeof p.client === "string" ? p.client : "",
      color: typeof p.color === "string" ? p.color : undefined,
      archived: p.archived === true,
      billable: p.billable === true,
      hourly_rate: typeof p.hourly_rate === "number" ? p.hourly_rate : null,
      currency: typeof p.currency === "string" ? p.currency : null,
    }));

  const s = (data.settings ?? null) as Record<string, unknown> | null;
  const settings = s
    ? {
        currency: typeof s.currency === "string" ? s.currency : undefined,
        default_rate: typeof s.default_rate === "number" ? s.default_rate : undefined,
      }
    : null;

  return { source: "horas-backup", items, errors, projects, settings, dateOrder: null };
}

/**
 * Reads an uploaded file. JSON is tried first (a backup starts with `{`);
 * anything else is treated as CSV.
 */
export function parseImport(body: string, dateOrder: DateOrder = "auto"): Parsed {
  const text = body.replace(/^﻿/, "").trim();
  if (!text) throw new ImportFormatError("The file is empty.");
  if (text.startsWith("{")) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ImportFormatError("The file looks like JSON but could not be read.");
    }
    return fromBackup(data as Record<string, unknown>);
  }
  return fromCsv(text, dateOrder);
}
