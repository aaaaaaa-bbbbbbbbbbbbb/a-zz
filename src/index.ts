import{ Hono, type Context } from "hono";
import{ ContainerProxy } from "@cloudflare/containers";
import{ processHeartbeatBatch } from "./consumer";
import{ processCommandBatch } from "./dispatcher";
import{ runCron } from "./cron";
import{ getFleetStatus, writeFleetCommand } from "./job-stats";
import{ log } from "./metrics";
import{ ensureSchema } from "./schema";
import{ AppNode } from "./sandbox";
import{ FleetAdmin } from "./admin";
import{ MaintenanceWorkflow } from "./workflows/rolling-restart";
import{ ConfigWorkflow } from "./workflows/pool-migration";
import{ ScaleWorkflow } from "./workflows/spawn-fleet";
import{ constantTimeEqualString } from "./auth";
import type {
	HeartbeatMessage,
	FleetCommand,
	RollingRestartParams,
	PoolMigrationParams,
	SpawnFleetParams,
} from "./types";

export { AppNode, FleetAdmin, MaintenanceWorkflow, ConfigWorkflow, ScaleWorkflow, ContainerProxy };

const app = new Hono<{ Bindings: Env }>();

function auth(c: Context<{ Bindings: Env }>): boolean {
	const raw = c.req.header("x-api-key") || c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
	if(!raw) return false;
	return constantTimeEqualString(raw, c.env.API_KEY || "");
}

app.get("/health", (c) => c.json({ status: "ok" }));
app.get("/", (c) => c.body("OK", 200, { "content-type": "text/plain" }));

app.get("/status", async (c) => {
	if(!auth(c)) return c.json({ status: "ok" });
	try{
		const status = await getFleetStatus(c.env);
		return c.json(status);
	}catch(e){
		log(c.env, "error", "status fetch failed", { error: String(e) });
		return c.json({ error: "unavailable" }, 500);
	}
});

app.post("/command/restart", async (c) => {
	if(!auth(c)) return c.json({ error: "unauthorized" }, 401);
	if(!c.env.DB) return c.json({ reports: [] });
	try{
		const { instanceId, reason } = await c.req.json<{ instanceId?: string; reason?: string }>();
		if(!instanceId) return c.json({ error: "instanceId required" }, 400);
		await writeFleetCommand(c.env, { type: "restart", instanceId, reason: reason || "api" });
		return c.json({ status: "queued" });
	}catch(e){
		return c.json({ error: String(e) }, 500);
	}
});

app.post("/command/drain", async (c) => {
	if(!auth(c)) return c.json({ error: "unauthorized" }, 401);
	if(!c.env.DB) return c.json({ instances: [], count: 0 });
	try{
		await writeFleetCommand(c.env, { type: "destroy", reason: "drain" });
		return c.json({ status: "drain queued" });
	}catch(e){
		return c.json({ error: String(e) }, 500);
	}
});

app.post("/command/spawn", async (c) => {
	if(!auth(c)) return c.json({ error: "unauthorized" }, 401);
	try{
		const { count, regionHint } = await c.req.json<{ count?: number; regionHint?: string }>();
		await writeFleetCommand(c.env, { type: "spawn", desiredCount: count || 10, regionHint });
		return c.json({ status: "spawn queued" });
	}catch(e){
		return c.json({ error: String(e) }, 500);
	}
});

app.post("/workflows/maintenance", async (c) => {
	if(!auth(c)) return c.json({ error: "unauthorized" }, 401);
	try{
		const params = (await c.req.json().catch(() => ({}))) as RollingRestartParams;
		if(!params.reason) params.reason = "manual";
		const inst = await c.env.MAINTENANCE_TASK.create({ params });
		return c.json({ id: inst.id, status: await inst.status() });
	}catch(e){
		log(c.env, "error", "maintenance trigger failed", { error: String(e) });
		return c.json({ error: String(e) }, 500);
	}
});

app.post("/workflows/config-update", async (c) => {
	if(!auth(c)) return c.json({ error: "unauthorized" }, 401);
	try{
		const params = (await c.req.json()) as PoolMigrationParams;
		if(!params?.newPool) return c.json({ error: "newPool required" }, 400);
		const inst = await c.env.CONFIG_TASK.create({ params });
		return c.json({ id: inst.id, status: await inst.status() });
	}catch(e){
		log(c.env, "error", "config-update trigger failed", { error: String(e) });
		return c.json({ error: String(e) }, 500);
	}
});

app.post("/workflows/scale-out", async (c) => {
	if(!auth(c)) return c.json({ error: "unauthorized" }, 401);
	try{
		const params = (await c.req.json()) as SpawnFleetParams;
		if(!params?.targetCount || params.targetCount <= 0){
			return c.json({ error: "targetCount > 0 required" }, 400);
		}
		const inst = await c.env.SCALE_TASK.create({ params });
		return c.json({ id: inst.id, status: await inst.status() });
	}catch(e){
		log(c.env, "error", "scale-out trigger failed", { error: String(e) });
		return c.json({ error: String(e) }, 500);
	}
});

app.get("/workflows/:name/:id", async (c) => {
	if(!auth(c)) return c.json({ error: "unauthorized" }, 401);
	const name = c.req.param("name");
	const id = c.req.param("id");
	const wf = name === "maintenance"
			? c.env.MAINTENANCE_TASK
			: name === "config-update"
			? c.env.CONFIG_TASK
			: name === "scale-out"
			? c.env.SCALE_TASK
			: null;
	if(!wf) return c.json({ error: "unknown workflow" }, 404);
	try{
		const inst = await wf.get(id);
		return c.json({ id, status: await inst.status() });
	}catch(e){
		return c.json({ error: String(e) }, 500);
	}
});

app.get("/admin/reports", async (c) => {
	if(!auth(c)) return c.json({ error: "unauthorized" }, 401);
	if(!c.env.DB) return c.json({ reports: [] });
	const db = c.env.DB;
	try{
		const rows = await db.prepare(
			`SELECT * FROM fleet_reports ORDER BY timestamp DESC LIMIT 60`
		).all();
		return c.json({ reports: rows.results });
	}catch(e){
		return c.json({ error: "query failed" }, 500);
	}
});

app.get("/admin/instances", async (c) => {
	if(!auth(c)) return c.json({ error: "unauthorized" }, 401);
	if(!c.env.DB) return c.json({ instances: [], count: 0 });
	const db = c.env.DB;
	try{
		const rows = await db.prepare(
			`SELECT instance_id, status, last_hashrate, colo, current_pool, updated_at
			 FROM instance_aggregates
			 WHERE status IN ('running','starting')
			 ORDER BY last_hashrate DESC`
		).all();
		return c.json({ instances: rows.results, count: rows.results.length });
	}catch(e){
		return c.json({ error: String(e) }, 500);
	}
});

app.get("/admin/instances/:instanceId/health", async (c) => {
	if(!auth(c)) return c.json({ error: "unauthorized" }, 401);
	const instanceId = c.req.param("instanceId").replace(/[^a-zA-Z0-9._-]/g, "");
	if(!instanceId) return c.json({ error: "instanceId required" }, 400);
	try{
		const id = c.env.JOB_CONTAINER.idFromName(instanceId);
		const stub = c.env.JOB_CONTAINER.get(id);
		const res = await stub.fetch(new Request("http://internal/health", { method: "GET" }));
		const text = await res.text();
		return new Response(text, {
			status: res.status,
			headers: { "content-type": res.headers.get("content-type") || "application/json" },
		});
	}catch(e){
		return c.json({ error: String(e) }, 500);
	}
});

export default{
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		await ensureSchema(env);
		return app.fetch(request, env, ctx);
	},

	async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
		await ensureSchema(env);
		switch(batch.queue){
			case "app-events":
			case "v10-node-heartbeats":
			case "node-heartbeats":
				await processHeartbeatBatch(batch as MessageBatch<HeartbeatMessage>, env);
				return;
			case "app-commands":
			case "v10-fleet-commands":
			case "fleet-commands":
				await processCommandBatch(batch as MessageBatch<FleetCommand>, env);
				return;
			case "app-events-dlq":
			case "v10-node-heartbeats-dlq":
			case "node-heartbeats-dlq":
			case "app-commands-dlq":
			case "v10-fleet-commands-dlq":
			case "fleet-commands-dlq":
				await processDeadLetterBatch(batch, env);
				return;
			default:
				log(env, "warn", "unknown queue", { queue: batch.queue });
		}
	},

	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(ensureSchema(env).then(() => runCron(env)));
	},
} satisfies ExportedHandler<Env>;

async function processDeadLetterBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
	for(const msg of batch.messages){
		try{
			log(env, "error", "dlq_message", { queue: batch.queue, attempts: msg.attempts });
		}finally{
			msg.ack();
		}
	}
}
