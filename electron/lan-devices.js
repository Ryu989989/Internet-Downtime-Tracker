"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { normalizeMac, formatMac, lookupOui } = require("./oui");

const SNAPSHOT_TIMEOUT_MS = 10_000;
const MAX_STDOUT = 2_000_000;
const ONLINE_TTL_S = 600;

/** Classify IPv4 for topology display (not a full RFC map). */
function classifyIpScope(ip) {
  const s = String(ip || "").trim();
  if (!s) return null;
  if (s.startsWith("169.254.")) return "link-local";
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(s)) return "unicast";
  if (/^(224\.|239\.)/.test(s)) return "multicast";
  if (s === "127.0.0.1" || s.startsWith("127.")) return "loopback";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return "unicast";
  return null;
}

function endpointHost(endpoint) {
  const s = String(endpoint || "").trim();
  if (!s || s === "-") return "";
  if (s.startsWith("[")) {
    const m = s.match(/^\[([^\]]+)\]/);
    return m ? m[1] : "";
  }
  const idx = s.lastIndexOf(":");
  return idx > 0 ? s.slice(0, idx) : s;
}

/** Count live connection rows mentioning each IP (local or remote host). */
function countConnectionsByIp(connections) {
  const map = new Map();
  for (const c of connections || []) {
    if (!c) continue;
    const hosts = new Set(
      [endpointHost(c.local), endpointHost(c.remote)].filter(
        (h) => h && h !== "0.0.0.0" && h !== "::" && h !== "*"
      )
    );
    for (const host of hosts) map.set(host, (map.get(host) || 0) + 1);
  }
  return map;
}

function formatSeenCompact(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    return new Date(n * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";
  } catch {
    return null;
  }
}

function powershellExe() {
  const candidates = [
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    ),
    "powershell.exe",
  ];
  for (const c of candidates) {
    try {
      if (c === "powershell.exe" || fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "powershell.exe";
}

/** @type {null | Function} */
let runPowerShellOverride = null;

function setRunPowerShellForTest(fn) {
  runPowerShellOverride = fn;
}

function resetRunPowerShellForTest() {
  runPowerShellOverride = null;
}

function formatPowerShellFailure(code, stderr, stdout) {
  const err = String(stderr || "").trim();
  const out = String(stdout || "").trim();
  if (err) return `PowerShell exited with code ${code}: ${err}`;
  if (out) return `PowerShell exited with code ${code}: ${out.slice(0, 500)}`;
  return `PowerShell exited with code ${code}`;
}

function runPowerShell(script, timeoutMs) {
  if (runPowerShellOverride) return runPowerShellOverride(script, timeoutMs);
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellExe(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`LAN devices snapshot timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_STDOUT) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(formatPowerShellFailure(code, stderr, stdout)));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Single ConvertTo-Json pass — avoid `@(...|ConvertTo-Json)` then ConvertFrom-Json,
 * which fails in Windows PowerShell 5.1 (Object[] cannot bind to -InputObject string)
 * and often yields exit 1 with empty stderr under SilentlyContinue.
 */
function buildNeighborScript() {
  return `
$ErrorActionPreference = 'Continue'
try {
  $gw = $null
  $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    Sort-Object RouteMetric | Select-Object -First 1
  if ($route -and $route.NextHop) { $gw = [string]$route.NextHop }

  $list = New-Object System.Collections.Generic.List[object]
  Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object {
    $state = [string]$_.State
    if ($state -notin @('Reachable','Stale','Permanent','Delay','Probe')) { return }
    $mac = [string]$_.LinkLayerAddress
    $ip = [string]$_.IPAddress
    if (-not $mac -or -not $ip) { return }
    if ($ip -match '^(127\\.|224\\.|239\\.)' -or $ip -eq '255.255.255.255') { return }
    if ($mac -match '^(FF-FF-FF-FF-FF-FF|01-00-5E)') { return }
    $list.Add([pscustomobject]@{
      ip = $ip
      mac = $mac
      state = $state
      iface = ([string]$_.InterfaceAlias)
    })
  }

  # Build JSON manually so large arrays are not re-wrapped as {value,Count} by ConvertTo-Json.
  if ($list.Count -eq 0) {
    $neighborsJson = '[]'
  } elseif ($list.Count -eq 1) {
    $neighborsJson = '[' + ($list[0] | ConvertTo-Json -Compress -Depth 3) + ']'
  } else {
    $neighborsJson = ($list.ToArray() | ConvertTo-Json -Compress -Depth 3)
  }
  $gwJson = if ($gw) { ($gw | ConvertTo-Json -Compress) } else { 'null' }
  [Console]::Out.WriteLine(('{"gateway":' + $gwJson + ',"neighbors":' + $neighborsJson + '}'))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`.trim();
}

function unwrapPsArray(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.value)) return value.value;
  if (value == null) return [];
  return [value];
}

function shapeNeighbor(raw, gatewayIp, now) {
  const mac = formatMac(raw && (raw.mac || raw.LinkLayerAddress));
  if (!mac) return null;
  const ip = String((raw && (raw.ip || raw.IPAddress)) || "").trim();
  if (!ip || ip.startsWith("127.")) return null;
  if (/^(224\.|239\.)/.test(ip) || ip === "255.255.255.255") return null;
  const isGw = gatewayIp && ip === gatewayIp;
  const state = String((raw && (raw.state || raw.State)) || "").slice(0, 32);
  const iface = String((raw && (raw.iface || raw.InterfaceAlias)) || "").slice(0, 64);
  return {
    mac,
    ip,
    vendor: lookupOui(mac),
    state,
    iface,
    ip_scope: classifyIpScope(ip),
    gateway: !!isGw,
    source: "neighbor",
    last_seen: now,
    online: true,
  };
}

function parseSnapshot(stdout) {
  const now = Date.now() / 1000;
  let data;
  try {
    data = JSON.parse(String(stdout || "").trim() || "{}");
  } catch {
    throw new Error("Invalid LAN neighbor JSON");
  }
  let gateway = data.gateway;
  if (Array.isArray(gateway)) gateway = gateway[0] || null;
  gateway = gateway ? String(gateway).trim() : null;
  const neighbors = unwrapPsArray(data.neighbors);
  const devices = [];
  const seen = new Set();
  for (const n of neighbors) {
    const row = shapeNeighbor(n, gateway, now);
    if (!row || seen.has(row.mac)) continue;
    seen.add(row.mac);
    devices.push(row);
  }
  return { ok: true, gateway, devices, disclaimer: "Passive neighbor cache — not a complete network map." };
}

async function snapshot() {
  const { stdout } = await runPowerShell(buildNeighborScript(), SNAPSHOT_TIMEOUT_MS);
  return parseSnapshot(stdout);
}

/**
 * Merge snapshot into DB; return { devices, newDevices, gateway }.
 */
function mergeIntoDb(db, snap, { markOfflineTtlS = ONLINE_TTL_S } = {}) {
  const now = Date.now() / 1000;
  const newDevices = [];
  for (const d of snap.devices || []) {
    const prior = db.getLanDevice(d.mac);
    const isNew = !prior;
    db.upsertLanDevice({
      mac: d.mac,
      ip: d.ip,
      vendor: d.vendor || (prior && prior.vendor) || null,
      alias: prior ? prior.alias : null,
      notes: prior ? prior.notes : null,
      hostname: prior && prior.hostname ? prior.hostname : d.hostname || null,
      state: d.state || (prior && prior.state) || null,
      iface: d.iface || (prior && prior.iface) || null,
      first_seen: prior ? prior.first_seen : now,
      last_seen: now,
      online: 1,
      source: d.source || "neighbor",
      gateway: d.gateway ? 1 : prior && prior.gateway ? 1 : 0,
    });
    if (isNew) {
      newDevices.push({ ...d, first_seen: now });
    }
  }
  if (markOfflineTtlS > 0) {
    db.markLanDevicesOffline(now - markOfflineTtlS);
  }
  return {
    devices: db.listLanDevices(),
    newDevices,
    gateway: snap.gateway || null,
  };
}

/**
 * Human-readable fallback for inventory nodes without SNMP sysDescr.
 */
function deviceDescriptor(device) {
  const d = device || {};
  const parts = [];
  const add = (value) => {
    const text = String(value || "").trim();
    if (text && !parts.some((part) => part.toLowerCase() === text.toLowerCase())) parts.push(text);
  };
  add(d.alias);
  add(d.hostname);
  add(d.sysName);
  add(d.vendor);
  if (!parts.length) add("Device");
  if (d.gateway === 1 || d.gateway === true) add("Gateway");
  add(d.online === 1 || d.online === true || d.ok === true ? "online" : "offline");
  if (d.state) add(d.state);
  if (d.ip_scope) add(d.ip_scope);
  else if (d.ip) add(classifyIpScope(d.ip));
  if (d.iface) add(d.iface);
  if (d.source) add(d.source);
  if (d.conn_count != null && Number(d.conn_count) > 0) add(`${Number(d.conn_count)} conns`);
  if (d.ifCount != null && Number.isFinite(Number(d.ifCount))) add(`${Number(d.ifCount)} ifs`);
  const last = formatSeenCompact(d.last_seen);
  if (last) add(`seen ${last}`);
  if (d.mac) add(`MAC ${d.mac}`);
  return parts.join(" · ");
}

/** Full enriched tip blob for Topology graph/table. */
function topologyNodeDetailLines(node) {
  const n = node || {};
  const lines = [];
  const push = (label, value) => {
    const text = value == null || value === "" ? "" : String(value).trim();
    if (!text) return;
    lines.push(`${label}: ${text}`);
  };
  push("IP", n.ip);
  push("Name", n.label && n.label !== n.ip ? n.label : null);
  push("Alias", n.alias);
  push("Hostname", n.hostname);
  push("sysName", n.sysName);
  push("Vendor", n.vendor);
  push("MAC", n.mac);
  push("Status", n.ok === true ? "online" : n.ok === false ? n.error || "offline" : n.online === 1 || n.online === true ? "online" : n.online === 0 || n.online === false ? "offline" : null);
  if (n.gateway === true || n.gateway === 1) push("Role", "Gateway");
  push("Neighbor", n.state);
  push("IP scope", n.ip_scope || (n.ip ? classifyIpScope(n.ip) : null));
  push("Adapter", n.iface);
  push("Source", n.source);
  push("First seen", formatSeenCompact(n.first_seen));
  push("Last seen", formatSeenCompact(n.last_seen));
  if (n.conn_count != null) push("Connections", String(n.conn_count));
  push("sysDescr", n.sysDescr);
  push("sysObjectID", n.sysObjectID);
  if (n.ifCount != null) push("Interfaces", String(n.ifCount));
  return lines;
}

function topologyEnrichFields(device, node = {}) {
  const d = device || {};
  const ip = String((node && node.ip) || d.ip || "");
  return {
    alias: d.alias || node.alias || null,
    hostname: d.hostname || node.hostname || null,
    vendor: d.vendor || node.vendor || null,
    mac: d.mac || node.mac || null,
    gateway: d.gateway === 1 || d.gateway === true || node.gateway === true,
    state: d.state || node.state || null,
    iface: d.iface || node.iface || null,
    ip_scope: d.ip_scope || node.ip_scope || classifyIpScope(ip),
    source: d.source || node.source || null,
    first_seen: d.first_seen != null ? d.first_seen : node.first_seen != null ? node.first_seen : null,
    last_seen: d.last_seen != null ? d.last_seen : node.last_seen != null ? node.last_seen : null,
    conn_count: node.conn_count != null ? node.conn_count : d.conn_count != null ? d.conn_count : null,
    sysName: node.sysName || null,
    sysObjectID: node.sysObjectID || null,
    ifCount: node.ifCount != null ? node.ifCount : null,
  };
}

function enrichTopologyWithDevices(topology, devices) {
  const byIp = new Map((devices || []).filter((d) => d && d.ip).map((d) => [String(d.ip), d]));
  return {
    ...topology,
    nodes: (topology.nodes || []).map((node) => {
      const device = byIp.get(String(node.ip || ""));
      if (!device) {
        const extras = topologyEnrichFields(null, node);
        return {
          ...node,
          ...extras,
          sysDescr: String(node.sysDescr || "").trim() || deviceDescriptor({ ...node, ...extras, online: node.ok }),
        };
      }
      const extras = topologyEnrichFields(device, node);
      return {
        ...node,
        ...extras,
        label:
          !node.label || node.label === node.ip
            ? device.alias || device.hostname || device.vendor || node.sysName || node.ip
            : node.label,
        sysDescr: String(node.sysDescr || "").trim() || deviceDescriptor({ ...device, ...extras, online: device.online, ok: node.ok }),
      };
    }),
  };
}

function attachConnectionCounts(topology, connections) {
  const counts = countConnectionsByIp(connections);
  return {
    ...topology,
    nodes: (topology.nodes || []).map((node) => {
      const ip = String(node.ip || "");
      const conn_count = counts.get(ip) || 0;
      const next = { ...node, conn_count };
      if (!String(node.sysDescr || "").trim()) {
        next.sysDescr = deviceDescriptor({ ...next, online: next.ok });
      } else if (conn_count > 0 && !/\bconns\b/i.test(String(node.sysDescr))) {
        next.sysDescr = `${node.sysDescr} · ${conn_count} conns`;
      }
      return next;
    }),
  };
}

/**
 * Gateway-centered inventory map when SNMP is off.
 */
function neighborTopologyFromDevices(devices) {
  const nodes = [];
  const edges = [];
  const rows = Array.isArray(devices) ? devices : [];
  const gw = rows.find((d) => d && (d.gateway === 1 || d.gateway === true));
  const gwIp = gw && gw.ip ? String(gw.ip) : null;
  for (const d of rows) {
    if (!d || !d.ip) continue;
    const ip = String(d.ip);
    const extras = topologyEnrichFields(d, { ip, source: d.source || "neighbor" });
    nodes.push({
      ip,
      label: d.alias || d.hostname || d.vendor || ip,
      ok: !!(d.online === 1 || d.online === true),
      sysDescr: deviceDescriptor({ ...d, ...extras }),
      ...extras,
      source: extras.source || "neighbor",
    });
    if (gwIp && ip !== gwIp) {
      edges.push({ from: gwIp, to: ip, source: "neighbor" });
    }
  }
  return {
    ok: true,
    mode: "neighbor",
    warning:
      "SNMP disabled — showing Devices inventory radial map. Enable SNMP in Settings for LLDP/sysDescr.",
    nodes,
    edges,
    available: false,
  };
}

module.exports = {
  ONLINE_TTL_S,
  buildNeighborScript,
  shapeNeighbor,
  parseSnapshot,
  unwrapPsArray,
  formatPowerShellFailure,
  snapshot,
  mergeIntoDb,
  deviceDescriptor,
  topologyNodeDetailLines,
  topologyEnrichFields,
  enrichTopologyWithDevices,
  attachConnectionCounts,
  countConnectionsByIp,
  classifyIpScope,
  endpointHost,
  formatSeenCompact,
  neighborTopologyFromDevices,
  setRunPowerShellForTest,
  resetRunPowerShellForTest,
  normalizeMac,
  formatMac,
  lookupOui,
};
