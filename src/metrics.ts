import type { HeartbeatMessage } from "./types";

const LEVELS: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

export function log(
	env: Env,
	level: string,
	message: string,
	meta?: Record<string, unknown>
): void {
	const upper = level.toUpperCase();
	const configured = (env.LOG_LEVEL || "INFO").toUpperCase();
	const msgLevel = LEVELS[upper] ?? 99;
	const thresholdLevel = LEVELS[configured] ?? 1;
	if(msgLevel < thresholdLevel) return;

	const payload = JSON.stringify({ ts: Date.now(), level: upper, msg: message, ...meta });
	if(upper === "ERROR"){
		console.error(payload);
	}else if(upper === "WARN"){
		console.warn(payload);
	}else{
		console.log(payload);
	}
}

export function writeHeartbeat(env: Env, hb: HeartbeatMessage): void {
	env.HEARTBEATS.writeDataPoint({
		indexes: [hb.instanceId],
		blobs: [hb.instanceId, hb.colo, hb.pool, hb.connectionStatus, hb.algorithm],
		doubles: [hb.hashrate, hb.sharesAccepted, hb.sharesRejected, hb.cpuPercent, hb.memoryUsage, hb.uptime, Date.now()],
	});
}

export function writeEvent(
	env: Env,
	eventType: string,
	detail: string,
	meta?: Record<string, unknown>,
	ts?: number
): void {
	env.EVENTS.writeDataPoint({
		indexes: [eventType],
		blobs: [detail, meta?.instanceId ? String(meta.instanceId) : "", JSON.stringify(meta || {})],
		doubles: [ts || Date.now()],
	});
}
