import { syncNotionDataSource } from "./sync";

export default {
	async fetch(request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health") {
			return Response.json({ ok: true, service: "notion-to-hindsight-sync" });
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},

	async scheduled(controller, env): Promise<void> {
		try {
			const summary = await syncNotionDataSource(env);
			console.log(
				JSON.stringify({
					message: "Notion to Hindsight sync completed",
					cron: controller.cron,
					...summary,
				})
			);
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "Notion to Hindsight sync failed",
					error: error instanceof Error ? error.message : String(error),
					cron: controller.cron,
				})
			);
			throw error;
		}
	},
} satisfies ExportedHandler<Env>;
