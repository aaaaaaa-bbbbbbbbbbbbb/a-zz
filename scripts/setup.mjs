#!/usr/bin/env node

"use strict";
import{ readFileSync, writeFileSync } from "node:fs";
import{ fileURLToPath } from "node:url";
import{ dirname, join } from "node:path";

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const KEY = process.env.CLOUDFLARE_API_KEY;
const EMAIL = process.env.CLOUDFLARE_EMAIL;
const API = "https://api.cloudflare.com/client/v4";
const WRANGLER = join(dirname(fileURLToPath(import.meta.url)), "..", "wrangler.jsonc");
const API_HEADERS = {
  "Accept": "application/json,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-store",
  "Origin": "https://dash.cloudflare.com",
  "Referer": "https://dash.cloudflare.com/",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0",
};

const QUEUES = [];
const KV_TITLE = "APP_KV";
const D1_NAME = "app-state";

function die(msg){
  console.error("\n[setup] ERROR: " + msg + "\n");
  process.exit(1);
}

if(!ACCOUNT) die("CLOUDFLARE_ACCOUNT_ID is not set.");
if(!TOKEN && !(KEY && EMAIL)) die("Set CLOUDFLARE_API_TOKEN, or CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL.");

function authHeaders(){
  if(TOKEN) return { Authorization: `Bearer ${TOKEN}` };
  return { "X-Auth-Email": EMAIL, "X-Auth-Key": KEY };
}

async function cf(method, path, body){
  let last;
  for(let attempt = 1; attempt <= 3; attempt++){
	try{
		const res = await fetch(`${API}${path}`, {
			method,
			headers: { ...API_HEADERS, ...authHeaders(), "Content-Type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
	  let json;
	  try{ json = await res.json(); }catch { json = { success: false, errors: [{ message: `non-JSON ${res.status}` }] }; }
	  if(json.success) return json;

	  const c = res.status;
	  if(c >= 400 && c < 500 && c !== 400 && c !== 401 && c !== 403 && c !== 429) return json;
	  last = json;
	}catch(e){
	  last = { success: false, errors: [{ message: String(e) }] };
	}
	if(attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  return last;
}

function firstErr(j){
  return (j && j.errors && j.errors[0] && j.errors[0].message) || "unknown error";
}

async function ensureKv(){
  const list = await cf("GET", `/accounts/${ACCOUNT}/storage/kv/namespaces?per_page=100`);
  if(!list.success) die("KV list failed: " + firstErr(list));
  const found = (list.result || []).find((n) => n.title === KV_TITLE);
  if(found){ console.log(`[setup] KV "${KV_TITLE}" exists -> ${found.id}`); return found.id; }
  const made = await cf("POST", `/accounts/${ACCOUNT}/storage/kv/namespaces`, { title: KV_TITLE });
  if(!made.success) die("KV create failed: " + firstErr(made));
  console.log(`[setup] KV "${KV_TITLE}" created -> ${made.result.id}`);
  return made.result.id;
}

async function ensureD1(){
  const list = await cf("GET", `/accounts/${ACCOUNT}/d1/database?per_page=100`);
  if(!list.success) die("D1 list failed: " + firstErr(list));
  const found = (list.result || []).find((d) => d.name === D1_NAME);
  if(found){ console.log(`[setup] D1 "${D1_NAME}" exists -> ${found.uuid}`); return found.uuid; }
  const made = await cf("POST", `/accounts/${ACCOUNT}/d1/database`, { name: D1_NAME });
  if(!made.success) die("D1 create failed: " + firstErr(made));
  console.log(`[setup] D1 "${D1_NAME}" created -> ${made.result.uuid}`);
  return made.result.uuid;
}

async function ensureQueues(){
  const list = await cf("GET", `/accounts/${ACCOUNT}/queues?per_page=100`);
  if(!list.success) die("Queue list failed: " + firstErr(list));
  const existing = new Set((list.result || []).map((q) => q.queue_name));
  for(const name of QUEUES){
	if(existing.has(name)){ console.log(`[setup] queue "${name}" exists`); continue; }
	const made = await cf("POST", `/accounts/${ACCOUNT}/queues`, { queue_name: name });
	if(!made.success) die(`Queue "${name}" create failed: ` + firstErr(made));
	console.log(`[setup] queue "${name}" created`);
  }
}

async function getSubdomain(){
  const j = await cf("GET", `/accounts/${ACCOUNT}/workers/subdomain`);
  if(j.success && j.result && j.result.subdomain) return j.result.subdomain;
  console.warn("[setup] WARN: could not read workers.dev subdomain (" + firstErr(j) + "); leaving REPORTER_ENDPOINT unchanged.");
  return null;
}

async function ensureSubdomain(){
  const cur = await cf("GET", `/accounts/${ACCOUNT}/workers/subdomain`);
  if(cur.success && cur.result && cur.result.subdomain){
	console.log(`[setup] workers.dev subdomain exists: ${cur.result.subdomain}`);
	return cur.result.subdomain;
  }
  const desired = (process.env.WORKER_NAME || `fleet-${ACCOUNT.slice(0, 8)}`)
	.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 54);
  const made = await cf("PUT", `/accounts/${ACCOUNT}/workers/subdomain`, { subdomain: desired });
  if(made.success){ console.log(`[setup] registered workers.dev subdomain: ${desired}`); return desired; }
  console.warn(`[setup] WARN: could not register subdomain "${desired}": ${firstErr(made)} (wrangler deploy may fail with 10063)`);
  return null;
}

function patchWrangler(kvId, d1Id, subdomain){
  const WORKER_NAME = process.env.WORKER_NAME;
  let txt = readFileSync(WRANGLER, "utf8");
  if(!txt.includes("PLACEHOLDER_KV_ID") && !txt.includes("PLACEHOLDER_D1_ID")){
	console.warn("[setup] WARN: placeholders already replaced; re-patching ids anyway.");
  }
  txt = txt.replace(/"PLACEHOLDER_KV_ID"/g, JSON.stringify(kvId));
  txt = txt.replace(/"PLACEHOLDER_D1_ID"/g, JSON.stringify(d1Id));

  if(process.env.ENABLE_PUBLIC_REPORTER_ENDPOINT === "1" && subdomain && WORKER_NAME){
	const url = `https://${WORKER_NAME}.${subdomain}.workers.dev/instances/heartbeat`;
	txt = txt.replace(/("REPORTER_ENDPOINT":\s*)"[^"]*"/, `$1${JSON.stringify(url)}`);
	console.log(`[setup] REPORTER_ENDPOINT -> ${url}`);
  }else{
	console.log("[setup] REPORTER_ENDPOINT left empty/internal-only (set ENABLE_PUBLIC_REPORTER_ENDPOINT=1 only for debugging).");
  }
  writeFileSync(WRANGLER, txt);
  console.log("[setup] wrangler.jsonc updated.");
}

(async () => {
  console.log(`[setup] account ${ACCOUNT}`);
  await cf("GET", `/accounts/${ACCOUNT}/containers/me`);
  const kvId = await ensureKv();
  const d1Id = await ensureD1();
  await ensureQueues();
  const subdomain = await ensureSubdomain();
  patchWrangler(kvId, d1Id, subdomain);
  console.log("\n[setup] DONE. Next:");
  console.log("[setup]   npx wrangler deploy\n");
})().catch((e) => die(String(e && e.stack ? e.stack : e)));
