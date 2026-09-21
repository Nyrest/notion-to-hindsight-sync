import { NotionHindsightSyncWorkflow } from "./workflow";

export { NotionHindsightSyncWorkflow };

export default {
	async fetch(request): Promise<Response> {
		if (new URL(request.url).pathname === "/health") {
			return Response.json({ ok: true, service: "notion-to-hindsight-sync" });
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
