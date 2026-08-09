"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const SNAPSHOT_TIMEOUT_MS = 10_000;
const ROW_CAP = 200;
const MAX_STDOUT = 4_000_000;

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

/** @type {{ at: number, adapters: Map<string, {rx: number, tx: number}> } | null} */
let lastAdapterSample = null;

function setRunPowerShellForTest(fn) {
  runPowerShellOverride = fn;
}

function resetRunPowerShellForTest() {
  runPowerShellOverride = null;
  lastAdapterSample = null;
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

function computeAdapterRates(adapters, nowMs) {
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

  lastAdapterSample = { at: nowMs, adapters: current };
  out.sort((a, b) => {
    const ar = (a.rx_mbps || 0) + (a.tx_mbps || 0);
    const br = (b.rx_mbps || 0) + (b.tx_mbps || 0);
    return br - ar || a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * @param {{ establishedOnly?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, connections: object[], adapters: object[], truncated: boolean, total: number, captured_at: number, warning?: string, error?: string }>}
 */
async function snapshot(opts = {}) {
  const establishedOnly = !!opts.establishedOnly;
  const nowMs = Date.now();
  try {
    const { stdout } = await runPowerShell(buildSnapshotScript(), SNAPSHOT_TIMEOUT_MS);
    const text = String(stdout || "").trim();
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
    const adapters = computeAdapterRates(parsed.adapters, Number(parsed.captured_at) || nowMs);
    return {
      ok: true,
      connections: shaped.rows,
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
  setRunPowerShellForTest,
  resetRunPowerShellForTest,
  ROW_CAP,
  SNAPSHOT_TIMEOUT_MS,
};
