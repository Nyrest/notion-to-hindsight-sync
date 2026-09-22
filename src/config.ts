export type SyncTarget = {
	key: string;
	notionDataSourceId: string;
	hindsightBankId: string;
};

type TargetEnv = Env & {
	SYNC_TARGETS?: string;
};

const TARGET_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_WORKFLOW_INSTANCE_ID_LENGTH = 100;
const SCHEDULED_TIME_LENGTH = 13;
const MAX_TARGET_KEY_LENGTH =
	MAX_WORKFLOW_INSTANCE_ID_LENGTH - SCHEDULED_TIME_LENGTH - 1;
const MAX_BATCH_SIZE = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requiredTargetString(value: unknown, property: string, index: number): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`SYNC_TARGETS item ${index} requires a non-empty ${property}`);
	}
	return value.trim();
}

export function getSyncTargets(env: Env): SyncTarget[] {
	const raw = (env as TargetEnv).SYNC_TARGETS?.trim();
	if (!raw) throw new Error("SYNC_TARGETS is not configured");

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("SYNC_TARGETS must contain valid JSON");
	}

	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error("SYNC_TARGETS must be a non-empty array");
	}
	if (parsed.length > MAX_BATCH_SIZE) {
		throw new Error(`SYNC_TARGETS supports at most ${MAX_BATCH_SIZE} targets per Cron run`);
	}

	const keys = new Set<string>();
	return parsed.map((item, index) => {
		if (!isRecord(item)) throw new Error(`SYNC_TARGETS item ${index} must be an object`);

		const key = requiredTargetString(item.key, "key", index);
		if (!TARGET_KEY_PATTERN.test(key) || key.length > MAX_TARGET_KEY_LENGTH) {
			throw new Error(
				`SYNC_TARGETS item ${index} has an invalid key; use up to ${MAX_TARGET_KEY_LENGTH} letters, numbers, underscores, or hyphens`
			);
		}
		if (keys.has(key)) throw new Error(`SYNC_TARGETS contains duplicate key: ${key}`);
		keys.add(key);

		return {
			key,
			notionDataSourceId: requiredTargetString(item.notionDataSourceId, "notionDataSourceId", index),
			hindsightBankId: requiredTargetString(item.hindsightBankId, "hindsightBankId", index),
		};
	});
}

export function getSyncTarget(env: Env, key: string): SyncTarget {
	const target = getSyncTargets(env).find((candidate) => candidate.key === key);
	if (!target) throw new Error(`Unknown sync target: ${key}`);
	return target;
}
