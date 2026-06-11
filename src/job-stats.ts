import type { FleetCommand, InstanceStats, FleetReport } from "./types";

type D1Like = D1Database | D1DatabaseSession;

function db(env: Env, override?: D1Like): D1Like {
	const d = override ?? env.DB;
	if(!d) throw new Error("DB binding unavailable");
	return d;
}

function hasDb(env: Env, override?: D1Like): boolean {
	return !!(override ?? env.DB);
}

export async function recordInstanceRegistry(
	env: Env,
	instanceId: string,
	colo: string,
	pool: string,
	now: number,
	session?: D1Like
): Promise<void> {
	if(!hasDb(env, session)) return;
	await db(env, session)
		.prepare(
			`INSERT INTO instance_registry (instance_id, status, created_at, updated_at, colo, current_pool)
			 VALUES (?, 'running', ?, ?, ?, ?)
			 ON CONFLICT(instance_id) DO UPDATE SET
				 status='running', updated_at=?, colo=?, current_pool=?
				 WHERE status != 'stopped'`
		)
		.bind(instanceId, now, now, colo, pool, now, colo, pool)
		.run();
}

export async function upsertInstanceAggregates(
	env: Env,
	stats: Partial<InstanceStats> & { instanceId: string; updatedAt: number },
	session?: D1Like
): Promise<void> {
	if(!hasDb(env, session)) return;
	await db(env, session)
		.prepare(
			`INSERT INTO instance_aggregates (instance_id, status, last_hashrate, shares_lifetime, shares_rejected, updated_at, colo, current_pool, restart_count)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(instance_id) DO UPDATE SET
				 status = excluded.status,
				 last_hashrate = excluded.last_hashrate,
				 shares_lifetime = excluded.shares_lifetime,
				 shares_rejected = excluded.shares_rejected,
				 updated_at = excluded.updated_at,
				 colo = excluded.colo,
				 current_pool = excluded.current_pool,
				 restart_count = excluded.restart_count`
		)
		.bind(
			stats.instanceId,
			stats.status || "running",
			stats.lastHashrate ?? 0,
			stats.sharesLifetime ?? 0,
			stats.sharesRejected ?? 0,
			stats.updatedAt,
			stats.colo || "",
			stats.currentPool || "",
			stats.restartCount ?? 0
		)
		.run();
}

export async function writeFleetReport(env: Env, report: FleetReport, session?: D1Like): Promise<void> {
	if(!hasDb(env, session)) return;
	await db(env, session)
		.prepare(
			`INSERT INTO fleet_reports (timestamp, target_instances, active_instances, total_hashrate, total_shares, avg_hashrate, peak_hashrate, rejection_rate, config_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			report.timestamp,
			report.targetInstances,
			report.activeInstances,
			report.totalHashrate,
			report.totalShares,
			report.avgHashrate,
			report.peakHashrate,
			report.rejectionRate,
			report.configJson
		)
		.run();
}

export async function pruneStaleAggregates(env: Env, maxAgeMs: number, session?: D1Like): Promise<void> {
	if(!hasDb(env, session)) return;
	const cutoff = Date.now() - maxAgeMs;
	const d = db(env, session);
	await d.prepare(`DELETE FROM instance_aggregates WHERE updated_at < ?`).bind(cutoff).run();
	await d.prepare(`DELETE FROM instance_registry WHERE updated_at < ? AND status = 'stopped'`).bind(cutoff).run();
}

export async function pruneFleetReports(env: Env, retainMs: number, session?: D1Like): Promise<void> {
	if(!hasDb(env, session)) return;
	const cutoff = Date.now() - retainMs;
	await db(env, session)
		.prepare(`DELETE FROM fleet_reports WHERE timestamp < ?`)
		.bind(cutoff)
		.run();
}

export async function pruneErroredRegistry(env: Env, maxAgeMs: number, session?: D1Like): Promise<void> {
	if(!hasDb(env, session)) return;
	const cutoff = Date.now() - maxAgeMs;
	await db(env, session)
		.prepare(`DELETE FROM instance_registry WHERE updated_at < ? AND status IN ('error', 'stopped')`)
		.bind(cutoff)
		.run();
}

export async function pruneStaleStarting(env: Env, maxAgeMs: number, session?: D1Like): Promise<void> {
	if(!hasDb(env, session)) return;

	const cutoff = Date.now() - maxAgeMs;
	await db(env, session)
		.prepare(`DELETE FROM instance_registry WHERE status = 'starting' AND updated_at < ?`)
		.bind(cutoff)
		.run();
}

export interface FleetStatusRow {
	total: number;
	running: number;
	starting: number;
	error: number;
	totalHashrate: number;
	avgHashrate: number;
}

export async function getFleetStatus(env: Env, session?: D1Like): Promise<FleetStatusRow> {
	if(!hasDb(env, session)) return { total: 0, running: 0, starting: 0, error: 0, totalHashrate: 0, avgHashrate: 0 };
	const d = db(env, session);

	const totals = await d.prepare(`SELECT COUNT(*) as total FROM instance_registry`).first<{ total: number }>();
	const running = await d
		.prepare(`SELECT COUNT(*) as c FROM instance_aggregates WHERE status = 'running'`)
		.first<{ c: number }>();
	const starting = await d
		.prepare(`SELECT COUNT(*) as c FROM instance_registry WHERE status = 'starting'`)
		.first<{ c: number }>();
	const errors = await d
		.prepare(`SELECT COUNT(*) as c FROM instance_registry WHERE status = 'error'`)
		.first<{ c: number }>();
	const hash = await d
		.prepare(
			`SELECT COALESCE(SUM(last_hashrate),0) as total, COALESCE(AVG(last_hashrate),0) as avg
			 FROM instance_aggregates WHERE status = 'running'`
		)
		.first<{ total: number; avg: number }>();

	return {
		total: totals?.total ?? 0,
		running: running?.c ?? 0,
		starting: starting?.c ?? 0,
		error: errors?.c ?? 0,
		totalHashrate: hash?.total ?? 0,
		avgHashrate: hash?.avg ?? 0,
	};
}

export async function getAliveInstanceCount(
	env: Env,
	session?: D1Like,
	aliveWindowMs: number = 300000
): Promise<number> {
	if(!hasDb(env, session)) return 0;

	const now = Date.now();
	const cutoff = now - aliveWindowMs;
	const row = await db(env, session)
		.prepare(
			`SELECT COUNT(*) AS c FROM (
				SELECT instance_id FROM instance_registry
				WHERE status IN ('starting', 'running') AND updated_at > ?
				UNION
				SELECT instance_id FROM instance_aggregates
				WHERE status = 'running' AND updated_at > ?
			)`
		)
		.bind(cutoff, cutoff)
		.first<{ c: number }>();
	return row?.c ?? 0;
}

export async function getAliveInstanceIds(
	env: Env,
	session?: D1Like,
	aliveWindowMs: number = 300000
): Promise<Set<string>> {
	if(!hasDb(env, session)) return new Set();

	const cutoff = Date.now() - aliveWindowMs;
	const res = await db(env, session)
		.prepare(
			`SELECT instance_id FROM instance_registry
			 WHERE status IN ('starting', 'running') AND updated_at > ?
			 UNION
			 SELECT instance_id FROM instance_aggregates
			 WHERE status = 'running' AND updated_at > ?`
		)
		.bind(cutoff, cutoff)
		.all<{ instance_id: string }>();
	return new Set((res.results ?? []).map((r: { instance_id: string }) => r.instance_id));
}

export async function getTotalHashrate(env: Env, session?: D1Like): Promise<number> {
	if(!hasDb(env, session)) return 0;
	const row = await db(env, session)
		.prepare(`SELECT COALESCE(SUM(last_hashrate),0) as total FROM instance_aggregates WHERE status = 'running'`)
		.first<{ total: number }>();
	return row?.total ?? 0;
}

export async function getTotalShares(env: Env, session?: D1Like): Promise<{ accepted: number; rejected: number }> {
	if(!hasDb(env, session)) return { accepted: 0, rejected: 0 };
	const row = await db(env, session)
		.prepare(
			`SELECT COALESCE(SUM(shares_lifetime),0) as accepted, COALESCE(SUM(shares_rejected),0) as rejected
			 FROM instance_aggregates`
		)
		.first<{ accepted: number; rejected: number }>();
	return { accepted: row?.accepted ?? 0, rejected: row?.rejected ?? 0 };
}

export async function getRejectionRate(env: Env, session?: D1Like): Promise<number> {
	const { accepted, rejected } = await getTotalShares(env, session);
	const total = accepted + rejected;
	return total > 0 ? rejected / total : 0;
}

export async function getPeakHashrate24h(env: Env, session?: D1Like): Promise<number> {
	if(!hasDb(env, session)) return 0;
	const since = Date.now() - 24 * 60 * 60 * 1000;
	const row = await db(env, session)
		.prepare(`SELECT MAX(total_hashrate) as peak FROM fleet_reports WHERE timestamp >= ?`)
		.bind(since)
		.first<{ peak: number | null }>();
	if(row?.peak != null) return row.peak;
	return await getTotalHashrate(env, session);
}

export async function listActiveInstanceIds(env: Env, session?: D1Like): Promise<string[]> {
	if(!hasDb(env, session)) return [];
	const res = await db(env, session)
		.prepare(`SELECT instance_id FROM instance_aggregates WHERE status = 'running' ORDER BY instance_id`)
		.all<{ instance_id: string }>();
	return (res.results ?? []).map((r: { instance_id: string }) => r.instance_id);
}

export async function getInstanceFailureRate(env: Env, instanceIds: string[], session?: D1Like): Promise<number> {
	if(instanceIds.length === 0) return 0;
	if(!hasDb(env, session)) return 0;
	const placeholders = instanceIds.map(() => "?").join(",");
	const row = await db(env, session)
		.prepare(
			`SELECT
				 SUM(CASE WHEN status = 'error' OR last_hashrate = 0 THEN 1 ELSE 0 END) as failed,
				 COUNT(*) as total
			 FROM instance_aggregates WHERE instance_id IN (${placeholders})`
		)
		.bind(...instanceIds)
		.first<{ failed: number; total: number }>();
	if(!row || !row.total) return 0;
	return row.failed / row.total;
}

export async function writeFleetCommand(env: Env, cmd: FleetCommand): Promise<void> {
	if(env.COMMAND_QUEUE){
		await env.COMMAND_QUEUE.send(cmd);
		return;
	}
	if(cmd.type === "spawn"){
		const count = cmd.desiredCount || 1;
		const alive = await getAliveInstanceIds(env);
		const free: string[] = [];
		for(let i = 0; i < 370 && free.length < count; i++){
			const id = `fleet-node-${i}`;
			if(!alive.has(id)) free.push(id);
		}
		for(const id of free){
			await dispatchCommandDirect(env, id, [{ type: "spawn", desiredCount: 1, regionHint: cmd.regionHint }]);
		}
		return;
	}
	if(cmd.instanceId){
		await dispatchCommandDirect(env, cmd.instanceId, [cmd]);
		return;
	}
	if(cmd.type === "destroy"){
		for(const id of await listActiveInstanceIds(env)){
			await dispatchCommandDirect(env, id, [{ ...cmd, instanceId: id }]);
		}
		return;
	}
	throw new Error("command requires COMMAND_QUEUE or instanceId");
}

async function dispatchCommandDirect(env: Env, instanceId: string, commands: FleetCommand[]): Promise<void> {
	const doId = env.JOB_CONTAINER.idFromName(instanceId);
	const stub = env.JOB_CONTAINER.get(doId);
	const res = await stub.fetch(new Request("http://internal/command", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(commands),
	}));
	if(!res.ok) throw new Error(`DO returned ${res.status}`);
}
