import{ WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
type Sleep = Parameters<WorkflowStep["sleep"]>[1];
import{ listActiveInstanceIds, writeFleetCommand } from "../job-stats";
import{ writeEvent } from "../metrics";
import type { RollingRestartParams, FleetCommand } from "../types";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_SLEEP = "30 seconds" as const;

export class MaintenanceWorkflow extends WorkflowEntrypoint<Env, RollingRestartParams> {
	async run(event: WorkflowEvent<RollingRestartParams>, step: WorkflowStep): Promise<{ batches: number; total: number }> {
		const params = event.payload;
		const batchSize = params.batchSize && params.batchSize > 0 ? params.batchSize : DEFAULT_BATCH_SIZE;
		const sleepBetween = (params.sleepBetweenBatches || DEFAULT_SLEEP) as Sleep;
		const reason = params.reason || "maintenance";

		const instanceIds = await step.do("list-alive", async () => listActiveInstanceIds(this.env));

		if(instanceIds.length === 0){
			writeEvent(this.env, "workflow", "rolling_restart_empty", {});
			return { batches: 0, total: 0 };
		}

		const batches: string[][] = [];
		for(let i = 0; i < instanceIds.length; i += batchSize){
			batches.push(instanceIds.slice(i, i + batchSize));
		}

		for(let b = 0; b < batches.length; b++){
			const batch = batches[b];
			await step.do(
				`restart-batch-${b}`,
				{ retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
				async () => {
					await Promise.all(
						batch.map((id) => writeFleetCommand(this.env, { type: "restart", instanceId: id, reason } as FleetCommand))
					);
				}
			);
			if(b < batches.length - 1){
				await step.sleep(`sleep-${b}`, sleepBetween);
			}
		}

		await step.do("emit-complete", async () => {
			writeEvent(this.env, "workflow", "rolling_restart_complete", {
				batches: batches.length,
				total: instanceIds.length,
				reason,
			});
		});

		return { batches: batches.length, total: instanceIds.length };
	}
}
