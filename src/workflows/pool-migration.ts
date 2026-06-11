import{ WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import{ listActiveInstanceIds, getInstanceFailureRate, writeFleetCommand } from "../job-stats";
import{ writeEvent, log } from "../metrics";
import{ getConfig } from "../config";
import type { PoolMigrationParams, FleetCommand } from "../types";

const DEFAULT_BATCH = 25;
const DEFAULT_CANARY = 10;
const DEFAULT_FAILURE_RATE = 0.3;
const CANARY_SOAK = "2 minutes" as const;
const BATCH_SLEEP = "30 seconds" as const;

export class ConfigWorkflow extends WorkflowEntrypoint<Env, PoolMigrationParams> {
	async run(
		event: WorkflowEvent<PoolMigrationParams>,
		step: WorkflowStep
	): Promise<{ migrated: number; rolledBack: boolean; reason?: string }> {
		const params = event.payload;
		if(!params.newPool){
			throw new Error("config-update requires newPool");
		}
		const batchSize = params.batchSize && params.batchSize > 0 ? params.batchSize : DEFAULT_BATCH;
		const canaryCount = params.canaryCount && params.canaryCount > 0 ? params.canaryCount : DEFAULT_CANARY;
		const failureThreshold = typeof params.rollbackOnFailureRate === "number" && params.rollbackOnFailureRate >= 0
				? params.rollbackOnFailureRate
				: DEFAULT_FAILURE_RATE;

		const rollbackPool = await step.do("snapshot-config", async () => {
			const cfg = await getConfig(this.env);
			await this.env.KV?.put("migration:rollback_pool", cfg.pool);
			await this.env.KV?.put("migration:target_pool", params.newPool);
			return cfg.pool;
		});

		const allInstances = await step.do("list-alive", async () => listActiveInstanceIds(this.env));
		if(allInstances.length === 0){
			writeEvent(this.env, "workflow", "pool_migration_empty", { newPool: params.newPool });
			return { migrated: 0, rolledBack: false };
		}

		const canary = allInstances.slice(0, Math.min(canaryCount, allInstances.length));
		const remainder = allInstances.slice(canary.length);

		await step.do("reconfigure-canary", { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } }, async () => {
			await Promise.all(
				canary.map((id) => writeFleetCommand(this.env, { type: "reconfigure", instanceId: id, newPool: params.newPool } as FleetCommand))
			);
		});

		await step.sleep("canary-soak", CANARY_SOAK);

		const failureRate = await step.do("check-canary-health", async () =>
			getInstanceFailureRate(this.env, canary)
		);

		if(failureRate > failureThreshold){
			log(this.env, "error", "canary failure rate exceeded; rolling back", {
				failureRate,
				threshold: failureThreshold,
			});
			await step.do("rollback-canary", { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } }, async () => {
				await Promise.all(
					canary.map((id) => writeFleetCommand(this.env, { type: "reconfigure", instanceId: id, newPool: rollbackPool } as FleetCommand))
				);
			});
			await step.do("emit-rollback", async () => {
				await this.env.KV?.delete("migration:target_pool");
				writeEvent(this.env, "workflow", "pool_migration_rolled_back", {
					newPool: params.newPool,
					rollbackPool,
					failureRate,
					threshold: failureThreshold,
				});
			});
			return { migrated: 0, rolledBack: true, reason: "canary_failure_rate" };
		}

		const batches: string[][] = [];
		for(let i = 0; i < remainder.length; i += batchSize){
			batches.push(remainder.slice(i, i + batchSize));
		}

		for(let b = 0; b < batches.length; b++){
			const batch = batches[b];
			await step.do(
				`reconfigure-batch-${b}`,
				{ retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
				async () => {
					await Promise.all(
						batch.map((id) => writeFleetCommand(this.env, { type: "reconfigure", instanceId: id, newPool: params.newPool } as FleetCommand))
					);
				}
			);
			if(b < batches.length - 1){
				await step.sleep(`batch-sleep-${b}`, BATCH_SLEEP);
			}
		}

		await step.do("emit-complete", async () => {
			await this.env.KV?.put("migration:active_pool", params.newPool);
			await this.env.KV?.delete("migration:target_pool");
			writeEvent(this.env, "workflow", "pool_migration_complete", {
				newPool: params.newPool,
				migrated: allInstances.length,
				canary: canary.length,
				failureRate,
			});
		});

		return { migrated: allInstances.length, rolledBack: false };
	}
}
