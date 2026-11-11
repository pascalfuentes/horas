import { HorasError, type Store } from "~/lib/horas";

/**
 * Roteador JSON do controle de tempo.
 *
 * É o MESMO para a web (sessão por cookie, em `/api/w/<slug>/horas/…`) e para
 * a API pública (token, em `/api/v1/…`). Quem chama já resolveu a pessoa, o
 * workspace e se ela pode escrever; aqui só se decide a rota.
 */

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export const erroJson = (mensagem: string, status: number) => json({ error: mensagem }, status);

async function corpo(request: Request): Promise<Record<string, unknown>> {
  const texto = await request.text();
  if (!texto) return {};
  if (texto.length > 20_000) throw new HorasError("Corpo grande demais.", 413);
  try {
    const dado = JSON.parse(texto);
    return dado && typeof dado === "object" && !Array.isArray(dado) ? dado : {};
  } catch {
    throw new HorasError("O corpo precisa ser JSON.");
  }
}

/** Célula de CSV. O apóstrofo na frente desarma fórmulas ao abrir no Excel/Sheets. */
function csv(valor: unknown): string {
  let s = String(valor ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function handleHoras(
  request: Request,
  store: Store,
  rota: string,
  podeEscrever: boolean,
): Promise<Response> {
  const metodo = request.method.toUpperCase();
  const partes = rota.split("/").filter(Boolean);
  const [recurso, id] = partes;
  const q = new URL(request.url).searchParams;
  const filtro = {
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
    if (metodo !== "GET" && !podeEscrever) {
      return erroJson("Seu papel neste workspace é somente leitura.", 403);
    }
    if (partes.length > 2) return erroJson("Rota não encontrada.", 404);

    if (recurso === "status" && !id && metodo === "GET") return json(await store.status());

    if (recurso === "summary" && !id && metodo === "GET") return json(await store.summary(filtro));

    if (recurso === "tags" && !id && metodo === "GET") return json(await store.listTags());

    if (recurso === "settings" && !id) {
      if (metodo === "GET") return json(await store.getSettings());
      if (metodo === "PATCH") return json(await store.updateSettings(await corpo(request)));
    }

    if (recurso === "export.csv" && !id && metodo === "GET") {
      const entradas = await store.listEntries({ ...filtro, limit: 5000 });
      const linhas = [
        ["id", "descricao", "projeto", "cliente", "tags", "faturavel", "inicio", "fim", "horas", "valor"].join(","),
        ...entradas.map((e) =>
          [
            e.id,
            csv(e.description),
            csv(e.project),
            csv(e.client),
            csv(e.tags.join(" ")),
            e.billable ? "sim" : "nao",
            e.start,
            e.end ?? "",
            (e.duration_seconds / 3600).toFixed(2),
            e.amount.toFixed(2),
          ].join(","),
        ),
      ];
      return new Response(linhas.join("\n") + "\n", {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="horas.csv"',
          "cache-control": "no-store",
        },
      });
    }

    if (recurso === "projects") {
      if (!id && metodo === "GET") return json(await store.listProjects({ includeArchived: q.get("archived") === "1" }));
      if (!id && metodo === "POST") return json(await store.createProject(await corpo(request)), 201);
      if (id && metodo === "PATCH") return json(await store.updateProject(id, await corpo(request)));
      if (id && metodo === "DELETE") return json(await store.deleteProject(id));
    }

    if (recurso === "entries") {
      if (!id && metodo === "GET") return json(await store.listEntries({ ...filtro, limit: Number(q.get("limit")) || 500 }));
      if (!id && metodo === "POST") return json(await store.createEntry(await corpo(request)), 201);
      if (id && metodo === "GET") return json(await store.getEntry(id));
      if (id && metodo === "PATCH") return json(await store.updateEntry(id, await corpo(request)));
      if (id && metodo === "DELETE") return json(await store.deleteEntry(id));
    }

    if (recurso === "timer" && metodo === "POST") {
      if (id === "start") return json(await store.startTimer(await corpo(request)), 201);
      if (id === "stop") return json({ stopped: await store.stopTimer(await corpo(request)) });
    }

    return erroJson("Rota não encontrada.", 404);
  } catch (erro) {
    if (erro instanceof HorasError) return erroJson(erro.message, erro.status);
    console.error("horas-api:", erro);
    return erroJson("Erro interno.", 500);
  }
}
