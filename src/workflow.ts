import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { getSyncTarget } from "./config";
import {
	deleteMissingDocuments,
	submitRetainOperations,
	type SyncSummary,
	waitForSubmittedRetains,
} from "./sync";

const WORKFLOW_STEP_TIMEOUT = "1 day";

export type SyncWorkflowParams = {
	targetKey: string;
	force_replace?: boolean;
};

function forceReplaceFrom(params: SyncWorkflowParams): boolean {
	if (params.force_replace === undefined) return false;
	if (typeof params.force_replace !== "boolean") {
		throw new Error("force_replace must be a boolean");
	}
	return params.force_replace;
}

export class NotionHindsightSyncWorkflow extends WorkflowEntrypoint<Env, SyncWorkflowParams> {
	async run(
		event: Readonly<WorkflowEvent<SyncWorkflowParams>>,
		step: WorkflowStep
	): Promise<SyncSummary> {
		const target = getSyncTarget(this.env, event.payload.targetKey);
		const forceReplace = forceReplaceFrom(event.payload);
		let phase = "submit retain operations";
		try {
			const submission = await step.do(
				phase,
				{ timeout: WORKFLOW_STEP_TIMEOUT },
				() => submitRetainOperations(this.env, target, event.instanceId, forceReplace)
			);

			phase = "wait for retain operations";
			await step.do(phase, { timeout: WORKFLOW_STEP_TIMEOUT }, () =>
				waitForSubmittedRetains(this.env, target, submission.retainOperations)
			);

			phase = "delete missing documents";
			const deleted = await step.do(phase, { timeout: WORKFLOW_STEP_TIMEOUT }, () =>
				deleteMissingDocuments(this.env, target)
			);
			const summary: SyncSummary = {
				...submission,
				deleted,
				durationMs: Date.now() - event.timestamp.getTime(),
			};
			console.log(
				JSON.stringify({
					message: "Notion to Hindsight sync completed",
					target: target.key,
					forceReplace,
					workflowInstanceId: event.instanceId,
					...summary,
				})
			);
			return summary;
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "Notion to Hindsight sync failed",
					target: target.key,
					forceReplace,
					workflowInstanceId: event.instanceId,
					phase,
					error: error instanceof Error ? error.message : String(error),
				})
			);
			throw error;
		}
	}
}
