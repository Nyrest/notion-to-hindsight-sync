import { describe, expect, it } from "vitest";
import worker from "../src/index";
import {
	diffInventories,
	HINDSIGHT_INVENTORY_PAGE_SIZE,
	HINDSIGHT_OPERATION_POLL_MS,
	listNotionPages,
	NOTION_PAGE_SIZE,
	operationIdFor,
	RETAIN_BATCH_SIZE,
	type HindsightOperationClient,
	type HindsightOperationStatus,
	type NotionInventoryPage,
	waitForRetainOperations,
} from "../src/sync";

const page = (id: string, lastEditedTime: string): NotionInventoryPage => ({
	id,
	lastEditedTime,
	title: id,
});

describe("diffInventories", () => {
	it("classifies create, update, delete, and unchanged documents", () => {
		const result = diffInventories(
			[page("same", "2026-09-21T00:00:00.000Z"), page("new", "2026-09-21T01:00:00.000Z")],
			[
				{
					id: "notion_page:same",
					document_metadata: { notion_last_edited_time: "2026-09-21T00:00:00.000Z" },
				},
				{ id: "stale", document_metadata: { notion_last_edited_time: "old" } },
			]
		);

		expect(result.create.map((item) => item.id)).toEqual(["new"]);
		expect(result.update).toEqual([]);
		expect(result.delete).toEqual(["stale"]);
		expect(result.unchanged).toBe(1);
	});

	it("marks a document without stored revision metadata for update", () => {
		const result = diffInventories(
			[page("page", "2026-09-21T00:00:00.000Z")],
			[{ id: "notion_page:page" }]
		);

		expect(result.update.map((item) => item.id)).toEqual(["page"]);
	});
});

describe("sync configuration", () => {
	it("uses separate page sizes for Notion and Hindsight", async () => {
		let query: Record<string, unknown> | undefined;
		const notion = {
			dataSources: {
				query: async (input: Record<string, unknown>) => {
					query = input;
					return { results: [], has_more: false };
				},
			},
		};

		await listNotionPages(notion as never, "source", async () => {});

		expect(query).toMatchObject({ page_size: 100, result_type: "page" });
		expect(NOTION_PAGE_SIZE).toBe(100);
		expect(HINDSIGHT_INVENTORY_PAGE_SIZE).toBe(250);
		expect(RETAIN_BATCH_SIZE).toBe(25);
	});
});

describe("Hindsight operation handling", () => {
	it("derives a stable, valid UUID for the same workflow batch", async () => {
		const pages = [page("second", "2026-09-21T01:00:00.000Z"), page("first", "2026-09-21T00:00:00.000Z")];
		const first = await operationIdFor("workflow-a", pages);
		const reordered = await operationIdFor("workflow-a", [...pages].reverse());
		const anotherWorkflow = await operationIdFor("workflow-b", pages);

		expect(first).toBe(reordered);
		expect(first).not.toBe(anotherWorkflow);
		expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	it("waits for all operations to complete before continuing", async () => {
		const statuses = ["pending", "processing", "completed"] as const;
		let reads = 0;
		const waits: number[] = [];
		const client: HindsightOperationClient = {
			async getOperationStatus() {
				const status = statuses[Math.min(reads++, statuses.length - 1)];
				return { status } as HindsightOperationStatus;
			},
			async retryOperation() {
				throw new Error("retry should not be called");
			},
		};

		await waitForRetainOperations(client, ["operation"], async (duration) => {
			waits.push(duration);
		});

		expect(reads).toBe(3);
		expect(waits).toEqual([HINDSIGHT_OPERATION_POLL_MS, HINDSIGHT_OPERATION_POLL_MS]);
	});

	it("retries a failed operation three times and then fails without completing", async () => {
		let retries = 0;
		const client: HindsightOperationClient = {
			async getOperationStatus() {
				return {
					operation_id: "operation",
					status: "failed",
					retry_count: retries,
				} as HindsightOperationStatus;
			},
			async retryOperation() {
				retries += 1;
			},
		};

		await expect(
			waitForRetainOperations(client, ["operation"], async () => {})
		).rejects.toThrow("failed after 3 retries");
		expect(retries).toBe(3);
	});
});

describe("HTTP surface", () => {
	it("keeps health public and removes the sync trigger", async () => {
		const health = await worker.fetch(new Request("https://worker.example/health"));
		const sync = await worker.fetch(new Request("https://worker.example/sync"));

		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ ok: true, service: "notion-to-hindsight-sync" });
		expect(sync.status).toBe(404);
	});
});
