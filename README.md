[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Nyrest/notion-to-hindsight-sync)

# Notion → Hindsight sync

One Cloudflare Workflow synchronizes one Notion data source to one Hindsight bank. It stores the Notion `last_edited_time` in Hindsight metadata, so unchanged pages are skipped.

## Configure

All connection settings are confidential and must stay out of version control. Set these required values in your ignored `.dev.vars` file locally, and as Wrangler secrets when deploying:

- `NOTION_DATA_SOURCE_ID`
- `HINDSIGHT_BASE_URL`
- `HINDSIGHT_BANK_ID`
- `NOTION_TOKEN`

For local development, copy `.dev.vars.example` to `.dev.vars` and replace every required placeholder. `HINDSIGHT_API_KEY`, `CF_ACCESS_CLIENT_ID`, and `CF_ACCESS_CLIENT_SECRET` remain optional.

For deployment, set secrets with Wrangler:

```bash
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put NOTION_DATA_SOURCE_ID
npx wrangler secret put HINDSIGHT_BASE_URL
npx wrangler secret put HINDSIGHT_BANK_ID
# Optional when Hindsight requires bearer authentication:
npx wrangler secret put HINDSIGHT_API_KEY
# Optional when Hindsight is behind Cloudflare Access:
npx wrangler secret put CF_ACCESS_CLIENT_ID
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
```

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

The `notion-hindsight-sync` Workflow runs hourly at minute zero. It submits retain batches in order, waits until every Hindsight operation succeeds, then re-scans both inventories before deleting documents no longer present in Notion.

Trigger a manual run and inspect it with Wrangler:

```bash
npx wrangler workflows trigger notion-hindsight-sync
npx wrangler workflows instances list notion-hindsight-sync
npx wrangler workflows instances describe notion-hindsight-sync <instance-id>
```

The Worker exposes only `GET /health`; it has no public sync trigger.
