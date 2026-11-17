#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// How long the actor run itself is allowed to take, in seconds. Fleet standard
// (standing build rule 5, 2026-10-05). A run of 50 searches of 100 posts each
const ACTOR_RUN_TIMEOUT_SECS = 1800;

// How long this wrapper waits for that run, in milliseconds. The actor's own
// timeout plus two minutes, so the run's own TIMED-OUT status is what the
// caller sees rather than the wrapper giving up first and reporting nothing.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = 3000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoints carry a platform
// ceiling of 300 seconds on the HTTP wait itself and answer 408 past it whatever
// the timeout parameter says, so a long run reads as a timeout even though the
// actor goes on to finish. Starting the run, polling it to a terminal status and
// then reading the dataset is the only way to wait as long as the actor needs.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success. Surfacing it here is what keeps a crashed run from reading
  // as "no results found".
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

// The actor's number and on or off inputs are text fields (Apify checks input
// types before the actor starts, and Clay sends text), so numbers and booleans
// from the model are sent as text.
function asActorInput(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(compact(args))) {
    out[k] = typeof v === "number" || typeof v === "boolean" ? String(v) : v;
  }
  return out;
}

const server = new McpServer({
  name: "mamba-google-sheets-import-export",
  version: pkg.version,
});

// Google Sheets Import and Export (immutable actor ID 0VT1IaI5S3lIllONL). Every buyer facing input of the actor is exposed.
server.registerTool(
  "google_sheets_import_export",
  {
    title: "Read or write a Google Sheet",
    description:
      "Read a Google Sheet into rows, or write rows into a Google Sheet. Modes: read (one row per sheet row, keyed by the header row), append, replace (clear the tab, then write), and upsert (update rows whose key_column value already exists, add the rest). Writes need the buyer's own Google credential: a service account key JSON with the sheet shared to its client_email, or an OAuth refresh token with its client, or an OAuth access token. A sheet shared as anyone with the link reads with no credential. Pay per event on Apify: 0.01 USD per block of up to 100 rows written, 0.005 USD per block of up to 100 rows read.",
    annotations: {
      title: "Read or write a Google Sheet",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      mode: z.enum(["read","append","replace","upsert"]).optional().describe("read (default): the sheet becomes one dataset row per sheet row. append: add rows after the last row. replace: clear the tab, then write the rows. upsert: overwrite the rows whose key_column value is already in the sheet and add the rest. The three write modes need a credential below."),
      spreadsheet: z.string().optional().describe("The Google Sheets URL as copied from the browser, or the spreadsheet ID. A #gid= in the URL picks that tab."),
      sheet: z.string().optional().describe("Optional. The tab name, or its gid number. Default: the gid in the URL, else the first tab. In a write mode a tab name that does not exist is created."),
      range: z.string().optional().describe("Optional, read mode. An A1 range without the tab name, for example A1:F500 or B:D. Default: the whole tab."),
      header_row: z.boolean().optional().describe("true (default) or false. When true, read rows are keyed by the header row, and writes match your row keys to the header columns and add new columns at the end. When false, read rows are keyed by column letter and writes go column by column in key order."),
      dataset_id: z.string().optional().describe("Write modes. The Apify dataset whose items go into the sheet, for example the default dataset of another run. In an Apify integration, pass the triggering run's resource.defaultDatasetId variable. Fields starting with # are skipped."),
      rows: z.array(z.string()).optional().describe("Write modes, instead of a dataset. A JSON list of objects, one per sheet row, for example [{\"name\": \"Ann\", \"email\": \"ann@example.com\"}]."),
      columns: z.array(z.string()).optional().describe("Optional, write modes. Only these keys are written, in this order. Default: every key in the rows, in first seen order."),
      key_column: z.string().optional().describe("Upsert mode. The column whose value identifies a row, for example email or url. A row whose value is already in that column is overwritten in place; the rest are added. Rows with no value in it are skipped."),
      value_input: z.enum(["raw","user_entered"]).optional().describe("raw (default): every value is stored exactly as given, so text starting with = is not run as a formula. user_entered: Google parses values as if typed, so formulas run and dates and numbers are converted."),
      max_rows: z.number().optional().describe("Most rows to read or write in this run, 1 to 1,000,000 (default 100,000)."),
      service_account_json: z.string().optional().describe("Your own service account key file, pasted whole. Share the spreadsheet with its client_email as an Editor (Viewer to read). It is sent only to Google and is never stored, logged, or written to a row."),
      oauth_refresh_token: z.string().optional().describe("Instead of a service account: a refresh token from your own Google OAuth client with the spreadsheets scope. Needs oauth_client_id and oauth_client_secret from the same client."),
      oauth_client_id: z.string().optional().describe("The client ID that issued the refresh token."),
      oauth_client_secret: z.string().optional().describe("The client secret that issued the refresh token."),
      oauth_access_token: z.string().optional().describe("Instead of the above: a current OAuth access token with the spreadsheets scope. It expires in about an hour, so it suits a single run."),
      max_charge_usd: z.string().optional().describe("Optional. The run stops before a charge that would pass this amount, and never writes a block of rows it could not charge. Summary rows are always returned."),
    },
  },
  async (args) => runActor("0VT1IaI5S3lIllONL", "Google Sheets Import and Export", asActorInput(args as Record<string, unknown>)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
