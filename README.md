<div align="center">
  <h1>Notion → Hindsight Sync</h1>
  <p>Keep your Hindsight memory banks in sync with Notion, automatically.</p>
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/Nyrest/notion-to-hindsight-sync">
    <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare">
  </a>
</div>

Sync Notion page Markdown and properties into Hindsight every hour. Built on Cloudflare Workers and Workflows.

[Features](#features) · [Quick start](#quick-start) · [Configuration](#configuration) · [Deployment](#deployment) · [Usage](#usage) · [Development](#development)

## Features

- 🔄 **Incremental sync** — Create new documents, update edited pages, and skip unchanged pages using Notion's `last_edited_time`.
- 🗂️ **Multiple targets** — Map multiple Notion data sources to Hindsight banks, with separate logs, retries, and results per target.
- 📄 **Markdown and properties** — Retain page content alongside the original property JSON, including dates, relations, people, and formulas.
- 🧹 **Deletion sync** — Remove matching documents that are no longer in Notion.
- 🔨 **Highly Compatible** — Work with existing memory bank without affecting existing records.
- ⚙️ **Flexible configuration** — Support Hindsight bearer authentication, Cloudflare Access service tokens, and optional per-target retain strategies.

## Quick start

### 1. Prepare your accounts

You will need:

- **Node.js 22 or later** and npm.
- **A Cloudflare account** for deploying the Worker and Workflow.
- **A Notion integration token** with read access to each database you want to sync. Share those databases with the integration and obtain their **data source IDs**.
- **A running Hindsight instance** and the bank IDs you want to sync into.

### 2. Install and configure

```bash
git clone https://github.com/Nyrest/notion-to-hindsight-sync.git
cd notion-to-hindsight-sync
npm ci
cp .dev.vars.example .dev.vars
```

In PowerShell, use `Copy-Item .dev.vars.example .dev.vars` for the copy step.

Edit `.dev.vars` and replace the three required placeholders: `NOTION_TOKEN`, `HINDSIGHT_BASE_URL`, and `SYNC_TARGETS`. See the [environment variables](#environment-variables) and [target example](#sync-targets) below. Add optional credentials if your Hindsight instance requires them.

### 3. Run locally

```bash
npm run cf-typegen
npm run dev
```

Generate types after configuring `.dev.vars`. To run a local sync, follow the [local Workflow example](#local-workflow) below. When you are ready to run on a schedule, continue to [Deployment](#deployment).

## Configuration

### Environment variables

Use the ignored `.dev.vars` file for local development and **Wrangler secrets** for deployment. Keep connection settings and credentials out of version control.

| Name | Required | Description |
| --- | :---: | --- |
| `NOTION_TOKEN` | ✅ | Notion integration token with read access to the configured data sources and their pages. |
| `HINDSIGHT_BASE_URL` | ✅ | Base URL of your Hindsight instance, such as `https://hindsight.example.com`. Must use HTTP or HTTPS. |
| `SYNC_TARGETS` | ✅ | JSON array of Notion data source → Hindsight bank mappings. See [Sync targets](#sync-targets). |
| `HINDSIGHT_API_KEY` | — | Bearer API key. Set this when your Hindsight instance requires bearer authentication. |
| `CF_ACCESS_CLIENT_ID` | — | Cloudflare Access service token client ID. Set together with `CF_ACCESS_CLIENT_SECRET` when Hindsight is behind Access. |
| `CF_ACCESS_CLIENT_SECRET` | — | Cloudflare Access service token client secret. Set together with `CF_ACCESS_CLIENT_ID` when Hindsight is behind Access. |

✅ = required for every deployment; — = optional, depending on your Hindsight authentication setup.

### Sync targets

`SYNC_TARGETS` is a non-empty JSON array with **up to 100 targets**. Each target maps one Notion data source to one Hindsight bank:

```json
[
  {
    "key": "personal",
    "notionDataSourceId": "notion_data_source_id",
    "hindsightBankId": "hindsight_bank_id"
  },
  {
    "key": "research",
    "notionDataSourceId": "another_notion_data_source_id",
    "hindsightBankId": "another_hindsight_bank_id",
    "retainStrategy": "documents"
  }
]
```

| Name | Required | Description |
| --- | :---: | --- |
| `key` | ✅ | Unique target name used in manual triggers and scheduled Workflow IDs. Use 1–86 letters, numbers, underscores, or hyphens. |
| `notionDataSourceId` | ✅ | Notion **data source ID**, rather than the parent database ID. |
| `hindsightBankId` | ✅ | Destination Hindsight bank ID. |
| `retainStrategy` | — | Non-empty strategy name configured for the destination bank. Omit it to use the bank's default retain strategy. |

In `.dev.vars`, store the JSON on one line inside single quotes, as shown in [.dev.vars.example](.dev.vars.example). For `wrangler secret put SYNC_TARGETS`, paste the single-line JSON array directly at the prompt, without surrounding shell quotes.

## Deployment

Use the **Deploy to Cloudflare** button above, or deploy from your local checkout:

### 1. Log in and add required secrets

```bash
npx wrangler login
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put HINDSIGHT_BASE_URL
npx wrangler secret put SYNC_TARGETS
```

Each `secret put` command prompts for its value. On a first deployment, Wrangler may also prompt to create the Worker; accept that prompt to add its secrets.

### 2. Add authentication secrets if needed

For Hindsight bearer authentication:

```bash
npx wrangler secret put HINDSIGHT_API_KEY
```

For Hindsight behind Cloudflare Access:

```bash
npx wrangler secret put CF_ACCESS_CLIENT_ID
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
```

If your instance uses both, configure both sets of credentials.

### 3. Deploy

```bash
npm run deploy
```

The schedule is already configured in [wrangler.jsonc](wrangler.jsonc) as `0 * * * *`. After deployment, trigger a [manual run](#manual-sync) to check your configuration without waiting for the next hour.

## Usage

### Manual sync

Replace `personal` with a `key` from your `SYNC_TARGETS` configuration:

```bash
npx wrangler workflows trigger notion-hindsight-sync '{"targetKey":"personal"}'
```

To retain every existing page again, including pages whose `last_edited_time` has not changed:

```bash
npx wrangler workflows trigger notion-hindsight-sync '{"targetKey":"personal","force_replace":true}'
```

`force_replace` defaults to `false`. New pages and deletions are processed normally in either mode.

### Check progress

```bash
npx wrangler workflows instances list notion-hindsight-sync
npx wrangler workflows instances describe notion-hindsight-sync <instance-id>
```

Replace `<instance-id>` with the ID returned by the trigger command or instance list. Scheduled IDs look like `personal-<scheduledTime>`.

Completion logs include the target, Workflow instance ID, `created`, `updated`, `unchanged`, `retained`, `skippedEmpty`, `deleted`, and `durationMs`. Failure logs include the phase and error message.

### Health check

Request `GET /health` on the deployed Worker URL to receive:

```json
{"ok":true,"service":"notion-to-hindsight-sync"}
```

This endpoint confirms the Worker responds; use Workflow status to check sync progress. Manual syncs are triggered through Wrangler, with no public HTTP sync endpoint.

## How syncing works

1. **Compare inventories.** Read Notion pages and Hindsight documents tagged with both `source:notion` and `datasource_id:<data-source-id>`. Compare `last_edited_time` with the stored `notion_last_edited_time` metadata.
2. **Retain changes.** Fetch Markdown for new or edited pages, append the original Notion page-property JSON, and trim the final content. Pages with empty Markdown are still retained when their properties provide content; only empty final content is skipped.
3. **Wait for completion.** Submit retain batches in order and wait for their Hindsight operations to succeed, retrying failed operations up to the configured limit.
4. **Sync deletions.** Re-scan both inventories, then delete matching Hindsight documents whose pages are no longer in the Notion data source.

Retained documents use `notion_page:<page-id>` as their ID and the Notion page's `last_edited_time` as their Hindsight `timestamp`. Metadata contains only `notion_last_edited_time` for sync bookkeeping; page properties are preserved in the document content.

Each target has its own Workflow instance. The configured concurrency limit is **1**, so additional instances queue until the active instance completes, preserving Notion request pacing.

## Development

After configuring `.dev.vars`, run the local checks:

```bash
npm run cf-typegen
npm run typecheck
npm test
```

### Local Workflow

With `npm run dev` running, trigger and inspect a Workflow from another terminal:

```bash
npx wrangler workflows trigger notion-hindsight-sync '{"targetKey":"personal"}' --local
npx wrangler workflows instances list notion-hindsight-sync --local
npx wrangler workflows instances describe notion-hindsight-sync <instance-id> --local
```

Local runs use `.dev.vars` and sync with the configured Notion data sources and Hindsight banks.
