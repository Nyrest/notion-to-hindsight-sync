[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Nyrest/notion-to-hindsight-sync)

# Notion → Hindsight sync

Each hourly Cron run creates one Cloudflare Workflow instance per configured Notion data source → Hindsight bank target. It stores the Notion `last_edited_time` in Hindsight metadata, so unchanged pages are skipped.

## Configure

All connection settings are confidential and must stay out of version control. Set these required values in your ignored `.dev.vars` file locally, and as Wrangler secrets when deploying:

- `HINDSIGHT_BASE_URL`
- `NOTION_TOKEN`
- `SYNC_TARGETS`

For local development, copy `.dev.vars.example` to `.dev.vars` and replace every required placeholder. `HINDSIGHT_API_KEY`, `CF_ACCESS_CLIENT_ID`, and `CF_ACCESS_CLIENT_SECRET` remain optional.

For deployment, set secrets with Wrangler:

```bash
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put HINDSIGHT_BASE_URL
npx wrangler secret put SYNC_TARGETS
# Optional when Hindsight requires bearer authentication:
npx wrangler secret put HINDSIGHT_API_KEY
# Optional when Hindsight is behind Cloudflare Access:
npx wrangler secret put CF_ACCESS_CLIENT_ID
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
```

`SYNC_TARGETS` is a JSON array. Each item defines one isolated Workflow instance and its Notion data source → Hindsight bank mapping:

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
		"hindsightBankId": "another_hindsight_bank_id"
	}
]
```

`key` must be unique and contain only letters, numbers, underscores, or hyphens. The Worker passes only this key to each Workflow; the data source and bank IDs remain in the `SYNC_TARGETS` secret. One Cron run supports up to 100 targets.

To migrate an existing deployment, move the former `NOTION_DATA_SOURCE_ID` and `HINDSIGHT_BANK_ID` values into one `SYNC_TARGETS` item before deploying. Those two single-target secrets are no longer read; after a successful deployment they may be removed from Cloudflare.

## Run

```bash
npm install
# Copy and configure .dev.vars before generating types.
npm run cf-typegen
npm run typecheck
npm test
npm run dev
npm run deploy
```

The Worker runs hourly at minute zero and uses `createBatch()` to create one `notion-hindsight-sync` Workflow instance for every target. Instances have IDs such as `personal-<scheduledTime>`, so logs, retries, and results are separate by target. The Workflow concurrency limit remains `1` to preserve the existing per-token Notion request pacing; additional instances queue until the prior instance completes.

Each instance submits retain batches in order, skips pages whose Markdown is empty or whitespace-only, waits until every Hindsight operation succeeds, then re-scans both inventories before deleting documents no longer present in its Notion data source. The completion log reports skipped pages as `skippedEmpty`.

Every retained document appends the original Notion page-property JSON to its content, preserving date ranges, time zones, select values, relations, people, formulas, and other Notion property types for Hindsight to process. Its Hindsight `timestamp` is the Notion page's `last_edited_time`; metadata remains limited to `notion_last_edited_time` for sync bookkeeping.

Trigger a manual run and inspect it with Wrangler:

```bash
npx wrangler workflows trigger notion-hindsight-sync '{"targetKey":"personal"}'
# Force an upsert for every existing document in this target:
npx wrangler workflows trigger notion-hindsight-sync '{"targetKey":"personal","force_replace":true}'
npx wrangler workflows instances list notion-hindsight-sync
npx wrangler workflows instances describe notion-hindsight-sync <instance-id>
```

`force_replace` is optional and defaults to `false`. When `true`, every page already present in Hindsight is retained again even when its `last_edited_time` is unchanged. New and deleted documents use the normal diff behavior.

The Worker exposes only `GET /health`; it has no public sync trigger.
