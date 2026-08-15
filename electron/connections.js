"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const dns = require("dns").promises;
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const SNAPSHOT_TIMEOUT_MS = 10_000;
const SERVICE_TIMEOUT_MS = 8_000;
const ROW_CAP = 200;
const MAX_STDOUT = 4_000_000;
const DNS_LOOKUP_CAP = 8;
const DNS_TIMEOUT_MS = 500;
const RESOLVE_DNS_SETTING = "connections_resolve_dns";

/** Local map only — not DNS-SRV. */
const WELL_KNOWN_PORTS = {
  20: "ftp-data",
  21: "ftp",
  22: "ssh",
  23: "telnet",
  25: "smtp",
  53: "dns",
  67: "dhcp",
  68: "dhcp",
  80: "http",
  110: "pop3",
  123: "ntp",
  135: "rpc",
  137: "netbios-ns",
  139: "netbios-ssn",
  143: "imap",
  161: "snmp",
  389: "ldap",
  443: "https",
  445: "smb",
  465: "smtps",
  500: "isakmp",
  587: "submission",
  631: "ipp",
  636: "ldaps",
  853: "domain-s",
  993: "imaps",
  995: "pop3s",
  1433: "mssql",
  1521: "oracle",
  1900: "ssdp",
  3306: "mysql",
  3389: "rdp",
  5353: "mdns",
  5357: "wsd",
  5432: "postgresql",
  5900: "vnc",
  5985: "winrm",
  6379: "redis",
  7680: "dosvc",
  8080: "http-alt",
  8443: "https-alt",
  9200: "elasticsearch",
  27017: "mongodb",
};

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

/** @type {null | typeof runPowerShell} */
let runPowerShellOverride = null;
/** @type {null | ((ip: string, timeoutMs: number) => Promise<string|null>)} */
let reverseLookupOverride = null;

/** @type {{ at: number, adapters: Map<string, {rx: number, tx: number}> } | null} */
let lastAdapterSample = null;
/** @type {Map<string, string|null>} */
let dnsCache = new Map();
/** @type {Promise<Map<number, string>> | null} */
let serviceMapPromise = null;
/** @type {Map<string, object> | null} */
let lastConnRows = null;

function setRunPowerShellForTest(fn) {
  runPowerShellOverride = fn;
}

function setReverseLookupForTest(fn) {
  reverseLookupOverride = fn;
}

function resetRunPowerShellForTest() {
  runPowerShellOverride = null;
  reverseLookupOverride = null;
  lastAdapterSample = null;
  dnsCache = new Map();
  serviceMapPromise = null;
  lastConnRows = null;
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
      reject(new Error(`Connections snapshot timed out after ${Math.round(timeoutMs / 1000)}s`));
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
        reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

function buildSnapshotScript() {
  return `
$ErrorActionPreference = 'SilentlyContinue'
# Hashtable keys are type-sensitive: Get-Process Id is [int], OwningProcess is often [uint32].
$procs = @{}
Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $procs[[int]$_.Id] = $_.ProcessName }
function Resolve-ProcName([int]$procId) {
  if ($procs.ContainsKey($procId)) { return $procs[$procId] }
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($p) { return $p.ProcessName }
  return '?'
}
$rows = New-Object System.Collections.Generic.List[object]
Get-NetTCPConnection -ErrorAction SilentlyContinue | ForEach-Object {
  $procId = [int]$_.OwningProcess
  $rows.Add([pscustomobject]@{
    proto = 'TCP'
    process = (Resolve-ProcName $procId)
    pid = $procId
    local = "$($_.LocalAddress):$($_.LocalPort)"
    remote = "$($_.RemoteAddress):$($_.RemotePort)"
    state = [string]$_.State
  })
}
Get-NetUDPEndpoint -ErrorAction SilentlyContinue | ForEach-Object {
  $procId = [int]$_.OwningProcess
  $rows.Add([pscustomobject]@{
    proto = 'UDP'
    process = (Resolve-ProcName $procId)
    pid = $procId
    local = "$($_.LocalAddress):$($_.LocalPort)"
    remote = '-'
    state = 'Listen'
  })
}
$adapters = @()
Get-NetAdapterStatistics -ErrorAction SilentlyContinue | ForEach-Object {
  $adapters += [pscustomobject]@{
    name = $_.Name
    rx_bytes = [int64]$_.ReceivedBytes
    tx_bytes = [int64]$_.SentBytes
  }
}
[pscustomobject]@{
  connections = $rows
  adapters = $adapters
  captured_at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
} | ConvertTo-Json -Compress -Depth 4
`.trim();
}

/** One CIM query; joined in JS by PID. Not part of the per-snapshot TCP script. */
function buildServiceScript() {
  return `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance -ClassName Win32_Service -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -gt 0 } |
  Select-Object Name, ProcessId |
  ConvertTo-Json -Compress -Depth 2
`.trim();
}

function parseServiceRows(text) {
  const map = new Map();
  if (!text) return map;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return map;
  }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    const pid = Number(s.ProcessId ?? s.processId ?? s.pid);
    const name = String(s.Name ?? s.name ?? "").trim();
    if (!Number.isFinite(pid) || pid <= 0 || !name) continue;
    const prev = map.get(pid);
    map.set(pid, prev ? `${prev}, ${name}` : name);
  }
  return map;
}

function ensureServiceMap() {
  if (serviceMapPromise) return serviceMapPromise;
  // ponytail: CIM once per process lifetime after success; retry next snapshot on failure
  serviceMapPromise = (async () => {
    if (process.platform !== "win32") return new Map();
    const { stdout } = await runPowerShell(buildServiceScript(), SERVICE_TIMEOUT_MS);
    return parseServiceRows(String(stdout || "").trim());
  })().then(
    (map) => map,
    () => {
      serviceMapPromise = null;
      return new Map();
    }
  );
  return serviceMapPromise;
}

async function runUnixConnectionSnapshot() {
  const timeout = SNAPSHOT_TIMEOUT_MS;
  let out = "";
  try {
    const { stdout } = await execFileAsync("ss", ["-tunap"], { timeout, maxBuffer: MAX_STDOUT });
    out = String(stdout || "");
  } catch {
    try {
      const { stdout } = await execFileAsync("ss", ["-tuna"], { timeout, maxBuffer: MAX_STDOUT });
      out = String(stdout || "");
    } catch {
      // ss unavailable — try lsof fallback
      try {
        const { stdout } = await execFileAsync("lsof", ["-i", "-n", "-P"], { timeout, maxBuffer: MAX_STDOUT });
        out = String(stdout || "");
      } catch {
        out = "";
      }
    }
  }
  const rows = parseUnixConnectionOutput(out);
  const adapters = await runUnixAdapters();
  return JSON.stringify({ connections: rows, adapters, captured_at: Date.now() });
}

function parseUnixConnectionOutput(text) {
  const rows = [];
  if (!text) return rows;
  const lines = text.split(/\r?\n/);
  const isLsof = lines[0] && lines[0].trim().startsWith("COMMAND");
  for (const line of lines) {
    const parsed = isLsof ? parseLsofLine(line) : parseSsLine(line);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

function parseSsLine(line) {
  // Skip headers and empty lines.
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("Netid ") || trimmed.startsWith("State ")) return null;
  const m = trimmed.match(/^\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+)(?:\s+(.+))?$/);
  if (!m) return null;
  const [, local, remote, rest] = m;
  const process = rest ? (rest.match(/users:\(\["([^"]+)"/) || [])[1] || "" : "";
  const pid = rest ? (rest.match(/pid=(\d+)/) || [])[1] || "0" : "0";
  const stateToken = trimmed.split(/\s+/)[0];
  const proto = /udp/i.test(stateToken) ? "UDP" : "TCP";
  const rawState = trimmed.split(/\s+/)[0].toUpperCase();
  let state = "";
  if (proto === "TCP") {
    if (/ESTAB|ESTABLISHED/i.test(trimmed)) state = "Established";
    else if (/LISTEN|UNCONN/i.test(trimmed)) state = "Listen";
    else if (/TIME-WAIT/i.test(trimmed)) state = "TimeWait";
    else if (/CLOSE-WAIT|CLOSING|LAST-ACK|FIN-WAIT/i.test(trimmed)) state = "CloseWait";
    else state = rawState;
  } else {
    state = "Listen";
  }
  return {
    proto,
    process: process || "?",
    pid: Number(pid) || 0,
    local: normalizeEndpoint(local),
    remote: normalizeEndpoint(remote) || "-",
    state,
  };
}

function parseLsofLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 9 || parts[4] !== "IPv4") return null;
  const proto = String(parts[7] || "").toUpperCase();
  if (proto !== "TCP" && proto !== "UDP") return null;
  const process = String(parts[0] || "");
  const pid = Number(parts[1]) || 0;
  const name = String(parts[8] || "");
  const [local, remote] = name.split("->");
  const state = proto === "UDP" ? "Listen" : (String(parts[9] || "").replace(/\(/g, "").replace(/\)/g, "") || "Established");
  return {
    proto,
    process,
    pid,
    local: normalizeEndpoint(local),
    remote: remote ? normalizeEndpoint(remote) : "-",
    state,
  };
}

function normalizeEndpoint(ep) {
  const s = String(ep || "").trim();
  if (s === "*.*" || s === "*:*" || s === "0.0.0.0:*") return "0.0.0.0:*";
  return s;
}

async function runUnixAdapters() {
  const timeout = SNAPSHOT_TIMEOUT_MS;
  let text = "";
  // Linux: ip -s link show
  try {
    const { stdout } = await execFileAsync("ip", ["-s", "link", "show"], { timeout, maxBuffer: MAX_STDOUT });
    text = String(stdout || "");
  } catch {
    // macOS: netstat -ib
    try {
      const { stdout } = await execFileAsync("netstat", ["-ib"], { timeout, maxBuffer: MAX_STDOUT });
      text = String(stdout || "");
    } catch {
      text = "";
    }
  }
  return parseUnixAdapters(text);
}

function parseUnixAdapters(text) {
  const adapters = [];
  if (!text) return adapters;
  if (text.includes("link/")) {
    // ip -s link output
    const lines = text.split(/\r?\n/);
    let current = null;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\d+:\s+([^:@\s]+)[@:]/);
      if (m) {
        if (current) adapters.push(current);
        current = { name: m[1], rx_bytes: 0, tx_bytes: 0 };
      } else if (current && /^\s+RX:\s+bytes/.test(lines[i])) {
        const next = lines[i + 1];
        if (next) {
          const parts = next.trim().split(/\s+/);
          current.rx_bytes = Number(parts[0]) || 0;
        }
      } else if (current && /^\s+TX:\s+bytes/.test(lines[i])) {
        const next = lines[i + 1];
        if (next) {
          const parts = next.trim().split(/\s+/);
          current.tx_bytes = Number(parts[0]) || 0;
        }
      }
    }
    if (current) adapters.push(current);
  } else {
    // netstat -ib output: Name  Mtu   Network       Address            Ipkts Ibytes   Opkts Obytes  Coll
    const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith("Name"));
    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      if (p.length < 8) continue;
      const name = String(p[0] || "").trim();
      const rx = Number(p[5]) || 0;
      const tx = Number(p[7]) || 0;
      adapters.push({ name, rx_bytes: rx, tx_bytes: tx });
    }
  }
  return adapters;
}

async function captureSnapshot() {
  if (runPowerShellOverride) {
    const { stdout } = await runPowerShell(buildSnapshotScript(), SNAPSHOT_TIMEOUT_MS);
    return { text: String(stdout || "").trim(), serviceMap: await ensureServiceMap() };
  }
  if (process.platform === "win32") {
    const [{ stdout }, serviceMap] = await Promise.all([
      runPowerShell(buildSnapshotScript(), SNAPSHOT_TIMEOUT_MS),
      ensureServiceMap(),
    ]);
    return { text: String(stdout || "").trim(), serviceMap };
  }
  const text = await runUnixConnectionSnapshot();
  return { text, serviceMap: new Map() };
}

function shapeConnectionRow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pid = Number(raw.pid ?? raw.Pid ?? raw.OwningProcess);
  return {
    proto: String(raw.proto || raw.Proto || "TCP").toUpperCase(),
    process: String(raw.process || raw.Process || "?").slice(0, 128),
    pid: Number.isFinite(pid) ? pid : 0,
    local: String(raw.local || raw.Local || "").slice(0, 128),
    remote: String(raw.remote || raw.Remote || "-").slice(0, 128),
    state: String(raw.state || raw.State || "").slice(0, 32),
  };
}

/**
 * Cap + optional Established-only filter. Stable sort: Established first, then process.
 */
function shapeConnections(rawList, { establishedOnly = false, cap = ROW_CAP } = {}) {
  const list = Array.isArray(rawList) ? rawList : rawList ? [rawList] : [];
  let rows = list.map(shapeConnectionRow).filter(Boolean);
  if (establishedOnly) {
    rows = rows.filter(
      (r) => r.proto === "UDP" || String(r.state).toLowerCase() === "established"
    );
  }
  rows.sort((a, b) => {
    const ae = String(a.state).toLowerCase() === "established" ? 0 : 1;
    const be = String(b.state).toLowerCase() === "established" ? 0 : 1;
    if (ae !== be) return ae - be;
    return String(a.process).localeCompare(String(b.process)) || a.pid - b.pid;
  });
  const truncated = rows.length > cap;
  return { rows: rows.slice(0, cap), truncated, total: rows.length };
}

function computeAdapterRates(adapters, nowMs, { track = true } = {}) {
  const list = Array.isArray(adapters) ? adapters : adapters ? [adapters] : [];
  const current = new Map();
  for (const a of list) {
    if (!a || !a.name) continue;
    const rx = Number(a.rx_bytes ?? a.ReceivedBytes ?? 0);
    const tx = Number(a.tx_bytes ?? a.SentBytes ?? 0);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    current.set(String(a.name), { rx, tx });
  }

  const out = [];
  const prev = lastAdapterSample;
  const dtSec =
    prev && prev.at > 0 ? Math.max(0.001, (nowMs - prev.at) / 1000) : null;

  for (const [name, cur] of current) {
    let rx_mbps = null;
    let tx_mbps = null;
    if (dtSec != null && prev.adapters.has(name)) {
      const p = prev.adapters.get(name);
      const drx = Math.max(0, cur.rx - p.rx);
      const dtx = Math.max(0, cur.tx - p.tx);
      rx_mbps = (drx * 8) / (dtSec * 1e6);
      tx_mbps = (dtx * 8) / (dtSec * 1e6);
    }
    out.push({
      name,
      rx_bytes: cur.rx,
      tx_bytes: cur.tx,
      rx_mbps,
      tx_mbps,
    });
  }

  if (track) lastAdapterSample = { at: nowMs, adapters: current };
  out.sort((a, b) => {
    const ar = (a.rx_mbps || 0) + (a.tx_mbps || 0);
    const br = (b.rx_mbps || 0) + (b.tx_mbps || 0);
    return br - ar || a.name.localeCompare(b.name);
  });
  return out;
}

function parseEndpoint(ep) {
  const s = String(ep || "").trim();
  if (!s || s === "-") return { ip: "", port: null };
  if (s.startsWith("[")) {
    const m = /^\[([^\]]+)\]:(\d+)$/.exec(s);
    if (m) return { ip: m[1].split("%")[0], port: Number(m[2]) };
  }
  const i = s.lastIndexOf(":");
  if (i <= 0) return { ip: s.replace(/^\[|\]$/g, "").split("%")[0], port: null };
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { ip: s.replace(/^\[|\]$/g, "").split("%")[0], port: null };
  }
  return { ip: s.slice(0, i).replace(/^\[|\]$/g, "").split("%")[0], port };
}

function portNameForRow(row) {
  const rem = parseEndpoint(row.remote);
  const loc = parseEndpoint(row.local);
  if (row.remote && row.remote !== "-" && rem.port != null && WELL_KNOWN_PORTS[rem.port]) {
    return WELL_KNOWN_PORTS[rem.port];
  }
  if (loc.port != null && WELL_KNOWN_PORTS[loc.port]) return WELL_KNOWN_PORTS[loc.port];
  return null;
}

function connectionKey(row) {
  return `${row.proto}|${row.pid}|${row.local}|${row.remote}`;
}

function isNonResolvableIp(ip) {
  if (!ip) return true;
  if (ip === "0.0.0.0" || ip === "::" || ip === "::0") return true;
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (ip.startsWith("127.")) return true;
  return false;
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      }
    );
  });
}

async function reverseLookup(ip, timeoutMs) {
  const work = reverseLookupOverride
    ? reverseLookupOverride(ip, timeoutMs)
    : dns.reverse(ip).then((names) => (names && names[0]) || null, () => null);
  return withTimeout(Promise.resolve(work), timeoutMs);
}

function attachPortAndService(rows, serviceMap) {
  for (const r of rows) {
    r.portName = portNameForRow(r);
    const svc = serviceMap && serviceMap.get(r.pid);
    r.serviceName = svc || null;
    r.resolved = r.resolved ?? null;
    r.delta = r.delta ?? null;
  }
}

async function attachResolved(rows, { timeoutMs = DNS_TIMEOUT_MS, cap = DNS_LOOKUP_CAP } = {}) {
  const unique = [];
  const seen = new Set();
  for (const r of rows) {
    const { ip } = parseEndpoint(r.remote);
    if (!ip || !net.isIP(ip) || isNonResolvableIp(ip)) continue;
    if (dnsCache.has(ip) || seen.has(ip)) continue;
    seen.add(ip);
    unique.push(ip);
    if (unique.length >= cap) break;
  }
  await Promise.all(
    unique.map(async (ip) => {
      const name = await reverseLookup(ip, timeoutMs);
      const cleaned =
        typeof name === "string" && name.trim()
          ? name.trim().replace(/\.$/, "").slice(0, 253)
          : null;
      dnsCache.set(ip, cleaned);
    })
  );
  for (const r of rows) {
    const { ip } = parseEndpoint(r.remote);
    r.resolved = ip && dnsCache.has(ip) ? dnsCache.get(ip) : null;
  }
}

function applySnapshotDelta(rows) {
  const curr = new Map();
  for (const r of rows) curr.set(connectionKey(r), r);
  const prev = lastConnRows;
  if (!prev) {
    lastConnRows = curr;
    for (const r of rows) r.delta = null;
    return rows;
  }
  const out = [];
  for (const r of rows) {
    const old = prev.get(connectionKey(r));
    r.delta = !old ? "new" : old.state !== r.state ? "state-changed" : null;
    out.push(r);
  }
  for (const [k, old] of prev) {
    if (!curr.has(k)) out.push({ ...old, delta: "dropped" });
  }
  lastConnRows = curr;
  return out;
}

/**
 * @param {{ establishedOnly?: boolean, resolveDns?: boolean, trackDelta?: boolean, trackAdapters?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, connections: object[], adapters: object[], truncated: boolean, total: number, captured_at: number, warning?: string, error?: string }>}
 */
async function snapshot(opts = {}) {
  const establishedOnly = !!opts.establishedOnly;
  const resolveDns = !!opts.resolveDns;
  const trackDelta = !!opts.trackDelta;
  const trackAdapters = !!opts.trackAdapters;
  const nowMs = Date.now();
  try {
    const { text, serviceMap } = await captureSnapshot();
    if (!text) {
      return {
        ok: false,
        connections: [],
        adapters: [],
        truncated: false,
        total: 0,
        captured_at: nowMs,
        warning: "Empty PowerShell response",
        error: "empty",
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        connections: [],
        adapters: [],
        truncated: false,
        total: 0,
        captured_at: nowMs,
        warning: "Could not parse connection snapshot",
        error: "parse",
      };
    }
    const shaped = shapeConnections(parsed.connections, { establishedOnly });
    attachPortAndService(shaped.rows, serviceMap);
    if (resolveDns) await attachResolved(shaped.rows);
    else for (const r of shaped.rows) r.resolved = null;
    const rows = trackDelta ? applySnapshotDelta(shaped.rows) : shaped.rows;
    const adapters = computeAdapterRates(parsed.adapters, Number(parsed.captured_at) || nowMs, {
      track: trackAdapters,
    });
    return {
      ok: true,
      connections: rows,
      adapters,
      truncated: shaped.truncated,
      total: shaped.total,
      captured_at: Number(parsed.captured_at) || nowMs,
      warning: shaped.truncated ? `Showing first ${ROW_CAP} of ${shaped.total} rows` : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      connections: [],
      adapters: [],
      truncated: false,
      total: 0,
      captured_at: nowMs,
      warning: String((err && err.message) || err || "snapshot failed"),
      error: "timeout_or_spawn",
    };
  }
}

module.exports = {
  snapshot,
  shapeConnections,
  shapeConnectionRow,
  computeAdapterRates,
  buildSnapshotScript,
  buildServiceScript,
  parseUnixConnectionOutput,
  parseUnixAdapters,
  normalizeEndpoint,
  setRunPowerShellForTest,
  setReverseLookupForTest,
  resetRunPowerShellForTest,
  ROW_CAP,
  SNAPSHOT_TIMEOUT_MS,
  DNS_LOOKUP_CAP,
  DNS_TIMEOUT_MS,
  RESOLVE_DNS_SETTING,
};
