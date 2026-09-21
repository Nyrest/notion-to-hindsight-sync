import { Client as NotionClient, type PageObjectResponse, type QueryDataSourceResponse } from "@notionhq/client";
import {
	createClient,
	createConfig,
	HindsightClient,
	sdk,
	type ListDocumentsResponse,
	type MemoryItemInput,
} from "@vectorize-io/hindsight-client";

const NOTION_API_VERSION = "2026-03-11";
const INVENTORY_PAGE_SIZE = 250;
const RETAIN_BATCH_SIZE = 25;
const RETAIN_METADATA_REVISION = "notion_last_edited_time";
const SOURCE_TAG = "source:notion";

type HindsightTransport = ReturnType<typeof createClient>;
type HindsightInventoryDocument = ListDocumentsResponse["items"][number];

export type NotionInventoryPage = {
	id: string;
	lastEditedTime: string;
};

export type SyncDiff = {
	create: NotionInventoryPage[];
	update: NotionInventoryPage[];
	delete: string[];
	unchanged: number;
};

export type SyncSummary = SyncDiff & {
	retained: number;
	deleted: number;
	retainOperations: string[];
	durationMs: number;
};

type RetainDocument = NotionInventoryPage & {
	content: string;
};

type SyncConfig = {
	notionDataSourceId: string;
	hindsightBaseUrl: string;
	hindsightBankId: string;
	hindsightApiKey?: string;
	notionToken: string;
	documentTags: string[];
};

function required(value: string | undefined, name: string): string {
	const normalized = value?.trim();
	if (!normalized) throw new Error(`${name} is not configured`);
	return normalized;
}

function getSyncConfig(env: Env): SyncConfig {
	const notionDataSourceId = required(env.NOTION_DATA_SOURCE_ID, "NOTION_DATA_SOURCE_ID");
	const hindsightBaseUrl = required(env.HINDSIGHT_BASE_URL, "HINDSIGHT_BASE_URL").replace(/\/+$/, "");
	const hindsightBankId = required(env.HINDSIGHT_BANK_ID, "HINDSIGHT_BANK_ID");
	const hindsightApiKey = (env as Env & { HINDSIGHT_API_KEY?: string }).HINDSIGHT_API_KEY?.trim() || undefined;
	const notionToken = required(env.NOTION_TOKEN, "NOTION_TOKEN");

	const parsedBaseUrl = new URL(hindsightBaseUrl);
	if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
		throw new Error("HINDSIGHT_BASE_URL must use http or https");
	}

	return {
		notionDataSourceId,
		hindsightBaseUrl,
		hindsightBankId,
		hindsightApiKey,
		notionToken,
		documentTags: [SOURCE_TAG, `datasource_id:${notionDataSourceId}`],
	};
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function requireSdkData<T>(
	response: { data?: T; error?: unknown; response?: Response },
	operation: string
): T {
	if (response.data === undefined) {
		const status = response.response?.status;
		const statusText = status === undefined ? "" : ` (HTTP ${status})`;
		throw new Error(`${operation} failed${statusText}: ${describeError(response.error)}`);
	}
	return response.data;
}

function isFullNotionPage(
	result: QueryDataSourceResponse["results"][number]
): result is PageObjectResponse {
	return (
		result.object === "page" &&
		"last_edited_time" in result &&
		typeof result.last_edited_time === "string"
	);
}

async function listNotionPages(
	notion: NotionClient,
	dataSourceId: string
): Promise<NotionInventoryPage[]> {
	const pages: NotionInventoryPage[] = [];
	let nextCursor: string | null = null;

	while (true) {
		const response = await notion.dataSources.query({
			data_source_id: dataSourceId,
			page_size: INVENTORY_PAGE_SIZE,
			result_type: "page",
			...(nextCursor ? { start_cursor: nextCursor } : {}),
		});

		if (response.request_status?.type === "incomplete") {
			throw new Error(
				`Notion data source query was incomplete: ${response.request_status.incomplete_reason ?? "unknown reason"}`
			);
		}

		for (const result of response.results) {
			if (result.object !== "page") continue;
			if (!isFullNotionPage(result)) {
				throw new Error(`Notion returned page ${result.id} without last_edited_time`);
			}
			pages.push({ id: result.id, lastEditedTime: result.last_edited_time });
		}

		if (!response.has_more) return pages;
		if (!response.next_cursor) throw new Error("Notion returned has_more without next_cursor");
		nextCursor = response.next_cursor;
	}
}

async function listHindsightDocuments(
	transport: HindsightTransport,
	bankId: string,
	documentTags: string[]
): Promise<HindsightInventoryDocument[]> {
	const documents: HindsightInventoryDocument[] = [];
	let offset = 0;

	while (true) {
		const response = await sdk.listDocuments({
			client: transport,
			path: { bank_id: bankId },
			query: {
				tags: documentTags,
				tags_match: "all_strict",
				limit: INVENTORY_PAGE_SIZE,
				offset,
			},
		});
		const data = requireSdkData(response, "Hindsight listDocuments");
		documents.push(...data.items);
		offset += data.items.length;

		if (data.items.length === 0 || offset >= data.total) return documents;
	}
}

function revisionOf(document: HindsightInventoryDocument): string | null {
	const revision = document.document_metadata?.[RETAIN_METADATA_REVISION];
	return typeof revision === "string" ? revision : null;
}

export function diffInventories(
	notionPages: readonly NotionInventoryPage[],
	hindsightDocuments: readonly HindsightInventoryDocument[]
): SyncDiff {
	const notionById = new Map(notionPages.map((page) => [page.id, page]));
	const hindsightById = new Map(hindsightDocuments.map((document) => [document.id, document]));
	const create: NotionInventoryPage[] = [];
	const update: NotionInventoryPage[] = [];

	for (const page of notionById.values()) {
		const document = hindsightById.get(page.id);
		if (!document) {
			create.push(page);
		} else if (revisionOf(document) !== page.lastEditedTime) {
			update.push(page);
		}
	}

	const deleted = hindsightDocuments
		.filter((document) => !notionById.has(document.id))
		.map((document) => document.id);

	return {
		create,
		update,
		delete: deleted,
		unchanged: notionById.size - create.length - update.length,
	};
}

async function retrieveMarkdown(
	notion: NotionClient,
	page: NotionInventoryPage
): Promise<RetainDocument> {
	const response = await notion.pages.retrieveMarkdown({ page_id: page.id });
	if (response.truncated || response.unknown_block_ids.length > 0) {
		throw new Error(`Notion page ${page.id} returned truncated markdown`);
	}

	return { ...page, content: response.markdown };
}

async function retainDocuments(
	hindsight: HindsightClient,
	bankId: string,
	documentTags: string[],
	documents: readonly RetainDocument[]
): Promise<string[]> {
	const batches: MemoryItemInput[][] = [];
	for (let index = 0; index < documents.length; index += RETAIN_BATCH_SIZE) {
		batches.push(
			documents.slice(index, index + RETAIN_BATCH_SIZE).map((document) => ({
				content: document.content,
				document_id: document.id,
				tags: documentTags,
				metadata: { [RETAIN_METADATA_REVISION]: document.lastEditedTime },
				update_mode: "replace",
			}))
		);
	}

	const responses = await Promise.all(
		batches.map((batch) =>
			hindsight.retainBatch(bankId, batch, {
				async: true,
				operationId: crypto.randomUUID(),
			})
		)
	);

	for (const response of responses) {
		if (!response.success) throw new Error("Hindsight retainBatch was not accepted");
	}

	return responses.flatMap((response) =>
		response.operation_id ? [response.operation_id] : []
	);
}

async function deleteDocuments(
	hindsight: HindsightClient,
	bankId: string,
	documentIds: readonly string[]
): Promise<number> {
	await Promise.all(documentIds.map((documentId) => hindsight.deleteDocument(bankId, documentId)));
	return documentIds.length;
}

export async function syncNotionDataSource(env: Env): Promise<SyncSummary> {
	const startedAt = Date.now();
	const config = getSyncConfig(env);
	const notion = new NotionClient({
		auth: config.notionToken,
		notionVersion: NOTION_API_VERSION,
		retry: { maxRetries: 2 },
	});
	const hindsight = new HindsightClient({
		baseUrl: config.hindsightBaseUrl,
		...(config.hindsightApiKey ? { apiKey: config.hindsightApiKey } : {}),
		userAgent: "notion-to-hindsight-sync/0.1.0",
	});
	const hindsightHeaders: Record<string, string> = {
		"User-Agent": "notion-to-hindsight-sync/0.1.0",
	};
	if (config.hindsightApiKey) {
		hindsightHeaders.Authorization = `Bearer ${config.hindsightApiKey}`;
	}
	const hindsightTransport = createClient(
		createConfig({
			baseUrl: config.hindsightBaseUrl,
			headers: hindsightHeaders,
		})
	);

	// Start Hindsight first, then start Notion immediately so the two inventories
	// are fetched in parallel rather than forming a request waterfall.
	const hindsightInventory = listHindsightDocuments(
		hindsightTransport,
		config.hindsightBankId,
		config.documentTags
	);
	const notionInventory = listNotionPages(notion, config.notionDataSourceId);
	const [hindsightDocuments, notionPages] = await Promise.all([
		hindsightInventory,
		notionInventory,
	]);

	const diff = diffInventories(notionPages, hindsightDocuments);
	const changedPages = [...diff.create, ...diff.update];
	const changedDocuments = await Promise.all(changedPages.map((page) => retrieveMarkdown(notion, page)));

	const [retainOperations, deleted] = await Promise.all([
		retainDocuments(
			hindsight,
			config.hindsightBankId,
			config.documentTags,
			changedDocuments
		),
		deleteDocuments(hindsight, config.hindsightBankId, diff.delete),
	]);

	return {
		...diff,
		retained: changedDocuments.length,
		deleted,
		retainOperations,
		durationMs: Date.now() - startedAt,
	};
}
