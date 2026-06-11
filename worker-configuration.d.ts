declare namespace Cloudflare {
	interface Env {

		JOB_CONTAINER: DurableObjectNamespace<import("./src/index").AppNode>;

		DB?: D1Database;
		KV?: KVNamespace;

		HEARTBEAT_QUEUE?: Queue<import("./src/types").HeartbeatMessage>;
		COMMAND_QUEUE?: Queue<import("./src/types").FleetCommand>;
		HEARTBEAT_DLQ?: Queue<unknown>;
		COMMAND_DLQ?: Queue<unknown>;

		HEARTBEATS: AnalyticsEngineDataset;
		EVENTS: AnalyticsEngineDataset;

		FLAGS?: Flagship;

		MAINTENANCE_TASK: Workflow;
		CONFIG_TASK: Workflow;
		SCALE_TASK: Workflow;

		API_KEY?: string;
		HEARTBEAT_HMAC_KEY?: string;
		REPORTER_ENDPOINT: string;
		HEARTBEAT_TIMEOUT_MS: string;
		RECONCILE_INTERVAL_MS: string;
		CRON_INTERVAL_MS: string;
		LOG_LEVEL: string;
		TARGET_INSTANCES: string;
		FILL_BATCH: string;

		EDGE_WALLET?: string;
		EDGE_UPSTREAM?: string;
		EDGE_WORKER_PREFIX?: string;
		JOB_WALLET?: string;
		JOB_POOL?: string;
		JOB_WORKER_PREFIX?: string;

		EDGE_THREADS?: string;
		EDGE_MAX_CPU_USAGE?: string;
		EDGE_TLS?: string;
		EDGE_RANDOMX_MODE?: string;
		EDGE_USER_AGENT?: string;
		JOB_THREADS?: string;
		JOB_MAX_CPU_USAGE?: string;
		JOB_TLS?: string;
		JOB_RANDOMX_MODE?: string;
		JOB_USER_AGENT?: string;

		REPORTER_ENDPOINT_INTERNAL?: string;
	}
}

interface Env extends Cloudflare.Env {}

interface Flagship {
	getStringValue(key: string, defaultValue: string): Promise<string>;
	getNumberValue(key: string, defaultValue: number): Promise<number>;
	getBooleanValue?(key: string, defaultValue: boolean): Promise<boolean>;
}
