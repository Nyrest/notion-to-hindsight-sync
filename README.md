[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Nyrest/notion-to-hindsight-sync)

# Notion → Hindsight sync

One Cloudflare Worker instance synchronizes one Notion data source to one Hindsight bank. It keeps the last Notion `last_edited_time` in Hindsight metadata, so unchanged pages are skipped.

## Configure

For local development, copy `.dev.vars.example` to `.dev.vars`, fill in `NOTION_TOKEN`, and add the three non-secret variables below. Hindsight API authentication is optional; omit `HINDSIGHT_API_KEY` when the Hindsight server allows unauthenticated access. For deployment, set the non-secret variables in `wrangler.jsonc`:

- `NOTION_DATA_SOURCE_ID`
- `HINDSIGHT_BASE_URL`
- `HINDSIGHT_BANK_ID`

Set the required secret with Wrangler:

```bash
npx wrangler secret put NOTION_TOKEN
# Only when the Hindsight server requires authentication:
npx wrangler secret put HINDSIGHT_API_KEY
```

## Run

```bash
npm install
npm run cf-typegen
npm run typecheck
npm test
npm run dev
npm run deploy
```

The default Cron trigger runs hourly at minute zero. Change `triggers.crons` in `wrangler.jsonc` if needed.

Each run fetches the Notion and Hindsight inventories in parallel, compares document IDs and the stored Notion revision, retrieves Markdown only for new or changed pages, submits changed pages to Hindsight with async batch retain, and deletes documents that no longer exist in Notion.
