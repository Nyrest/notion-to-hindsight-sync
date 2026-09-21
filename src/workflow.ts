import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import {
	deleteMissingDocuments,
	submitRetainOperations,
	type SyncSummary,
	waitForSubmittedRetains,
} from "./sync";

const WORKFLOW_STEP_TIMEOUT = "1 day";

export class NotionHindsightSyncWorkflow extends WorkflowEntrypoint<Env> {
	async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<SyncSummary> {
		let phase = "submit retain operations";
		try {
			const submission = await step.do(
				phase,
				{ timeout: WORKFLOW_STEP_TIMEOUT },
				() => submitRetainOperations(this.env, event.instanceId)
			);

			phase = "wait for retain operations";
			await step.do(phase, { timeout: WORKFLOW_STEP_TIMEOUT }, () =>
				waitForSubmittedRetains(this.env, submission.retainOperations)
			);

			phase = "delete missing documents";
			const deleted = await step.do(phase, { timeout: WORKFLOW_STEP_TIMEOUT }, () =>
				deleteMissingDocuments(this.env)
			);
			const summary: SyncSummary = {
				...submission,
				deleted,
				durationMs: Date.now() - event.timestamp.getTime(),
			};
			console.log(
				JSON.stringify({
					message: "Notion to Hindsight sync completed",
					workflowInstanceId: event.instanceId,
					...summary,
				})
			);
			return summary;
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "Notion to Hindsight sync failed",
					workflowInstanceId: event.instanceId,
					phase,
					error: error instanceof Error ? error.message : String(error),
				})
			);
			throw error;
		}
	}
}
