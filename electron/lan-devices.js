"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { normalizeMac, formatMac, lookupOui } = require("./oui");

const SNAPSHOT_TIMEOUT_MS = 10_000;
const MAX_STDOUT = 2_000_000;
const ONLINE_TTL_S = 600;

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
  return {
    mac,
    ip,
    vendor: lookupOui(mac),
    state: String((raw && (raw.state || raw.State)) || ""),
    iface: String((raw && (raw.iface || raw.InterfaceAlias)) || "").slice(0, 64),
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
 * Star map from Devices inventory when SNMP is off.
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
    nodes.push({
      ip,
      label: d.alias || d.vendor || ip,
      ok: !!(d.online === 1 || d.online === true),
      sysDescr: d.vendor || "",
      source: "neighbor",
    });
    if (gwIp && ip !== gwIp) {
      edges.push({ from: gwIp, to: ip, source: "neighbor" });
    }
  }
  return {
    ok: true,
    mode: "neighbor",
    warning:
      "SNMP disabled — showing Devices inventory star map. Enable SNMP in Settings for LLDP/sysDescr.",
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
  neighborTopologyFromDevices,
  setRunPowerShellForTest,
  resetRunPowerShellForTest,
  normalizeMac,
  formatMac,
  lookupOui,
};
