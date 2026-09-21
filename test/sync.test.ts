import { describe, expect, it } from "vitest";
import { diffInventories, type NotionInventoryPage } from "../src/sync";

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
