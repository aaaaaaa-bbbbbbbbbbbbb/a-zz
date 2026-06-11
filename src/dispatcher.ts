import{ log, writeEvent } from "./metrics";
import{ getConfig } from "./config";
import{ getAliveInstanceIds } from "./job-stats";
import type { FleetCommand } from "./types";

type CommandEnvelope = {
	cmd: FleetCommand;
	msg: Message<FleetCommand>;
};

export async function processCommandBatch(batch: MessageBatch<FleetCommand>, env: Env): Promise<void> {
	const start = Date.now();
	const now = Date.now();

	const byInstance = new Map<string, CommandEnvelope[]>();
	const globalCmds: CommandEnvelope[] = [];

	for(const msg of batch.messages){
		try{
			const cmd = msg.body;
			if(!cmd || typeof cmd.type !== "string"){
				log(env, "warn", "invalid command shape, dropping", {});
				msg.ack();
				continue;
			}
			if(cmd.type === "spawn"){
				globalCmds.push({ cmd, msg });
			}else if(cmd.instanceId){
				const arr = byInstance.get(cmd.instanceId) || [];
				arr.push({ cmd, msg });
				byInstance.set(cmd.instanceId, arr);
			}else{
				log(env, "warn", "per-instance command missing instanceId; retrying", { type: cmd.type });
				msg.retry({ delaySeconds: Math.min(60, Math.pow(2, msg.attempts)) });
			}
		}catch(e){
			log(env, "error", "command classification failed", { error: String(e), attempts: msg.attempts });
			msg.retry({ delaySeconds: Math.min(60, Math.pow(2, msg.attempts)) });
		}
	}

	for(const { cmd, msg } of globalCmds){
		if(cmd.type === "spawn" && cmd.desiredCount){
			try{
				await handleSpawn(env, cmd.desiredCount, cmd.regionHint);
				msg.ack();
			}catch(e){
				log(env, "error", "spawn batch failed", { error: String(e) });
				writeEvent(env, "dispatcher", "spawn_failed", { error: String(e) }, now);
				msg.retry({ delaySeconds: Math.min(60, Math.pow(2, msg.attempts)) });
			}
		}
	}

	const dispatchPromises: Promise<void>[] = [];
	for(const [instanceId, entries] of byInstance){
		const commands = entries.map((entry) => entry.cmd);
		dispatchPromises.push(
			dispatchToDO(env, instanceId, commands)
				.then(() => {
					for(const entry of entries) entry.msg.ack();
				})
				.catch((e) => {
					log(env, "error", "DO dispatch failed", { instanceId, error: String(e) });
					writeEvent(env, "dispatcher", "dispatch_failed", { instanceId, error: String(e) }, now);
					for(const entry of entries){
						entry.msg.retry({ delaySeconds: Math.min(60, Math.pow(2, entry.msg.attempts)) });
					}
				})
		);
	}

	await Promise.all(dispatchPromises);

	log(env, "info", "command batch dispatched", {
		batchSize: batch.messages.length,
		instances: byInstance.size,
		globals: globalCmds.length,
		durationMs: Date.now() - start,
	});
}

async function dispatchToDO(env: Env, instanceId: string, commands: FleetCommand[]): Promise<void> {
	const doId = env.JOB_CONTAINER.idFromName(instanceId);
	const stub = env.JOB_CONTAINER.get(doId);
	const res = await stub.fetch(new Request("http://internal/command", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(commands),
	}));
	if(!res.ok){
		throw new Error(`DO returned ${res.status}`);
	}
}

async function handleSpawn(env: Env, count: number, regionHint?: string): Promise<void> {

	const config = await getConfig(env);
	const alive = await getAliveInstanceIds(env);
	const free: string[] = [];
	for(let i = 0; i < config.targetInstances && free.length < count; i++){
		const name = `fleet-node-${i}`;
		if(!alive.has(name)) free.push(name);
	}
	log(env, "info", "fleet spawn initiated", { requested: count, free: free.length, regionHint });
	if(free.length === 0) return;

	const CONCURRENCY = 5;
	for(let i = 0; i < free.length; i += CONCURRENCY){
		const wave: Promise<void>[] = [];
		for(const workerName of free.slice(i, i + CONCURRENCY)){
			const id = env.JOB_CONTAINER.idFromName(workerName);
			const stub = env.JOB_CONTAINER.get(id);
			wave.push(
				stub
					.fetch(new Request("http://internal/spawn", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ name: workerName, regionHint }),
					}))
					.then((res: Response) => {
						if(!res.ok) throw new Error(`spawn HTTP ${res.status}`);
					})
					.catch((e: unknown) => {
						log(env, "error", "spawn failed", { workerName, error: String(e) });
					})
			);
		}
		await Promise.all(wave);
	}
}
