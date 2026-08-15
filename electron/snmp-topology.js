"use strict";

/**
 * SNMPv2c topology walker (optional net-snmp). Seeds = gateway + device IPs.
 * Never runs from monitor._tick; caller cancels via AbortSignal / stop().
 */

const dgram = require("dgram");
const net = require("net");

const SYS_DESCR = "1.3.6.1.2.1.1.1.0";
const SYS_OBJECT_ID = "1.3.6.1.2.1.1.2.0";
const SYS_NAME = "1.3.6.1.2.1.1.5.0";
const IF_NUMBER = "1.3.6.1.2.1.2.1.0";
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

/** Match topologyGraphHtml byId: node.ip || node.label || index */
function graphNodeKey(node, index) {
  if (!node) return String(index ?? "");
  return String(node.ip || node.label || node.id || index || "");
}

function buildSysNameToIp(nodes) {
  const map = new Map();
  for (const n of nodes || []) {
    const name = String((n && n.sysName) || "").trim().toLowerCase();
    const ip = String((n && n.ip) || "").trim();
    if (!name || !ip || map.has(name)) continue;
    map.set(name, ip);
  }
  return map;
}

function buildIpToNode(nodes) {
  const map = new Map();
  for (const n of nodes || []) {
    const ip = String((n && n.ip) || "").trim();
    if (ip) map.set(ip, n);
  }
  return map;
}

/**
 * LLDP remSysName (or IP) → graph key. Unmatched private/name → stub; public IPv4 dropped.
 * @returns {{ key: string, stub: boolean, ip: string|null } | null}
 */
function resolveLldpTo(raw, sysNameToIp, ipToNode) {
  const s = String(raw || "").trim().slice(0, 64);
  if (!s) return null;
  if (ipToNode && ipToNode.has(s)) return { key: s, stub: false, ip: s };
  const mapped = sysNameToIp && sysNameToIp.get(s.toLowerCase());
  if (mapped) return { key: mapped, stub: false, ip: mapped };
  const ver = net.isIP(s);
  if (ver === 4) {
    if (!isPrivateIpv4(s)) return null;
    return { key: s, stub: true, ip: s };
  }
  if (ver === 6) return null;
  return { key: s, stub: true, ip: null };
}

function snmpNodeFromHost(h) {
  return {
    id: h.ip,
    label: h.sysName || h.ip,
    ip: h.ip,
    ok: !!h.ok,
    error: h.error || null,
    sysName: h.sysName || null,
    sysDescr: h.sysDescr,
    sysObjectID: h.sysObjectID || null,
    ifCount: h.ifCount != null ? h.ifCount : h.interfaces ? h.interfaces.length : null,
    interfaces: h.interfaces || [],
    source: "snmp",
  };
}

function lldpStubNode(resolved) {
  const key = resolved.key;
  return {
    id: key,
    label: key,
    ip: resolved.ip || null,
    ok: false,
    error: "not SNMP-polled",
    sysName: resolved.ip ? null : key,
    sysDescr: null,
    sysObjectID: null,
    ifCount: null,
    interfaces: [],
    source: "lldp-stub",
  };
}

/** Build SNMP nodes + LLDP edges from pollHost-shaped rows (no live SNMP). */
function lldpTopologyFromHosts(hosts) {
  const nodes = [];
  for (const h of hosts || []) {
    if (!h || !h.ip) continue;
    nodes.push(snmpNodeFromHost(h));
  }
  const sysNameToIp = buildSysNameToIp(nodes);
  const ipToNode = buildIpToNode(nodes);
  const seenKeys = new Set(nodes.map((n) => graphNodeKey(n)));
  const seenEdges = new Set();
  const edges = [];
  let unpolled = 0;
  for (const h of hosts || []) {
    if (!h || !h.ip) continue;
    for (const raw of h.neighbors || []) {
      const resolved = resolveLldpTo(raw, sysNameToIp, ipToNode);
      if (!resolved || resolved.key === h.ip) continue;
      if (resolved.stub && !seenKeys.has(resolved.key)) {
        nodes.push(lldpStubNode(resolved));
        seenKeys.add(resolved.key);
        if (resolved.ip) {
          ipToNode.set(resolved.ip, nodes[nodes.length - 1]);
        }
        unpolled += 1;
      }
      const edgeKey = `${h.ip}\0${resolved.key}\0lldp`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      edges.push({ from: h.ip, to: resolved.key, type: "lldp" });
    }
  }
  const out = {
    ok: true,
    mode: "snmp",
    nodes,
    edges,
    unpolled_neighbors: unpolled,
    disclaimer: "Topology from SNMP only — ARP/Devices alone is not a complete map.",
  };
  if (unpolled) {
    out.warning = `${unpolled} LLDP neighbor${unpolled === 1 ? "" : "s"} not SNMP-polled — stub node(s) shown; not a switch fabric.`;
  }
  return out;
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
  const get = await snmpGet(ip, community, [SYS_NAME, SYS_DESCR, SYS_OBJECT_ID, IF_NUMBER], timeoutMs);
  if (!get.ok) {
    return {
      ip,
      ok: false,
      error: get.error,
      sysName: null,
      sysDescr: null,
      sysObjectID: null,
      ifCount: null,
      interfaces: [],
      neighbors: [],
    };
  }
  const sysName = get.values[SYS_NAME] || null;
  const sysDescr = get.values[SYS_DESCR] || null;
  const sysObjectID = get.values[SYS_OBJECT_ID] || null;
  const ifNumberRaw = get.values[IF_NUMBER];
  const ifCount =
    ifNumberRaw != null && Number.isFinite(Number(ifNumberRaw)) ? Number(ifNumberRaw) : null;
  const ifs = await snmpSubtree(ip, community, IF_DESCR, timeoutMs, 24);
  const lldp = await snmpSubtree(ip, community, LLDP_REM_SYS, timeoutMs, 24);
  return {
    ip,
    ok: true,
    error: null,
    sysName,
    sysDescr: sysDescr ? String(sysDescr).slice(0, 200) : null,
    sysObjectID: sysObjectID != null ? String(sysObjectID).slice(0, 128) : null,
    ifCount,
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
  return { ...lldpTopologyFromHosts(hosts), available: true };
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
  SYS_OBJECT_ID,
  IF_NUMBER,
  isPrivateIpv4,
  graphNodeKey,
  buildSysNameToIp,
  buildIpToNode,
  resolveLldpTo,
  lldpTopologyFromHosts,
  stop,
  snmpGet,
  discoverTopology,
  udpReachable,
  MAX_CONCURRENCY,
  MAX_TARGETS,
};
