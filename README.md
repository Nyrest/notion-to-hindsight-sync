[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Nyrest/notion-to-hindsight-sync)

# Notion → Hindsight sync

One Cloudflare Worker instance synchronizes one Notion data source to one Hindsight bank. It keeps the last Notion `last_edited_time` in Hindsight metadata, so unchanged pages are skipped.

## Configure

For local development, copy `.dev.vars.example` to `.dev.vars`, fill in `NOTION_TOKEN`, and add the three non-secret variables below. Hindsight API authentication is optional; omit `HINDSIGHT_API_KEY` when the Hindsight server allows unauthenticated access. If Hindsight is behind Cloudflare Access, optionally configure `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`; both headers are sent to Hindsight only when their values are configured. For deployment, set the non-secret variables in `wrangler.jsonc`:

- `NOTION_DATA_SOURCE_ID`
- `HINDSIGHT_BASE_URL`
- `HINDSIGHT_BANK_ID`

Set secrets with Wrangler:

```bash
# Required:
npx wrangler secret put NOTION_TOKEN
# Optional, when the Hindsight server requires authentication:
npx wrangler secret put HINDSIGHT_API_KEY
# Optional, when Hindsight is behind Cloudflare Access:
npx wrangler secret put CF_ACCESS_CLIENT_ID
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
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

For a manual online test, open `https://<your-worker-url>/sync` in a browser or call it with `curl`. The request waits for the full sync and returns its summary. This endpoint intentionally has no authentication, you'll need to set up a Cloudflare Access policy if you want to restrict access.

Each run fetches the Notion and Hindsight inventories in parallel, compares document IDs and the stored Notion revision, retrieves Markdown only for new or changed pages, submits changed pages to Hindsight with async batch retain, and deletes documents that no longer exist in Notion.
