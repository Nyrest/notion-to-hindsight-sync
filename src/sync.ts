import {
	Client as NotionClient,
	type PageObjectResponse,
	type QueryDataSourceResponse,
} from "@notionhq/client";
import {
	createClient,
	createConfig,
	HindsightClient,
	sdk,
	type ListDocumentsResponse,
	type MemoryItemInput,
} from "@vectorize-io/hindsight-client";
import type { SyncTarget } from "./config";

const NOTION_API_VERSION = "2026-03-11";
export const NOTION_PAGE_SIZE = 100;
export const HINDSIGHT_INVENTORY_PAGE_SIZE = 250;
export const RETAIN_BATCH_SIZE = 25;
export const NOTION_REQUEST_INTERVAL_MS = 350;
export const HINDSIGHT_OPERATION_POLL_MS = 30_000;
export const HINDSIGHT_OPERATION_RETRY_LIMIT = 3;

const RETAIN_METADATA_REVISION = "notion_last_edited_time";
const SOURCE_TAG = "source:notion";

type HindsightTransport = ReturnType<typeof createClient>;
type HindsightInventoryDocument = Pick<
	ListDocumentsResponse["items"][number],
	"id" | "document_metadata"
>;
type OptionalEnv = Env & {
	HINDSIGHT_API_KEY?: string;
	CF_ACCESS_CLIENT_ID?: string;
	CF_ACCESS_CLIENT_SECRET?: string;
};

export type NotionInventoryPage = {
	id: string;
	lastEditedTime: string;
	title: string;
};

export type SyncDiff = {
	create: NotionInventoryPage[];
	update: NotionInventoryPage[];
	delete: string[];
	unchanged: number;
};

export type RetainSubmission = {
	created: number;
	updated: number;
	unchanged: number;
	retained: number;
	retainOperations: string[];
};

export type SyncSummary = RetainSubmission & {
	deleted: number;
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
	cfAccessClientId?: string;
	cfAccessClientSecret?: string;
	notionToken: string;
	documentTags: string[];
};

export type HindsightOperationClient = {
	getOperationStatus(operationId: string): Promise<HindsightOperationStatus>;
	retryOperation(operationId: string): Promise<void>;
};

export type HindsightOperationStatus = {
	status: "pending" | "processing" | "completed" | "failed" | "cancelled" | "not_found";
	retry_count?: number | null;
};

function required(value: string | undefined, name: string): string {
	const normalized = value?.trim();
	if (!normalized) throw new Error(`${name} is not configured`);
	return normalized;
}

function getSyncConfig(env: Env, target: SyncTarget): SyncConfig {
	const optionalEnv = env as OptionalEnv;
	const notionDataSourceId = required(target.notionDataSourceId, "notionDataSourceId");
	const hindsightBaseUrl = required(env.HINDSIGHT_BASE_URL, "HINDSIGHT_BASE_URL").replace(/\/+$/, "");
	const hindsightBankId = required(target.hindsightBankId, "hindsightBankId");
	const hindsightApiKey = optionalEnv.HINDSIGHT_API_KEY?.trim() || undefined;
	const cfAccessClientId = optionalEnv.CF_ACCESS_CLIENT_ID?.trim() || undefined;
	const cfAccessClientSecret = optionalEnv.CF_ACCESS_CLIENT_SECRET?.trim() || undefined;
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
		cfAccessClientId,
		cfAccessClientSecret,
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

function createNotionPacer(): () => Promise<void> {
	let nextRequestAt = 0;
	return async () => {
		const now = Date.now();
		const delay = Math.max(0, nextRequestAt - now);
		nextRequestAt = Math.max(nextRequestAt, now) + NOTION_REQUEST_INTERVAL_MS;
		if (delay > 0) await sleep(delay);
	};
}

async function pacedNotionRequest<T>(
	pace: () => Promise<void>,
	request: () => Promise<T>
): Promise<T> {
	await pace();
	return request();
}

function createClients(env: Env, target: SyncTarget): {
	config: SyncConfig;
	notion: NotionClient;
	hindsight: HindsightClient;
	hindsightTransport: HindsightTransport;
} {
	const config = getSyncConfig(env, target);
	const notion = new NotionClient({
		auth: config.notionToken,
		notionVersion: NOTION_API_VERSION,
		retry: { maxRetries: 2 },
	});
	const hindsightHeaders: Record<string, string> = {
		"User-Agent": "notion-to-hindsight-sync/0.1.0",
	};
	if (config.cfAccessClientId) {
		hindsightHeaders["CF-Access-Client-Id"] = config.cfAccessClientId;
	}
	if (config.cfAccessClientSecret) {
		hindsightHeaders["CF-Access-Client-Secret"] = config.cfAccessClientSecret;
	}
	if (config.hindsightApiKey) {
		hindsightHeaders.Authorization = `Bearer ${config.hindsightApiKey}`;
	}

	return {
		config,
		notion,
		hindsight: new HindsightClient({
			baseUrl: config.hindsightBaseUrl,
			headers: hindsightHeaders,
			...(config.hindsightApiKey ? { apiKey: config.hindsightApiKey } : {}),
			userAgent: "notion-to-hindsight-sync/0.1.0",
		}),
		hindsightTransport: createClient(
			createConfig({ baseUrl: config.hindsightBaseUrl, headers: hindsightHeaders })
		),
	};
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

function plainTextOfRichText(items: readonly { plain_text: string }[]): string {
	return items.map((item) => item.plain_text).join("").trim();
}

function notionDocumentId(pageId: string): string {
	return `notion_page:${pageId}`;
}

function notionPageTitle(page: PageObjectResponse): string {
	const titleProperty = Object.values(page.properties).find(
		(property) => property.type === "title"
	);
	if (titleProperty?.type !== "title") return page.id;
	return plainTextOfRichText(titleProperty.title) || page.id;
}

async function retrieveDataSourceName(
	notion: NotionClient,
	dataSourceId: string,
	pace: () => Promise<void>
): Promise<string> {
	const response = await pacedNotionRequest(pace, () =>
		notion.dataSources.retrieve({ data_source_id: dataSourceId })
	);
	if (!("title" in response)) return dataSourceId;
	return plainTextOfRichText(response.title) || dataSourceId;
}

export async function listNotionPages(
	notion: NotionClient,
	dataSourceId: string,
	pace: () => Promise<void> = createNotionPacer()
): Promise<NotionInventoryPage[]> {
	const pages: NotionInventoryPage[] = [];
	let nextCursor: string | null = null;

	while (true) {
		const response = await pacedNotionRequest(pace, () =>
			notion.dataSources.query({
				data_source_id: dataSourceId,
				page_size: NOTION_PAGE_SIZE,
				result_type: "page",
				...(nextCursor ? { start_cursor: nextCursor } : {}),
			})
		);

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
			pages.push({
				id: result.id,
				lastEditedTime: result.last_edited_time,
				title: notionPageTitle(result),
			});
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
				limit: HINDSIGHT_INVENTORY_PAGE_SIZE,
				offset,
			},
		});
		const data = requireSdkData(response, "Hindsight listDocuments");
		for (const document of data.items) {
			documents.push({ id: document.id, document_metadata: document.document_metadata });
		}
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
	const notionById = new Map(notionPages.map((page) => [notionDocumentId(page.id), page]));
	const hindsightById = new Map(hindsightDocuments.map((document) => [document.id, document]));
	const create: NotionInventoryPage[] = [];
	const update: NotionInventoryPage[] = [];

	for (const page of notionById.values()) {
		const document = hindsightById.get(notionDocumentId(page.id));
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
	page: NotionInventoryPage,
	pace: () => Promise<void>
): Promise<RetainDocument> {
	const response = await pacedNotionRequest(pace, () =>
		notion.pages.retrieveMarkdown({ page_id: page.id, include_transcript: true })
	);
	if (response.truncated || response.unknown_block_ids.length > 0) {
		throw new Error(`Notion page ${page.id} returned truncated markdown`);
	}

	return { ...page, content: response.markdown };
}

function toRetainItems(
	documents: readonly RetainDocument[],
	documentTags: string[],
	dataSourceName: string
): MemoryItemInput[] {
	return documents.map((document) => ({
		content: document.content,
		context: `Notion Page "${document.title}" in Data Source "${dataSourceName}"`,
		document_id: notionDocumentId(document.id),
		tags: documentTags,
		metadata: { [RETAIN_METADATA_REVISION]: document.lastEditedTime },
		update_mode: "replace",
	}));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const batches: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		batches.push(items.slice(index, index + size));
	}
	return batches;
}

function bytesToUuid(bytes: Uint8Array): string {
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function operationIdFor(
	workflowInstanceId: string,
	pages: readonly NotionInventoryPage[]
): Promise<string> {
	const fingerprint = pages
		.map((page) => `${page.id}\u0000${page.lastEditedTime}`)
		.sort()
		.join("\u0001");
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`${workflowInstanceId}\u0002${fingerprint}`)
		)
	);
	return bytesToUuid(digest.slice(0, 16));
}

function operationIdsFrom(response: { operation_id?: string | null; operation_ids?: string[] | null }): string[] {
	return [...new Set([response.operation_id, ...(response.operation_ids ?? [])].filter(Boolean))] as string[];
}

export async function submitRetainOperations(
	env: Env,
	target: SyncTarget,
	workflowInstanceId: string
): Promise<RetainSubmission> {
	const { config, notion, hindsight, hindsightTransport } = createClients(env, target);
	const pace = createNotionPacer();
	const [hindsightDocuments, notionPages] = await Promise.all([
		listHindsightDocuments(hindsightTransport, config.hindsightBankId, config.documentTags),
		listNotionPages(notion, config.notionDataSourceId, pace),
	]);
	const dataSourceName = await retrieveDataSourceName(notion, config.notionDataSourceId, pace);
	const diff = diffInventories(notionPages, hindsightDocuments);
	const changedPages = [...diff.create, ...diff.update].sort((left, right) =>
		left.id.localeCompare(right.id)
	);
	const retainOperations: string[] = [];

	for (const batch of chunk(changedPages, RETAIN_BATCH_SIZE)) {
		const documents: RetainDocument[] = [];
		for (const page of batch) documents.push(await retrieveMarkdown(notion, page, pace));
		const response = await hindsight.retainBatch(
			config.hindsightBankId,
			toRetainItems(documents, config.documentTags, dataSourceName),
			{ async: true, operationId: await operationIdFor(workflowInstanceId, batch) }
		);
		if (!response.success) throw new Error("Hindsight retainBatch was not accepted");
		retainOperations.push(...operationIdsFrom(response));
	}

	return {
		created: diff.create.length,
		updated: diff.update.length,
		unchanged: diff.unchanged,
		retained: changedPages.length,
		retainOperations: [...new Set(retainOperations)],
	};
}

function createOperationClient(
	transport: HindsightTransport,
	bankId: string
): HindsightOperationClient {
	return {
		async getOperationStatus(operationId) {
			return requireSdkData(
				await sdk.getOperationStatus({
					client: transport,
					path: { bank_id: bankId, operation_id: operationId },
				}),
				"Hindsight getOperationStatus"
			);
		},
		async retryOperation(operationId) {
			const response = requireSdkData(
				await sdk.retryOperation({
					client: transport,
					path: { bank_id: bankId, operation_id: operationId },
				}),
				"Hindsight retryOperation"
			);
			if (!response.success) throw new Error("Hindsight retryOperation was not accepted");
		},
	};
}

export async function waitForRetainOperations(
	client: HindsightOperationClient,
	operationIds: readonly string[],
	wait: (durationMs: number) => Promise<void> = sleep
): Promise<void> {
	if (operationIds.length === 0) return;

	while (true) {
		let allCompleted = true;
		for (const operationId of operationIds) {
			const operation = await client.getOperationStatus(operationId);
			switch (operation.status) {
				case "completed":
					break;
				case "pending":
				case "processing":
					allCompleted = false;
					break;
				case "failed":
					if ((operation.retry_count ?? 0) >= HINDSIGHT_OPERATION_RETRY_LIMIT) {
						throw new Error(
							`Hindsight operation ${operationId} failed after ${HINDSIGHT_OPERATION_RETRY_LIMIT} retries`
						);
					}
					await client.retryOperation(operationId);
					allCompleted = false;
					break;
				case "cancelled":
				case "not_found":
					throw new Error(`Hindsight operation ${operationId} ended as ${operation.status}`);
			}
		}

		if (allCompleted) return;
		await wait(HINDSIGHT_OPERATION_POLL_MS);
	}
}

export async function waitForSubmittedRetains(
	env: Env,
	target: SyncTarget,
	operationIds: readonly string[]
): Promise<void> {
	const { config, hindsightTransport } = createClients(env, target);
	await waitForRetainOperations(
		createOperationClient(hindsightTransport, config.hindsightBankId),
		operationIds
	);
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof Error && (/\b404\b/.test(error.message) || /not[ _-]?found/i.test(error.message));
}

export async function deleteMissingDocuments(env: Env, target: SyncTarget): Promise<number> {
	const { config, notion, hindsight, hindsightTransport } = createClients(env, target);
	const pace = createNotionPacer();
	const [hindsightDocuments, notionPages] = await Promise.all([
		listHindsightDocuments(hindsightTransport, config.hindsightBankId, config.documentTags),
		listNotionPages(notion, config.notionDataSourceId, pace),
	]);
	const diff = diffInventories(notionPages, hindsightDocuments);
	let deleted = 0;

	for (const documentId of diff.delete) {
		try {
			await hindsight.deleteDocument(config.hindsightBankId, documentId);
			deleted += 1;
		} catch (error) {
			if (!isNotFoundError(error)) throw error;
		}
	}

	return deleted;
}

function sleep(durationMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}
