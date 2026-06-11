export interface HeartbeatMessage {
	instanceId: string;
	timestamp: number;
	colo: string;
	hashrate: number;
	sharesAccepted: number;
	sharesRejected: number;
	cpuPercent: number;
	connectionStatus: string;
	pool: string;
	algorithm: string;
	memoryUsage: number;
	uptime: number;
}

export interface FleetCommand {
	type: "restart" | "reconfigure" | "destroy" | "spawn" | "probe";
	instanceId?: string;
	reason?: string;
	newPool?: string;
	newMode?: string;
	newThreads?: number;
	desiredCount?: number;
	regionHint?: string;
}

export interface InstanceStats {
	instanceId: string;
	status: "pending" | "running" | "stopped" | "error";
	createdAt?: number;
	updatedAt: number;
	colo?: string;
	currentPool?: string;
	lastHashrate: number;
	sharesLifetime?: number;
	sharesRejected?: number;
	restartCount?: number;
	lastError?: string;
}

export interface FleetReport {
	timestamp: number;
	targetInstances: number;
	activeInstances: number;
	totalHashrate: number;
	totalShares: number;
	avgHashrate: number;
	peakHashrate: number;
	rejectionRate: number;
	configJson: string;
}

export interface PoolMetrics {
	valid: boolean;
	latency: number;
	difficulty: number;
	uptime: number;
	last_checked: number;
	pool: string;
}

export interface RollingRestartParams {
	batchSize?: number;
	sleepBetweenBatches?: string;
	reason: string;
}

export interface PoolMigrationParams {
	newPool: string;
	batchSize?: number;
	canaryCount?: number;
	rollbackOnFailureRate?: number;
}

export interface SpawnFleetParams {
	targetCount: number;
	batchSize?: number;
	sleepBetweenBatches?: string;
	regionHint?: string;
}
