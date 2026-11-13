import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { APP_NAME } from "~/config";
import { HorasError, type Store } from "~/lib/horas";

/**
 * MCP server for time tracking.
 *
 * One instance per request (the transport is stateless), already bound to the
 * store of the person who owns the token. Write tools are only registered
 * for those who can write — a `viewer` does not even see them.
 *
 * The descriptions are in English on purpose: it is what models follow best,
 * and the AI replies in the language of whoever is talking anyway.
 */

type Result = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Runs the operation and returns JSON; a business error becomes an `isError` the AI can read. */
async function respond(fn: () => Promise<unknown>): Promise<Result> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn(), null, 2) }] };
  } catch (err) {
    if (err instanceof HorasError) return { content: [{ type: "text", text: err.message }], isError: true };
    console.error("horas-mcp:", err);
    return { content: [{ type: "text", text: "Internal error." }], isError: true };
  }
}

const DATE_TIME =
  "ISO 8601 date-time. Without an offset (e.g. 2026-11-11T09:00) it is read in the user's timezone, which get_status reports.";
const DAY = "Date as YYYY-MM-DD (user's timezone) or a full ISO date-time.";

const entryFields = {
  description: z.string().max(500).optional().describe("What was worked on."),
  project: z.string().max(80).optional().describe("Project name. Created automatically if it does not exist. Empty string clears it."),
  tags: z.array(z.string().max(40)).max(20).optional().describe("Free-form tags."),
  billable: z.boolean().optional().describe("Whether the time is billable. When omitted, the project's own default applies."),
};

const periodFilter = {
  from: z.string().optional().describe(`Start of the period, inclusive. ${DAY}`),
  to: z.string().optional().describe(`End of the period, inclusive when given as a date. ${DAY}`),
  project: z.string().optional().describe("Only this project (exact name, case-insensitive)."),
  client: z.string().optional().describe("Only projects of this client (exact name, case-insensitive)."),
  tag: z.string().optional().describe("Only entries carrying this tag."),
  billable: z.boolean().optional().describe("true = only billable entries, false = only non-billable."),
};

export function createMcpServer(store: Store, canWrite: boolean): McpServer {
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
    () => respond(() => store.status()),
  );

  server.registerTool(
    "list_entries",
    {
      title: "List time entries",
      description: "Lists the user's time entries, newest first. Filter by period, project or text.",
      inputSchema: {
        ...periodFilter,
        q: z.string().max(100).optional().describe("Text to find in descriptions or tags."),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum entries to return. Default 50."),
      },
      annotations: { readOnlyHint: true },
    },
    (a) => respond(() => store.listEntries({ ...a, limit: a.limit ?? 50 })),
  );

  server.registerTool(
    "summary_report",
    {
      title: "Summary report",
      description:
        "Totals for a period: overall time, billable time and billable amount (billable_amounts lists one total per currency, since projects can be billed in different currencies; billable_amount is null when they mix), broken down per project, client, tag, day and description. Use this for questions like 'how much did I work on X last week' or 'how much should I invoice client Y this month'.",
      inputSchema: periodFilter,
      annotations: { readOnlyHint: true },
    },
    (a) => respond(() => store.summary(a)),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "Projects in the workspace, with client, hourly rate (null = workspace default) and the user's total tracked time on each. budget_amount / budget_hours are the project limits (null = none); spent_amount / spent_hours are what the whole workspace already used of them.",
      inputSchema: { include_archived: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    (a) => respond(() => store.listProjects({ includeArchived: a.include_archived })),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description: "Tags the user has already used, most used first. Check this before tagging so existing tags are reused instead of creating near-duplicates.",
      annotations: { readOnlyHint: true },
    },
    () => respond(() => store.listTags()),
  );

  server.registerTool(
    "get_settings",
    {
      title: "Billing settings",
      description: "Workspace currency and the default hourly rate applied to projects without their own rate.",
      annotations: { readOnlyHint: true },
    },
    () => respond(() => store.getSettings()),
  );

  if (!canWrite) return server;

  server.registerTool(
    "start_timer",
    {
      title: "Start timer",
      description: "Starts a timer now (or at `start`, if in the past). If another timer is running it is stopped first and returned in `stopped`.",
      inputSchema: { ...entryFields, start: z.string().optional().describe(`When the timer started, if not now. ${DATE_TIME}`) },
    },
    (a) => respond(() => store.startTimer(a)),
  );

  server.registerTool(
    "stop_timer",
    {
      title: "Stop timer",
      description: "Stops the running timer. Returns the finished entry, or null when nothing was running.",
      inputSchema: { end: z.string().optional().describe(`When it actually ended, if not now. ${DATE_TIME}`) },
    },
    (a) => respond(async () => ({ stopped: await store.stopTimer(a) })),
  );

  server.registerTool(
    "add_entry",
    {
      title: "Add finished entry",
      description:
        "Logs time that already happened. Give start + end, or start + duration_minutes, or just duration_minutes (the entry then ends now).",
      inputSchema: {
        ...entryFields,
        start: z.string().optional().describe(DATE_TIME),
        end: z.string().optional().describe(DATE_TIME),
        duration_minutes: z.number().positive().max(60 * 24 * 7).optional().describe("Duration in minutes."),
      },
    },
    (a) => respond(() => store.createEntry(a)),
  );

  server.registerTool(
    "update_entry",
    {
      title: "Update entry",
      description: "Changes an existing entry. Only the fields you send are changed.",
      inputSchema: {
        id: z.number().int().describe("Entry id, from list_entries or get_status."),
        ...entryFields,
        start: z.string().optional().describe(DATE_TIME),
        end: z.string().optional().describe(DATE_TIME),
        duration_minutes: z.number().positive().max(60 * 24 * 7).optional().describe("New duration, counted from start."),
      },
    },
    ({ id, ...patch }) => respond(() => store.updateEntry(id, patch)),
  );

  server.registerTool(
    "delete_entry",
    {
      title: "Delete entry",
      description: "Permanently deletes one time entry. Confirm with the user before calling.",
      inputSchema: { id: z.number().int() },
      annotations: { destructiveHint: true },
    },
    ({ id }) => respond(() => store.deleteEntry(id)),
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
        hourly_rate: z.number().min(0).max(1_000_000).nullable().optional().describe("Hourly rate, in the project currency. null falls back to the workspace default rate."),
        currency: z.string().length(3).nullable().optional().describe("ISO 4217 code (USD, EUR, BRL…) this project is billed in. null = the workspace currency. A project in another currency needs its own hourly_rate."),
        budget_amount: z.number().min(0).nullable().optional().describe("Budget in money, in the project currency: the most that may be billed on it. null or 0 removes it."),
        budget_hours: z.number().min(0).nullable().optional().describe("Budget in hours: the most time that may be tracked on it. null or 0 removes it."),
        billable: z.boolean().optional().describe("Whether new entries on this project start as billable."),
      },
    },
    (a) => respond(() => store.createProject(a)),
  );

  server.registerTool(
    "update_project",
    {
      title: "Update project",
      description: "Renames, recolors, sets the client or hourly rate of, or archives/unarchives a project. Changing the rate re-prices every billable entry of the project.",
      inputSchema: {
        id: z.number().int().describe("Project id, from list_projects."),
        name: z.string().min(1).max(80).optional(),
        client: z.string().max(80).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        archived: z.boolean().optional(),
        hourly_rate: z.number().min(0).max(1_000_000).nullable().optional().describe("Hourly rate, in the project currency. null falls back to the workspace default rate."),
        currency: z.string().length(3).nullable().optional().describe("ISO 4217 code (USD, EUR, BRL…) this project is billed in. null = the workspace currency. A project in another currency needs its own hourly_rate."),
        budget_amount: z.number().min(0).nullable().optional().describe("Budget in money, in the project currency: the most that may be billed on it. null or 0 removes it."),
        budget_hours: z.number().min(0).nullable().optional().describe("Budget in hours: the most time that may be tracked on it. null or 0 removes it."),
        billable: z.boolean().optional().describe("Whether new entries on this project start as billable."),
        apply_to_entries: z.boolean().optional().describe("Also set the billable flag of the user's EXISTING entries on this project to the project's value. Without it only new entries follow the default."),
      },
    },
    ({ id, ...patch }) => respond(() => store.updateProject(id, patch)),
  );

  return server;
}
