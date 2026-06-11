import{ getConfig } from "./config";
import{ log, writeEvent } from "./metrics";
import{
	pruneStaleAggregates,
	pruneFleetReports,
	pruneErroredRegistry,
	pruneStaleStarting,
	writeFleetReport,
	getAliveInstanceIds,
	getTotalHashrate,
	getTotalShares,
	getRejectionRate,
	getPeakHashrate24h,
	writeFleetCommand,
} from "./job-stats";
import type { FleetCommand } from "./types";

export async function runCron(env: Env): Promise<void> {
	const now = Date.now();
	const session = env.DB?.withSession();

	const config = await getConfig(env);

	const aliveWindowMs = Math.max(config.heartbeatTimeoutMs * 2, 300000);
	const aliveIds = await getAliveInstanceIds(env, session, aliveWindowMs);
	let activeCount = 0;
	for(let i = 0; i < config.targetInstances; i++){
		if(aliveIds.has(`fleet-node-${i}`)) activeCount++;
	}
	const totalHashrate = await getTotalHashrate(env, session);
	const totalShares = await getTotalShares(env, session);
	const rejectionRate = await getRejectionRate(env, session);
	const peakHashrate = await getPeakHashrate24h(env, session);

	await writeFleetReport(
		env,
		{
			timestamp: now,
			targetInstances: config.targetInstances,
			activeInstances: activeCount,
			totalHashrate,
			totalShares: totalShares.accepted,
			avgHashrate: activeCount > 0 ? totalHashrate / activeCount : 0,
			peakHashrate,
			rejectionRate,
			configJson: JSON.stringify(config),
		},
		session
	);

	await pruneStaleAggregates(env, 10 * 60 * 1000, session);

	try{
		await pruneFleetReports(env, 7 * 24 * 60 * 60 * 1000, session);
	}catch(e){
		log(env, "warn", "pruneFleetReports failed", { error: String(e) });
	}
	try{
		await pruneErroredRegistry(env, 60 * 60 * 1000, session);
	}catch(e){
		log(env, "warn", "pruneErroredRegistry failed", { error: String(e) });
	}
	try{
		await pruneStaleStarting(env, 10 * 60 * 1000, session);
	}catch(e){
		log(env, "warn", "pruneStaleStarting failed", { error: String(e) });
	}

	if(activeCount < config.targetInstances){

		const needed = config.targetInstances - activeCount;

		const batchSize = env.DB ? Math.min(needed, config.fillBatch) : config.targetInstances;
		try{
			await writeFleetCommand(env, {
				type: "spawn",
				desiredCount: batchSize,
			} as FleetCommand);
			log(env, "info", "reconcile spawn queued", { needed, batch: batchSize });
		}catch(e){
			log(env, "error", "reconcile spawn enqueue failed", { error: String(e) });
		}
	}

	writeEvent(env, "cron", "tick", {
		activeCount,
		targetInstances: config.targetInstances,
		totalHashrate,
		sharesAccepted: totalShares.accepted,
		sharesRejected: totalShares.rejected,
		rejectionRate,
		peakHashrate,
	});
}
