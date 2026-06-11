import{ WorkerEntrypoint } from "cloudflare:workers";
import{ writeFleetCommand, getFleetStatus, getAliveInstanceCount } from "./job-stats";
import{ getConfig, type FleetConfig } from "./config";
import type { FleetStatusRow } from "./job-stats";
import type {
	FleetCommand,
	RollingRestartParams,
	PoolMigrationParams,
	SpawnFleetParams,
} from "./types";

export class FleetAdmin extends WorkerEntrypoint<Env> {
	async getStatus(): Promise<FleetStatusRow & { config: FleetConfig }> {
		const [config, status] = await Promise.all([getConfig(this.env), getFleetStatus(this.env)]);
		return { ...status, config };
	}

	async getAliveCount(): Promise<number> {
		return getAliveInstanceCount(this.env);
	}

	async restart(instanceId: string, reason: string = "rpc"): Promise<void> {
		if(!instanceId) throw new Error("restart requires instanceId");
		await writeFleetCommand(this.env, { type: "restart", instanceId, reason } as FleetCommand);
	}

	async drain(reason: string = "rpc-drain"): Promise<void> {
		await writeFleetCommand(this.env, { type: "destroy", reason } as FleetCommand);
	}

	async spawn(count: number, regionHint?: string): Promise<void> {
		if(!count || count <= 0) throw new Error("spawn requires count > 0");
		await writeFleetCommand(this.env, { type: "spawn", desiredCount: count, regionHint } as FleetCommand);
	}

	async reconfigure(
		instanceId: string,
		newPool?: string,
		newMode?: string,
		newThreads?: number
	): Promise<void> {
		if(!instanceId) throw new Error("reconfigure requires instanceId");
		await writeFleetCommand(this.env, {
			type: "reconfigure",
			instanceId,
			newPool,
			newMode,
			newThreads,
		} as FleetCommand);
	}

	async triggerRollingRestart(params: RollingRestartParams): Promise<{ id: string }> {
		const inst = await this.env.MAINTENANCE_TASK.create({ params });
		return { id: inst.id };
	}

	async triggerPoolMigration(params: PoolMigrationParams): Promise<{ id: string }> {
		if(!params?.newPool) throw new Error("triggerPoolMigration requires newPool");
		const inst = await this.env.CONFIG_TASK.create({ params });
		return { id: inst.id };
	}

	async triggerSpawnFleet(params: SpawnFleetParams): Promise<{ id: string }> {
		if(!params?.targetCount || params.targetCount <= 0){
			throw new Error("triggerSpawnFleet requires targetCount > 0");
		}
		const inst = await this.env.SCALE_TASK.create({ params });
		return { id: inst.id };
	}
}
