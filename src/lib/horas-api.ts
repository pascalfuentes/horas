import { HorasError, type Store } from "~/lib/horas";
import { ImportFormatError, parseImport, type DateOrder } from "~/lib/horas-import";

/**
 * JSON router for time tracking.
 *
 * It is the SAME for the web (cookie session, at `/api/w/<slug>/horas/…`) and for
 * the public API (token, at `/api/v1/…`). The caller has already resolved the
 * person, the workspace and whether they can write; here only the route is decided.
 */

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export const jsonError = (message: string, status: number) => json({ error: message }, status);

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  if (text.length > 20_000) throw new HorasError("Request body too large.", 413);
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    throw new HorasError("The body must be JSON.");
  }
}

/** CSV cell. The leading apostrophe defuses formulas when opened in Excel/Sheets. */
function csv(value: unknown): string {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function handleHoras(
  request: Request,
  store: Store,
  path: string,
  canWrite: boolean,
): Promise<Response> {
  const method = request.method.toUpperCase();
  const parts = path.split("/").filter(Boolean);
  const [resource, id] = parts;
  const q = new URL(request.url).searchParams;
  const filter = {
    from: q.get("from"),
    to: q.get("to"),
    project: q.get("project"),
    project_id: q.get("project_id"),
    q: q.get("q"),
    billable: q.get("billable"),
    tag: q.get("tag"),
    client: q.get("client"),
  };

  try {
    if (method !== "GET" && !canWrite) {
      return jsonError("Your role in this workspace is read-only.", 403);
    }
    if (parts.length > 2) return jsonError("Route not found.", 404);

    if (resource === "status" && !id && method === "GET") return json(await store.status());

    if (resource === "summary" && !id && method === "GET") return json(await store.summary(filter));

    if (resource === "tags" && !id && method === "GET") return json(await store.listTags());

    if (resource === "settings" && !id) {
      if (method === "GET") return json(await store.getSettings());
      if (method === "PATCH") return json(await store.updateSettings(await readBody(request)));
    }

    if (resource === "backup.json" && !id && method === "GET") {
      return new Response(JSON.stringify(await store.exportBackup(), null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": 'attachment; filename="clockfolio-backup.json"',
          "cache-control": "no-store",
        },
      });
    }

    // The body is the file itself (CSV or a backup JSON), not a JSON envelope.
    // `?dry_run=1` previews without writing.
    if (resource === "import" && !id && method === "POST") {
      const file = await request.text();
      if (file.length > 3_000_000) return jsonError("File too large. The limit is 3 MB; split it by period.", 413);
      const order = q.get("date_format");
      const dateOrder: DateOrder = order === "mdy" || order === "dmy" ? order : "auto";
      const dryRun = q.get("dry_run") === "1" || q.get("dry_run") === "true";
      return json(await store.importData(parseImport(file, dateOrder), { dryRun }));
    }

    if (resource === "export.csv" && !id && method === "GET") {
      const entries = await store.listEntries({ ...filter, limit: 5000 });
      const lines = [
        ["id", "description", "project", "client", "tags", "billable", "start", "end", "hours", "amount", "currency"].join(","),
        ...entries.map((e) =>
          [
            e.id,
            csv(e.description),
            csv(e.project),
            csv(e.client),
            csv(e.tags.join(" ")),
            e.billable ? "yes" : "no",
            e.start,
            e.end ?? "",
            (e.duration_seconds / 3600).toFixed(2),
            e.amount.toFixed(2),
            e.currency,
          ].join(","),
        ),
      ];
      return new Response(lines.join("\n") + "\n", {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="clockfolio.csv"',
          "cache-control": "no-store",
        },
      });
    }

    if (resource === "projects") {
      if (!id && method === "GET") return json(await store.listProjects({ includeArchived: q.get("archived") === "1" }));
      if (!id && method === "POST") return json(await store.createProject(await readBody(request)), 201);
      if (id && method === "PATCH") return json(await store.updateProject(id, await readBody(request)));
      if (id && method === "DELETE") return json(await store.deleteProject(id));
    }

    if (resource === "entries") {
      if (!id && method === "GET") return json(await store.listEntries({ ...filter, limit: Number(q.get("limit")) || 500 }));
      if (!id && method === "POST") return json(await store.createEntry(await readBody(request)), 201);
      if (id && method === "GET") return json(await store.getEntry(id));
      if (id && method === "PATCH") return json(await store.updateEntry(id, await readBody(request)));
      if (id && method === "DELETE") return json(await store.deleteEntry(id));
    }

    if (resource === "timer" && method === "POST") {
      if (id === "start") return json(await store.startTimer(await readBody(request)), 201);
      if (id === "stop") return json({ stopped: await store.stopTimer(await readBody(request)) });
    }

    return jsonError("Route not found.", 404);
  } catch (err) {
    if (err instanceof HorasError) return jsonError(err.message, err.status);
    if (err instanceof ImportFormatError) return jsonError(err.message, 400);
    console.error("horas-api:", err);
    return jsonError("Internal error.", 500);
  }
}
