import { getSyncTargets } from "./config";
import { NotionHindsightSyncWorkflow } from "./workflow";

export { NotionHindsightSyncWorkflow };

export default {
	async fetch(request): Promise<Response> {
		if (new URL(request.url).pathname === "/health") {
			return Response.json({ ok: true, service: "notion-to-hindsight-sync" });
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	},
	async scheduled(controller, env): Promise<void> {
		const targets = getSyncTargets(env);
		await env.NOTION_HINDSIGHT_SYNC.createBatch(
			targets.map((target) => ({
				id: `${target.key}-${controller.scheduledTime}`,
				params: { targetKey: target.key },
			}))
		);
	},
} satisfies ExportedHandler<Env>;
