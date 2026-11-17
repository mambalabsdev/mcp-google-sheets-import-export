# Google Sheets Import and Export MCP Server

[![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-google-sheets-import-export)](https://www.npmjs.com/package/@mambalabsdev/mcp-google-sheets-import-export) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-google-sheets-import-export)](https://github.com/mambalabsdev/mcp-google-sheets-import-export/blob/main/LICENSE)

An MCP server for the Mamba Labs Google Sheets Import and Export actor on Apify. Google Sheets in and out of Apify, on your own Google credentials.

## What's Inside

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Example prompts](#example-prompts)
- [Tool](#tool)
- [Inputs](#inputs)
- [Pricing](#pricing)
- [Full actor documentation](#full-actor-documentation)
- [License](#license)

## What it does

Give a Google Sheet URL. In read mode the actor returns one row per sheet row, keyed by the header row. In append, replace, or upsert mode it writes the items of an Apify dataset, or a list of rows you pass, into the sheet: it adds new columns to the header as they appear, and in upsert mode it updates the rows whose key column value already exists. Writes use your own Google service account key or OAuth token. A sheet shared as anyone with the link reads with no credential.

All of the work runs on Apify. This package is a thin client that starts the actor run, waits for it, and hands back the dataset rows.

## Quick start

You need Node.js 18 or newer and an Apify account with an API token.

Add this to your Claude Desktop config (`claude_desktop_config.json`), Cursor, or any MCP client:

```json
{
  "mcpServers": {
    "mamba-google-sheets-import-export": {
      "command": "npx",
      "args": [
        "-y",
        "@mambalabsdev/mcp-google-sheets-import-export"
      ],
      "env": {
        "APIFY_TOKEN": "your-apify-token"
      }
    }
  }
}
```

Restart the client. The `google_sheets_import_export` tool appears.

## Prerequisites

- Node.js 18 or newer.
- An Apify API token from [console.apify.com/account/integrations](https://console.apify.com/account/integrations), set as `APIFY_TOKEN`. The server lists its tool without a token; a call needs one.

## Example prompts

- "Read this Google Sheet and give me the rows as JSON."
- "Append these 50 leads to my Google Sheet, matching the existing columns."
- "Update the rows in my sheet whose email matches, and add the new ones."

## Tool

`google_sheets_import_export`. One tool. Example arguments:

```json
{
  "mode": "read",
  "spreadsheet": "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0"
}
```

## Inputs

Every buyer facing input of the actor. Omitted inputs take the actor's own defaults.

| Input | Type | Required | Description |
|---|---|---|---|
| `mode` | string | no | read (default): the sheet becomes one dataset row per sheet row. append: add rows after the last row. replace: clear the tab, then write the rows. upsert: overwrite the rows whose key_column value is already in the sheet and add the rest. The three write modes need a credential below. |
| `spreadsheet` | string | no | The Google Sheets URL as copied from the browser, or the spreadsheet ID. A #gid= in the URL picks that tab. |
| `sheet` | string | no | Optional. The tab name, or its gid number. Default: the gid in the URL, else the first tab. In a write mode a tab name that does not exist is created. |
| `range` | string | no | Optional, read mode. An A1 range without the tab name, for example A1:F500 or B:D. Default: the whole tab. |
| `header_row` | boolean | no | true (default) or false. When true, read rows are keyed by the header row, and writes match your row keys to the header columns and add new columns at the end. When false, read rows are keyed by column letter and writes go column by column in key order. |
| `dataset_id` | string | no | Write modes. The Apify dataset whose items go into the sheet, for example the default dataset of another run. In an Apify integration, pass the triggering run's resource.defaultDatasetId variable. Fields starting with # are skipped. |
| `rows` | array | no | Write modes, instead of a dataset. A JSON list of objects, one per sheet row, for example [{"name": "Ann", "email": "ann@example.com"}]. |
| `columns` | array | no | Optional, write modes. Only these keys are written, in this order. Default: every key in the rows, in first seen order. |
| `key_column` | string | no | Upsert mode. The column whose value identifies a row, for example email or url. A row whose value is already in that column is overwritten in place; the rest are added. Rows with no value in it are skipped. |
| `value_input` | string | no | raw (default): every value is stored exactly as given, so text starting with = is not run as a formula. user_entered: Google parses values as if typed, so formulas run and dates and numbers are converted. |
| `max_rows` | number | no | Most rows to read or write in this run, 1 to 1,000,000 (default 100,000). |
| `service_account_json` | string | no | Your own service account key file, pasted whole. Share the spreadsheet with its client_email as an Editor (Viewer to read). It is sent only to Google and is never stored, logged, or written to a row. |
| `oauth_refresh_token` | string | no | Instead of a service account: a refresh token from your own Google OAuth client with the spreadsheets scope. Needs oauth_client_id and oauth_client_secret from the same client. |
| `oauth_client_id` | string | no | The client ID that issued the refresh token. |
| `oauth_client_secret` | string | no | The client secret that issued the refresh token. |
| `oauth_access_token` | string | no | Instead of the above: a current OAuth access token with the spreadsheets scope. It expires in about an hour, so it suits a single run. |
| `max_charge_usd` | string | no | Optional. The run stops before a charge that would pass this amount, and never writes a block of rows it could not charge. Summary rows are always returned. |

## Pricing

Pay per event on Apify, billed to your Apify account. Prices in USD.

| Event | Free plan | Bronze | Silver | Gold |
|---|---|---|---|---|
| `rows-written`, one block of up to 100 rows written to your sheet | $0.01 | $0.0095 | $0.009 | $0.0085 |
| `rows-read`, one block of up to 100 sheet rows read into the dataset | $0.005 | $0.00475 | $0.0045 | $0.00425 |
| `apify-actor-start`, per run start | $0.002 | $0.002 | $0.002 | $0.002 |

Empty, refused, and failed reads and writes, the summary row, and refused input are free. Mamba Labs pays the platform costs of the run. Mamba Labs pays the platform costs of the run, Apify proxy traffic included.

## Full actor documentation

[apify.com/mambalabs/google-sheets-import-export](https://apify.com/mambalabs/google-sheets-import-export)

## License

MIT. See [LICENSE](LICENSE).
