import{ WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
type Sleep = Parameters<WorkflowStep["sleep"]>[1];
import{ getAliveInstanceCount, writeFleetCommand } from "../job-stats";
import{ writeEvent, log } from "../metrics";
import type { SpawnFleetParams, FleetCommand } from "../types";

const DEFAULT_BATCH = 8;
const DEFAULT_SLEEP = "45 seconds" as const;

export class ScaleWorkflow extends WorkflowEntrypoint<Env, SpawnFleetParams> {
	async run(
		event: WorkflowEvent<SpawnFleetParams>,
		step: WorkflowStep
	): Promise<{ spawned: number; achieved: number; target: number }> {
		const params = event.payload;
		if(!params.targetCount || params.targetCount <= 0){
			throw new Error("scale-out requires targetCount > 0");
		}
		const batchSize = params.batchSize && params.batchSize > 0 ? params.batchSize : DEFAULT_BATCH;
		const sleepBetween = (params.sleepBetweenBatches || DEFAULT_SLEEP) as Sleep;

		const initialAlive = await step.do("current-count", async () => getAliveInstanceCount(this.env));
		const deficit = Math.max(0, params.targetCount - initialAlive);

		if(deficit === 0){
			writeEvent(this.env, "workflow", "spawn_fleet_no_op", {
				targetCount: params.targetCount,
				alive: initialAlive,
			});
			return { spawned: 0, achieved: initialAlive, target: params.targetCount };
		}

		const totalBatches = Math.ceil(deficit / batchSize);
		let spawned = 0;

		for(let b = 0; b < totalBatches; b++){
			const thisBatch = Math.min(batchSize, deficit - spawned);
			await step.do(
				`spawn-batch-${b}`,
				{ retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
				async () => {
					await writeFleetCommand(this.env, {
						type: "spawn",
						desiredCount: thisBatch,
						regionHint: params.regionHint,
					} as FleetCommand);
				}
			);
			spawned += thisBatch;
			if(b < totalBatches - 1){
				await step.sleep(`spawn-sleep-${b}`, sleepBetween);
			}
		}

		await step.sleep("settle", "90 seconds");

		const finalAlive = await step.do("verify", async () => getAliveInstanceCount(this.env));

		if(finalAlive < params.targetCount){
			log(this.env, "warn", "scale-out under target after settle", {
				target: params.targetCount,
				achieved: finalAlive,
			});
		}

		await step.do("emit-complete", async () => {
			writeEvent(this.env, "workflow", "spawn_fleet_complete", {
				target: params.targetCount,
				achieved: finalAlive,
				spawned,
				deficit,
			});
		});

		return { spawned, achieved: finalAlive, target: params.targetCount };
	}
}
