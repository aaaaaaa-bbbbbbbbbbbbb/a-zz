const enc = new TextEncoder();

export function constantTimeEqualString(a: string, b: string): boolean {
	const ab = enc.encode(a ?? "");
	const bb = enc.encode(b ?? "");
	if(ab.byteLength !== bb.byteLength) return false;

	const cs = crypto.subtle as unknown as {
		timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
	};
	if(typeof cs.timingSafeEqual === "function"){
		return cs.timingSafeEqual(ab, bb);
	}
	let diff = 0;
	for(let i = 0; i < ab.byteLength; i++) diff |= ab[i] ^ bb[i];
	return diff === 0;
}

async function importHmacKey(secret: string): Promise<globalThis.CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"]
	);
}

function toHex(buf: ArrayBuffer): string {
	const u8 = new Uint8Array(buf);
	let s = "";
	for(let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, "0");
	return s;
}

function fromHex(hex: string): Uint8Array | null {
	if(hex.length % 2 !== 0) return null;
	const out = new Uint8Array(hex.length / 2);
	for(let i = 0; i < out.length; i++){
		const byte = parseInt(hex.substr(i * 2, 2), 16);
		if(Number.isNaN(byte)) return null;
		out[i] = byte;
	}
	return out;
}

export function canonicalHeartbeatString(instanceId: string, timestamp: number | string, body: string): string {
	return `${instanceId}:${timestamp}:${body}`;
}

export async function signHeartbeat(
	secret: string,
	instanceId: string,
	timestamp: number | string,
	body: string
): Promise<string> {
	const key = await importHmacKey(secret);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(canonicalHeartbeatString(instanceId, timestamp, body)));
	return toHex(sig);
}

export interface VerifyResult {
	valid: boolean;
	reason?: "missing_signature" | "missing_timestamp" | "bad_signature" | "bad_timestamp" | "replay_window" | "key_unavailable";
}

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export async function verifyHeartbeatSignature(opts: {
	secret: string | undefined;
	instanceId: string;
	signatureHex: string | null | undefined;
	timestampHeader: string | null | undefined;
	body: string;
	now?: number;
}): Promise<VerifyResult> {
	if(!opts.secret) return { valid: false, reason: "key_unavailable" };
	if(!opts.signatureHex) return { valid: false, reason: "missing_signature" };
	if(!opts.timestampHeader) return { valid: false, reason: "missing_timestamp" };

	const ts = parseInt(opts.timestampHeader, 10);
	if(!Number.isFinite(ts)) return { valid: false, reason: "bad_timestamp" };
	const now = opts.now ?? Date.now();
	if(Math.abs(now - ts) > REPLAY_WINDOW_MS) return { valid: false, reason: "replay_window" };

	const provided = fromHex(opts.signatureHex.trim());
	if(!provided) return { valid: false, reason: "bad_signature" };

	const key = await importHmacKey(opts.secret);
	const expected = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, enc.encode(canonicalHeartbeatString(opts.instanceId, ts, opts.body)))
	);
	if(provided.byteLength !== expected.byteLength) return { valid: false, reason: "bad_signature" };

	const cs = crypto.subtle as unknown as {
		timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
	};
	const ok = typeof cs.timingSafeEqual === "function"
			? cs.timingSafeEqual(provided, expected)
			: (() => {
					let diff = 0;
					for(let i = 0; i < expected.byteLength; i++) diff |= provided[i] ^ expected[i];
					return diff === 0;
			  })();

	return ok ? { valid: true } : { valid: false, reason: "bad_signature" };
}
