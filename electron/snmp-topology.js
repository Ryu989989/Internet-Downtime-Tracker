"use strict";

/**
 * SNMPv2c topology walker (optional net-snmp). Seeds = gateway + device IPs.
 * Never runs from monitor._tick; caller cancels via AbortSignal / stop().
 */

const dgram = require("dgram");
const net = require("net");

const SYS_DESCR = "1.3.6.1.2.1.1.1.0";
const SYS_NAME = "1.3.6.1.2.1.1.5.0";
const IF_DESCR = "1.3.6.1.2.1.2.2.1.2";
const LLDP_REM_SYS = "1.0.8802.1.1.2.1.4.1.1.9";

const DEFAULT_TIMEOUT_MS = 2500;
const MAX_CONCURRENCY = 2;
const MAX_TARGETS = 16;

/** @type {null | any} */
let snmpLib = null;
try {
  snmpLib = require("net-snmp");
} catch {
  snmpLib = null;
}

let activeSession = null;
let cancelled = false;

function isPrivateIpv4(host) {
  if (!host || typeof host !== "string") return false;
  const bare = host.trim().replace(/^\[|\]$/g, "");
  if (!net.isIP(bare) || net.isIP(bare) !== 4) return false;
  const [a, b] = bare.split(".").map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function stop() {
  cancelled = true;
  if (activeSession && typeof activeSession.close === "function") {
    try {
      activeSession.close();
    } catch {
      /* ignore */
    }
  }
  activeSession = null;
}

function snmpGet(target, community, oids, timeoutMs) {
  return new Promise((resolve) => {
    if (!snmpLib) {
      resolve({ ok: false, error: "net-snmp not installed" });
      return;
    }
    if (cancelled) {
      resolve({ ok: false, error: "cancelled" });
      return;
    }
    const session = snmpLib.createSession(target, community || "public", {
      timeout: timeoutMs || DEFAULT_TIMEOUT_MS,
      retries: 0,
      version: snmpLib.Version2c,
    });
    activeSession = session;
    session.get(oids, (err, varbinds) => {
      try {
        session.close();
      } catch {
        /* ignore */
      }
      if (activeSession === session) activeSession = null;
      if (err) {
        resolve({ ok: false, error: String(err.message || err) });
        return;
      }
      const values = {};
      for (const vb of varbinds || []) {
        if (snmpLib.isVarbindError(vb)) continue;
        values[vb.oid] = String(vb.value);
      }
      resolve({ ok: true, values });
    });
  });
}

function snmpSubtree(target, community, oid, timeoutMs, maxResults = 32) {
  return new Promise((resolve) => {
    if (!snmpLib) {
      resolve({ ok: false, error: "net-snmp not installed", rows: [] });
      return;
    }
    if (cancelled) {
      resolve({ ok: false, error: "cancelled", rows: [] });
      return;
    }
    const session = snmpLib.createSession(target, community || "public", {
      timeout: timeoutMs || DEFAULT_TIMEOUT_MS,
      retries: 0,
      version: snmpLib.Version2c,
    });
    activeSession = session;
    const rows = [];
    session.subtree(
      oid,
      maxResults,
      (varbinds) => {
        for (const vb of varbinds || []) {
          if (snmpLib.isVarbindError(vb)) continue;
          rows.push({ oid: vb.oid, value: String(vb.value) });
        }
      },
      (err) => {
        try {
          session.close();
        } catch {
          /* ignore */
        }
        if (activeSession === session) activeSession = null;
        if (err && rows.length === 0) {
          resolve({ ok: false, error: String(err.message || err), rows: [] });
          return;
        }
        resolve({ ok: true, rows });
      }
    );
  });
}

async function pollHost(ip, community, timeoutMs) {
  const get = await snmpGet(ip, community, [SYS_NAME, SYS_DESCR], timeoutMs);
  if (!get.ok) {
    return { ip, ok: false, error: get.error, sysName: null, sysDescr: null, interfaces: [], neighbors: [] };
  }
  const sysName = get.values[SYS_NAME] || null;
  const sysDescr = get.values[SYS_DESCR] || null;
  const ifs = await snmpSubtree(ip, community, IF_DESCR, timeoutMs, 24);
  const lldp = await snmpSubtree(ip, community, LLDP_REM_SYS, timeoutMs, 24);
  return {
    ip,
    ok: true,
    error: null,
    sysName,
    sysDescr: sysDescr ? String(sysDescr).slice(0, 200) : null,
    interfaces: (ifs.rows || []).slice(0, 24).map((r) => r.value),
    neighbors: (lldp.rows || []).slice(0, 24).map((r) => r.value),
  };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length && !cancelled) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

/**
 * @param {{ seeds: string[], community?: string, timeoutMs?: number }} opts
 */
async function discoverTopology(opts = {}) {
  cancelled = false;
  const community = String(opts.community || "public").slice(0, 64);
  const timeoutMs = Math.min(8000, Math.max(500, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const seeds = [];
  const seen = new Set();
  for (const s of opts.seeds || []) {
    const ip = String(s || "").trim();
    if (!ip || seen.has(ip)) continue;
    if (!isPrivateIpv4(ip)) continue;
    seen.add(ip);
    seeds.push(ip);
    if (seeds.length >= MAX_TARGETS) break;
  }
  if (!seeds.length) {
    return {
      ok: false,
      error: "No private seed IPs",
      nodes: [],
      edges: [],
      available: !!snmpLib,
    };
  }
  if (!snmpLib) {
    return {
      ok: false,
      error: "SNMP library unavailable (install net-snmp)",
      nodes: [],
      edges: [],
      available: false,
    };
  }
  const hosts = await mapPool(seeds, MAX_CONCURRENCY, (ip) => pollHost(ip, community, timeoutMs));
  const nodes = [];
  const edges = [];
  for (const h of hosts) {
    if (!h) continue;
    nodes.push({
      id: h.ip,
      label: h.sysName || h.ip,
      ip: h.ip,
      ok: !!h.ok,
      error: h.error || null,
      sysDescr: h.sysDescr,
      interfaces: h.interfaces || [],
    });
    for (const n of h.neighbors || []) {
      edges.push({ from: h.ip, to: String(n).slice(0, 64), type: "lldp" });
    }
  }
  return {
    ok: true,
    available: true,
    nodes,
    edges,
    disclaimer: "Topology from SNMP only — ARP/Devices alone is not a complete map.",
  };
}

/** UDP reachability probe (not SNMP auth) for tests. */
function udpReachable(host, port = 161, timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    const t = setTimeout(() => {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      resolve(false);
    }, timeoutMs);
    sock.on("error", () => {
      clearTimeout(t);
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      resolve(false);
    });
    sock.send(Buffer.from([0x30, 0x00]), port, host, () => {
      clearTimeout(t);
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      resolve(true);
    });
  });
}

module.exports = {
  SYS_NAME,
  SYS_DESCR,
  isPrivateIpv4,
  stop,
  snmpGet,
  discoverTopology,
  udpReachable,
  MAX_CONCURRENCY,
  MAX_TARGETS,
};
