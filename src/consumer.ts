import{ log, writeEvent, writeHeartbeat } from "./metrics";
import{ getConfig } from "./config";
import{ upsertInstanceAggregates, recordInstanceRegistry, writeFleetCommand } from "./job-stats";
import type { HeartbeatMessage, FleetCommand } from "./types";

const DEDUP_WINDOW_MS = 5 * 60 * 1000;

type HeartbeatEnvelope = {
	body: HeartbeatMessage;
	msg: Message<HeartbeatMessage>;
	idx: number;
};

export async function processHeartbeatBatch(batch: MessageBatch<HeartbeatMessage>, env: Env): Promise<void> {
	const start = Date.now();
	const config = await getConfig(env);
	const now = Date.now();

	const byInstance = new Map<string, HeartbeatEnvelope[]>();
	const ackedMessages = new Set<number>();
	let droppedStale = 0;

	for(let i = 0; i < batch.messages.length; i++){
		const msg = batch.messages[i];
		try{
			const body = msg.body;
			if(!body || typeof body.instanceId !== "string" || typeof body.timestamp !== "number"){
				log(env, "warn", "invalid heartbeat shape, dropping", { idx: i });
				msg.ack();
				ackedMessages.add(i);
				continue;
			}
			if(now - body.timestamp > DEDUP_WINDOW_MS){
				droppedStale++;
				msg.ack();
				ackedMessages.add(i);
				continue;
			}

			const arr = byInstance.get(body.instanceId) || [];
			arr.push({ body, msg, idx: i });
			byInstance.set(body.instanceId, arr);
		}catch(e){
			log(env, "error", "heartbeat message failed", { idx: i, error: String(e), attempts: msg.attempts });

			msg.retry({ delaySeconds: Math.min(60, Math.pow(2, msg.attempts)) });
		}
	}

	if(droppedStale > 0){
		writeEvent(env, "consumer", "dropped_stale_heartbeats", { count: droppedStale });
	}

	const deadInstances: string[] = [];
	const driftInstances: FleetCommand[] = [];

	for(const [instanceId, envelopes] of byInstance){
		try{
			const heartbeats = envelopes.map((entry) => entry.body);
			const latest = heartbeats[heartbeats.length - 1];
			const avgHashrate = heartbeats.reduce((s, h) => s + h.hashrate, 0) / heartbeats.length;
			const totalShares = heartbeats.reduce((s, h) => s + h.sharesAccepted, 0);
			const totalRejected = heartbeats.reduce((s, h) => s + h.sharesRejected, 0);

			await upsertInstanceAggregates(env, {
				instanceId,
				status: latest.connectionStatus === "connected" ? "running" : "error",
				lastHashrate: avgHashrate,
				sharesLifetime: totalShares,
				sharesRejected: totalRejected,
				updatedAt: now,
				colo: latest.colo,
				currentPool: latest.pool,
			});

			await recordInstanceRegistry(env, instanceId, latest.colo, latest.pool, now);
			for(const entry of envelopes){
				writeHeartbeat(env, entry.body);
				entry.msg.ack();
				ackedMessages.add(entry.idx);
			}

			if(now - latest.timestamp > config.heartbeatTimeoutMs){
				deadInstances.push(instanceId);
			}

			if(latest.pool && latest.pool !== config.pool){
				driftInstances.push({ type: "reconfigure", instanceId, newPool: config.pool });
			}
		}catch(e){
			log(env, "error", "per-instance aggregation failed", { instanceId, error: String(e) });

			writeEvent(env, "consumer", "aggregation_failed", { instanceId, error: String(e).slice(0, 256) });
			for(const entry of envelopes){
				entry.msg.retry({ delaySeconds: Math.min(60, Math.pow(2, entry.msg.attempts)) });
			}
		}
	}

	for(const id of deadInstances){
		try{
			await writeFleetCommand(env, { type: "restart", instanceId: id, reason: "heartbeat_timeout" } as FleetCommand);
			writeEvent(env, "consumer", "dead_instance_restart", { instanceId: id }, now);
		}catch(e){
			log(env, "error", "failed to enqueue restart for dead instance", { instanceId: id, error: String(e) });
		}
	}
	for(const cmd of driftInstances){
		try{
			await writeFleetCommand(env, cmd);
			writeEvent(env, "consumer", "config_drift", { instanceId: cmd.instanceId, pool: cmd.newPool }, now);
		}catch(e){
			log(env, "error", "failed to enqueue reconfigure", { instanceId: cmd.instanceId, error: String(e) });
		}
	}

	log(env, "info", "heartbeat batch processed", {
		batchSize: batch.messages.length,
		acked: ackedMessages.size,
		instances: byInstance.size,
		droppedStale,
		dead: deadInstances.length,
		drift: driftInstances.length,
		durationMs: Date.now() - start,
	});
}
