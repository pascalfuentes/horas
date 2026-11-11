import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { APP_NAME } from "~/config";
import { HorasError, type Store } from "~/lib/horas";

/**
 * Servidor MCP do controle de tempo.
 *
 * Uma instância por requisição (o transporte é stateless), já amarrada ao
 * store da pessoa dona do token. As ferramentas de escrita só são registradas
 * para quem pode escrever — um `viewer` nem as enxerga.
 *
 * As descrições estão em inglês de propósito: é o que os modelos seguem melhor,
 * e a IA responde no idioma de quem está conversando de qualquer forma.
 */

type Resultado = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Executa a operação e devolve JSON; erro de negócio vira `isError` legível para a IA. */
async function responder(fn: () => Promise<unknown>): Promise<Resultado> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn(), null, 2) }] };
  } catch (erro) {
    if (erro instanceof HorasError) return { content: [{ type: "text", text: erro.message }], isError: true };
    console.error("horas-mcp:", erro);
    return { content: [{ type: "text", text: "Internal error." }], isError: true };
  }
}

const DATA =
  "ISO 8601 date-time. Without an offset (e.g. 2026-11-11T09:00) it is read in the user's timezone, which get_status reports.";
const DIA = "Date as YYYY-MM-DD (user's timezone) or a full ISO date-time.";

const camposDeEntrada = {
  description: z.string().max(500).optional().describe("What was worked on."),
  project: z.string().max(80).optional().describe("Project name. Created automatically if it does not exist. Empty string clears it."),
  tags: z.array(z.string().max(40)).max(20).optional().describe("Free-form tags."),
  billable: z.boolean().optional().describe("Whether the time is billable."),
};

const filtroDePeriodo = {
  from: z.string().optional().describe(`Start of the period, inclusive. ${DIA}`),
  to: z.string().optional().describe(`End of the period, inclusive when given as a date. ${DIA}`),
  project: z.string().optional().describe("Only this project (exact name, case-insensitive)."),
};

export function criarServidorMcp(store: Store, podeEscrever: boolean): McpServer {
  const server = new McpServer(
    { name: APP_NAME.toLowerCase(), version: "1.0.0" },
    {
      instructions:
        "Personal time tracker. Call get_status first to learn the current time, the user's timezone and whether a timer is running. " +
        "Durations come back in seconds (and hours in reports). Only one timer runs at a time: start_timer stops the previous one.",
    },
  );

  server.registerTool(
    "get_status",
    {
      title: "Current status",
      description: "Current time and timezone, the running timer (if any), and total tracked today and this week (Monday to Sunday).",
      annotations: { readOnlyHint: true },
    },
    () => responder(() => store.status()),
  );

  server.registerTool(
    "list_entries",
    {
      title: "List time entries",
      description: "Lists the user's time entries, newest first. Filter by period, project or text.",
      inputSchema: {
        ...filtroDePeriodo,
        q: z.string().max(100).optional().describe("Text to find in descriptions or tags."),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum entries to return. Default 50."),
      },
      annotations: { readOnlyHint: true },
    },
    (a) => responder(() => store.listEntries({ ...a, limit: a.limit ?? 50 })),
  );

  server.registerTool(
    "summary_report",
    {
      title: "Summary report",
      description: "Totals for a period: overall, billable, per project, per day and per description. Use this for questions like 'how much did I work on X last week'.",
      inputSchema: filtroDePeriodo,
      annotations: { readOnlyHint: true },
    },
    (a) => responder(() => store.summary(a)),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "Projects in the workspace, with the user's total tracked time on each.",
      inputSchema: { include_archived: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    (a) => responder(() => store.listProjects({ includeArchived: a.include_archived })),
  );

  if (!podeEscrever) return server;

  server.registerTool(
    "start_timer",
    {
      title: "Start timer",
      description: "Starts a timer now (or at `start`, if in the past). If another timer is running it is stopped first and returned in `stopped`.",
      inputSchema: { ...camposDeEntrada, start: z.string().optional().describe(`When the timer started, if not now. ${DATA}`) },
    },
    (a) => responder(() => store.startTimer(a)),
  );

  server.registerTool(
    "stop_timer",
    {
      title: "Stop timer",
      description: "Stops the running timer. Returns the finished entry, or null when nothing was running.",
      inputSchema: { end: z.string().optional().describe(`When it actually ended, if not now. ${DATA}`) },
    },
    (a) => responder(async () => ({ stopped: await store.stopTimer(a) })),
  );

  server.registerTool(
    "add_entry",
    {
      title: "Add finished entry",
      description:
        "Logs time that already happened. Give start + end, or start + duration_minutes, or just duration_minutes (the entry then ends now).",
      inputSchema: {
        ...camposDeEntrada,
        start: z.string().optional().describe(DATA),
        end: z.string().optional().describe(DATA),
        duration_minutes: z.number().positive().max(60 * 24 * 7).optional().describe("Duration in minutes."),
      },
    },
    (a) => responder(() => store.createEntry(a)),
  );

  server.registerTool(
    "update_entry",
    {
      title: "Update entry",
      description: "Changes an existing entry. Only the fields you send are changed.",
      inputSchema: {
        id: z.number().int().describe("Entry id, from list_entries or get_status."),
        ...camposDeEntrada,
        start: z.string().optional().describe(DATA),
        end: z.string().optional().describe(DATA),
        duration_minutes: z.number().positive().max(60 * 24 * 7).optional().describe("New duration, counted from start."),
      },
    },
    ({ id, ...patch }) => responder(() => store.updateEntry(id, patch)),
  );

  server.registerTool(
    "delete_entry",
    {
      title: "Delete entry",
      description: "Permanently deletes one time entry. Confirm with the user before calling.",
      inputSchema: { id: z.number().int() },
      annotations: { destructiveHint: true },
    },
    ({ id }) => responder(() => store.deleteEntry(id)),
  );

  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description: "Creates a project. Not needed before start_timer/add_entry, which create missing projects by name.",
      inputSchema: {
        name: z.string().min(1).max(80),
        client: z.string().max(80).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Hex color like #3b82f6."),
      },
    },
    (a) => responder(() => store.createProject(a)),
  );

  server.registerTool(
    "update_project",
    {
      title: "Update project",
      description: "Renames, recolors, sets the client of, or archives/unarchives a project.",
      inputSchema: {
        id: z.number().int().describe("Project id, from list_projects."),
        name: z.string().min(1).max(80).optional(),
        client: z.string().max(80).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        archived: z.boolean().optional(),
      },
    },
    ({ id, ...patch }) => responder(() => store.updateProject(id, patch)),
  );

  return server;
}
