import { syncNotionDataSource } from "./sync";

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health") {
			return Response.json({ ok: true, service: "notion-to-hindsight-sync" });
		}
		if (url.pathname === "/sync") {
			try {
				const summary = await syncNotionDataSource(env);
				return Response.json({
					message: "Notion to Hindsight sync completed",
					...summary,
				});
			} catch (error) {
				console.error(
					JSON.stringify({
						message: "Notion to Hindsight sync failed",
						error: error instanceof Error ? error.message : String(error),
					})
				);
				return Response.json(
					{
						error: error instanceof Error ? error.message : String(error),
					},
					{ status: 500 }
				);
			}
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
