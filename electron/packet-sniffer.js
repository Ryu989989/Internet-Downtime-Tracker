"use strict";

/**
 * Metadata connection-flow sniffer (TCP/UDP open/close deltas from
 * Connections snapshots — not Npcap/raw capture; no elevated helper required).
 * Payload bytes off by default. Ring buffer ~500 events in memory.
 */

const RING_MAX = 500;

/** @type {{ ts: number, proto: string, src: string, dst: string, sport: number, dport: number, event: string, pid?: number, process?: string }[]} */
const ring = [];
let running = false;
let alwaysOn = false;
let pollTimer = null;
/** @type {null | (() => Promise<object>)} */
let fetchFlows = null;
/** @type {Map<string, true>} */
let lastKeys = new Map();

function setFetchFlowsForTest(fn) {
  fetchFlows = fn;
}

function status() {
  return {
    running,
    always_on: alwaysOn,
    count: ring.length,
    payloads: false,
    disclaimer:
      "Metadata-only flow events (open/close). Not full packet capture; payloads disabled by default.",
  };
}

function pushEvent(ev) {
  ring.push(ev);
  while (ring.length > RING_MAX) ring.shift();
}

function events({ limit = 100, proto = null, host = null, port = null } = {}) {
  let rows = ring.slice();
  if (proto) {
    const p = String(proto).toUpperCase();
    rows = rows.filter((r) => r.proto === p);
  }
  if (host) {
    const h = String(host).toLowerCase();
    rows = rows.filter(
      (r) =>
        String(r.src).toLowerCase().includes(h) ||
        String(r.dst).toLowerCase().includes(h)
    );
  }
  if (port != null && port !== "") {
    const n = Number(port);
    rows = rows.filter((r) => r.sport === n || r.dport === n);
  }
  const lim = Math.min(RING_MAX, Math.max(1, Number(limit) || 100));
  return rows.slice(-lim).reverse();
}

function clear() {
  ring.length = 0;
  lastKeys = new Map();
}

async function pollOnce() {
  if (!fetchFlows) return;
  let data;
  try {
    data = await fetchFlows();
  } catch {
    return;
  }
  const flows = (data && data.flows) || [];
  const next = new Map();
  const now = Date.now() / 1000;
  for (const f of flows) {
    const key = `${f.proto}|${f.local}|${f.remote}|${f.pid || 0}`;
    next.set(key, true);
    if (!lastKeys.has(key)) {
      const [lip, lport] = String(f.local || "").split(":");
      const [rip, rport] = String(f.remote || "").split(":");
      pushEvent({
        ts: now,
        proto: String(f.proto || "TCP").toUpperCase(),
        src: lip || "",
        dst: rip || "",
        sport: Number(lport) || 0,
        dport: Number(rport) || 0,
        event: "open",
        pid: f.pid || null,
        process: f.process || null,
      });
    }
  }
  for (const key of lastKeys.keys()) {
    if (!next.has(key)) {
      const [proto, local, remote, pid] = key.split("|");
      const [lip, lport] = String(local || "").split(":");
      const [rip, rport] = String(remote || "").split(":");
      pushEvent({
        ts: now,
        proto: String(proto || "TCP").toUpperCase(),
        src: lip || "",
        dst: rip || "",
        sport: Number(lport) || 0,
        dport: Number(rport) || 0,
        event: "close",
        pid: Number(pid) || null,
      });
    }
  }
  lastKeys = next;
}

function start({ always = false } = {}) {
  alwaysOn = !!always;
  if (running) return status();
  if (!fetchFlows) {
    return { ...status(), ok: false, error: "sniffer backend not wired" };
  }
  running = true;
  pollOnce();
  pollTimer = setInterval(() => {
    pollOnce().catch(() => {});
  }, 2000);
  if (pollTimer.unref) pollTimer.unref();
  return { ...status(), ok: true };
}

function stop({ force = false } = {}) {
  if (alwaysOn && !force) {
    return { ...status(), ok: true, kept_alive: true };
  }
  running = false;
  alwaysOn = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  return { ...status(), ok: true };
}

function setAlwaysOn(on) {
  alwaysOn = !!on;
  if (alwaysOn && !running) start({ always: true });
  if (!alwaysOn && running) stop({ force: true });
  return status();
}

module.exports = {
  RING_MAX,
  status,
  events,
  clear,
  start,
  stop,
  setAlwaysOn,
  setFetchFlowsForTest,
  pushEvent,
};
