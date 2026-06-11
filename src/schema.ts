import{ log } from "./metrics";

export const SCHEMA_VERSION = 1;

const DDL_STATEMENTS: string[] = [
	`CREATE TABLE IF NOT EXISTS _schema_meta (
		key   TEXT PRIMARY KEY,
		value INTEGER NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS instance_registry (
		instance_id	   TEXT PRIMARY KEY,
		status			TEXT NOT NULL DEFAULT 'pending',
		created_at		INTEGER NOT NULL,
		updated_at		INTEGER NOT NULL,
		colo			  TEXT,
		current_pool	  TEXT,
		restart_count	 INTEGER NOT NULL DEFAULT 0,
		last_error		TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS idx_registry_status  ON instance_registry(status)`,
	`CREATE INDEX IF NOT EXISTS idx_registry_updated ON instance_registry(updated_at)`,

	`CREATE TABLE IF NOT EXISTS instance_aggregates (
		instance_id	   TEXT PRIMARY KEY,
		status			TEXT NOT NULL DEFAULT 'pending',
		last_hashrate	 REAL NOT NULL DEFAULT 0,
		shares_lifetime   INTEGER NOT NULL DEFAULT 0,
		shares_rejected   INTEGER NOT NULL DEFAULT 0,
		updated_at		INTEGER NOT NULL,
		colo			  TEXT,
		current_pool	  TEXT,
		restart_count	 INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE INDEX IF NOT EXISTS idx_agg_updated ON instance_aggregates(updated_at)`,
	`CREATE INDEX IF NOT EXISTS idx_agg_status  ON instance_aggregates(status)`,

	`CREATE TABLE IF NOT EXISTS fleet_reports (
		report_id		 INTEGER PRIMARY KEY AUTOINCREMENT,
		timestamp		 INTEGER NOT NULL,
		target_instances  INTEGER NOT NULL,
		active_instances  INTEGER NOT NULL,
		total_hashrate	REAL NOT NULL DEFAULT 0,
		total_shares	  INTEGER NOT NULL DEFAULT 0,
		avg_hashrate	  REAL NOT NULL DEFAULT 0,
		peak_hashrate	 REAL NOT NULL DEFAULT 0,
		rejection_rate	REAL NOT NULL DEFAULT 0,
		config_json	   TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS idx_fleet_reports_timestamp ON fleet_reports(timestamp DESC)`,
];

let schemaReady: Promise<void> | null = null;

export function ensureSchema(env: Env): Promise<void> {
	if(!schemaReady){
		schemaReady = applySchema(env).catch((e) => {

			schemaReady = null;
			throw e;
		});
	}
	return schemaReady;
}

async function applySchema(env: Env): Promise<void> {
	if(!env.DB){
		log(env, "warn", "ensureSchema: DB binding unavailable, skipping");
		return;
	}
	const db = env.DB;

	try{
		const row = await db
			.prepare(`SELECT value FROM _schema_meta WHERE key = 'version'`)
			.first<{ value: number }>();
		if(row && row.value >= SCHEMA_VERSION) return;
	}catch {

	}

	const start = Date.now();
	const statements = DDL_STATEMENTS.map((sql) => db.prepare(sql));
	statements.push(
		db
			.prepare(
				`INSERT INTO _schema_meta (key, value) VALUES ('version', ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
			)
			.bind(SCHEMA_VERSION)
	);

	await db.batch(statements);

	log(env, "info", "schema applied", {
		version: SCHEMA_VERSION,
		statements: statements.length,
		durationMs: Date.now() - start,
	});
}
