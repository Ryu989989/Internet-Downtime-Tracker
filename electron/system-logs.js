"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

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

const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
const MAX_GAPS = 200;
const SCAN_TIMEOUT_MS = 45_000;
const MERGE_GAP_MS = 60_000;

/** @type {{ from: number, to: number, scanned_at: number, gaps: object[], sources: string[], warnings: string[] } | null} */
let cache = null;

const DISCONNECT_IDS = new Set([10001, 8003, 11004, 27, 32, 4202]);
const CONNECT_IDS = new Set([10000, 8001, 8000, 8002, 11000, 11001, 11005, 4201, 107, 12013]);
const FAIL_IDS = new Set([11002, 11006]);
const SLEEP_IDS = new Set([42]);

const QUERY_SPECS = [
  {
    log: "Microsoft-Windows-NetworkProfile/Operational",
    ids: [10000, 10001],
    label: "NetworkProfile",
  },
  {
    log: "Microsoft-Windows-WLAN-AutoConfig/Operational",
    ids: [8001, 8003, 8000, 8002, 11000, 11001, 11002, 11004, 11005, 11006, 12013],
    label: "WLAN",
  },
  {
    log: "System",
    ids: [27, 32, 4201, 4202],
    providers: ["Tcpip", "NDIS", "Dhcp-Client", "e1dexpress", "Netwtw04", "Netwtw06", "Netwtw10", "Netwtw12", "Netwtw14"],
    label: "System/NIC",
  },
  {
    log: "System",
    ids: [42, 107],
    providers: ["Microsoft-Windows-Kernel-Power"],
    label: "Kernel-Power",
  },
];

function classifyEvent(id) {
  const n = Number(id);
  if (DISCONNECT_IDS.has(n)) return "disconnect";
  if (CONNECT_IDS.has(n)) return "connect";
  if (FAIL_IDS.has(n)) return "fail";
  if (SLEEP_IDS.has(n)) return "sleep";
  return null;
}

function shortReason(ev) {
  const msg = String(ev.message || "").replace(/\s+/g, " ").trim();
  const head = msg.slice(0, 160);
  if (head) return head;
  return `Event ${ev.id} (${ev.provider || ev.source || "unknown"})`;
}

/**
 * Merge overlapping / adjacent intervals.
 * Intervals: { started_at, ended_at, duration_ms?, source?, reason? }
 * Times are unix seconds.
 */
function mergeGaps(intervals, { adjacencyMs = MERGE_GAP_MS } = {}) {
  if (!Array.isArray(intervals) || intervals.length === 0) return [];
  const sorted = intervals
    .map((g) => ({
      started_at: Number(g.started_at),
      ended_at: g.ended_at == null ? null : Number(g.ended_at),
      source: g.source || "",
      reason: g.reason || "",
    }))
    .filter((g) => Number.isFinite(g.started_at))
    .sort((a, b) => a.started_at - b.started_at || (a.ended_at ?? Infinity) - (b.ended_at ?? Infinity));

  const out = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (!last) {
      out.push({ ...cur });
      continue;
    }
    const lastEnd = last.ended_at;
    const adjSec = adjacencyMs / 1000;
    const overlaps =
      lastEnd == null ||
      cur.started_at <= lastEnd + adjSec ||
      (cur.ended_at == null && lastEnd == null);
    if (overlaps) {
      if (last.ended_at == null || cur.ended_at == null) {
        last.ended_at = null;
      } else {
        last.ended_at = Math.max(last.ended_at, cur.ended_at);
      }
      last.started_at = Math.min(last.started_at, cur.started_at);
      if (cur.source && last.source && !last.source.includes(cur.source)) {
        last.source = `${last.source}, ${cur.source}`;
      } else if (cur.source && !last.source) {
        last.source = cur.source;
      }
      if (cur.reason && (!last.reason || cur.reason.length > last.reason.length)) {
        last.reason = cur.reason;
      }
    } else {
      out.push({ ...cur });
    }
  }

  return out.map((g) => ({
    ...g,
    duration_ms:
      g.ended_at == null
        ? null
        : Math.max(0, Math.round((g.ended_at - g.started_at) * 1000)),
  }));
}

/**
 * Convert classified timeline events into disconnect intervals.
 * events: { time: unixSec, kind: 'disconnect'|'connect', source, reason, id }
 */
function eventsToGaps(events, { nowSec = Date.now() / 1000 } = {}) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const sorted = [...events]
    .filter((e) => e && (e.kind === "disconnect" || e.kind === "connect") && Number.isFinite(Number(e.time)))
    .map((e) => ({
      time: Number(e.time),
      kind: e.kind,
      source: e.source || "",
      reason: e.reason || "",
      id: e.id,
    }))
    .sort((a, b) => a.time - b.time);

  const gaps = [];
  let open = null;
  for (const ev of sorted) {
    if (ev.kind === "disconnect") {
      if (!open) {
        open = {
          started_at: ev.time,
          ended_at: null,
          source: ev.source,
          reason: ev.reason,
        };
      }
    } else if (ev.kind === "connect") {
      if (open) {
        open.ended_at = ev.time;
        if (open.ended_at > open.started_at) gaps.push(open);
        open = null;
      }
    }
  }
  if (open) {
    open.ended_at = nowSec;
    open.reason = (open.reason ? open.reason + " · " : "") + "still open or no reconnect logged";
    gaps.push(open);
  }
  return mergeGaps(gaps);
}

function normalizeRawEvents(rawList) {
  const list = Array.isArray(rawList) ? rawList : rawList ? [rawList] : [];
  const out = [];
  for (const raw of list) {
    if (!raw) continue;
    const id = raw.Id != null ? raw.Id : raw.id;
    const kind = classifyEvent(id);
    if (!kind) continue;
    const timeCreated = raw.TimeCreated || raw.timeCreated || raw.time;
    let timeSec;
    if (typeof timeCreated === "number") {
      timeSec = timeCreated > 1e12 ? timeCreated / 1000 : timeCreated;
    } else if (typeof timeCreated === "string") {
      // /Date(ms)/ or ISO
      const m = /\/Date\((-?\d+)\)\//.exec(timeCreated);
      if (m) timeSec = Number(m[1]) / 1000;
      else {
        const t = Date.parse(timeCreated);
        if (Number.isNaN(t)) continue;
        timeSec = t / 1000;
      }
    } else continue;

    const provider = raw.ProviderName || raw.providerName || raw.provider || "";
    const source = raw._sourceLabel || provider || "Windows";
    const eventData =
      raw.EventData != null ? raw.EventData : raw.eventData != null ? raw.eventData : null;
    out.push({
      time: timeSec,
      kind,
      id: Number(id),
      source,
      reason: shortReason({
        message: raw.Message || raw.message || "",
        id,
        provider,
        source,
      }),
      eventData,
    });
  }
  return out;
}

/** @type {null | typeof runPowerShell} */
let runPowerShellOverride = null;

function runPowerShell(script, timeoutMs) {
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
      reject(new Error(`Event log scan timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 8_000_000) {
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

function buildScanScript(fromDateIso, toDateIso) {
  // Emit JSON array of {TimeCreated,Id,ProviderName,Message,EventData,_sourceLabel}
  const specsJson = JSON.stringify(
    QUERY_SPECS.map((s) => ({
      LogName: s.log,
      Ids: s.ids,
      Providers: s.providers || null,
      Label: s.label,
    }))
  );
  return `
$ErrorActionPreference = 'SilentlyContinue'
$from = [datetime]::Parse('${fromDateIso}', [System.Globalization.CultureInfo]::InvariantCulture)
$to = [datetime]::Parse('${toDateIso}', [System.Globalization.CultureInfo]::InvariantCulture)
$specs = '${specsJson.replace(/'/g, "''")}' | ConvertFrom-Json
$all = @()
foreach ($s in $specs) {
  try {
    $hash = @{ LogName = $s.LogName; StartTime = $from; EndTime = $to; Id = @($s.Ids) }
    $evs = Get-WinEvent -FilterHashtable $hash -MaxEvents 400 -ErrorAction SilentlyContinue
    if (-not $evs) { continue }
    foreach ($e in $evs) {
      if ($s.Providers -and $s.Providers.Count -gt 0) {
        $ok = $false
        foreach ($p in $s.Providers) {
          if ($e.ProviderName -like $p -or $e.ProviderName -eq $p) { $ok = $true; break }
        }
        if (-not $ok) {
          # System NIC events: also accept common wireless/ethernet substrings
          if ($s.LogName -eq 'System' -and $s.Label -eq 'System/NIC') {
            $pn = [string]$e.ProviderName
            if ($pn -match 'Tcpip|NDIS|Dhcp|Netwtw|e1d|Intel|Realtek|Killer|Broadcom|Qualcomm|MediaTek|Wi-?Fi|Wireless') { $ok = $true }
          }
        }
        if (-not $ok) { continue }
      }
      $msg = if ($e.Message) { (($e.Message -replace '[\\r\\n]+',' ') -replace '\\s+',' ').Trim() } else { '' }
      if ($msg.Length -gt 800) { $msg = $msg.Substring(0, 800) }
      $edObj = $null
      try {
        $xml = [xml]$e.ToXml()
        $edMap = [ordered]@{}
        foreach ($d in @($xml.Event.EventData.Data)) {
          $n = $d.Name
          if (-not $n) { continue }
          $edMap[$n] = [string]$d.'#text'
        }
        if ($edMap.Count -gt 0) { $edObj = [pscustomobject]$edMap }
      } catch {}
      $all += [pscustomobject]@{
        TimeCreated = $e.TimeCreated.ToUniversalTime().ToString('o')
        Id = $e.Id
        ProviderName = $e.ProviderName
        Message = $msg
        EventData = $edObj
        _sourceLabel = $s.Label
      }
    }
  } catch {}
}
if ($all.Count -eq 0) { '[]' } else { $all | ConvertTo-Json -Compress -Depth 5 }
`.trim();
}

function clampRange(params = {}) {
  const now = Date.now() / 1000;
  let to = params.to != null ? Number(params.to) : now;
  let from = params.from != null ? Number(params.from) : to - DEFAULT_DAYS * 86400;
  if (!Number.isFinite(to)) to = now;
  if (!Number.isFinite(from)) from = to - DEFAULT_DAYS * 86400;
  if (from > to) [from, to] = [to, from];
  const maxSpan = MAX_DAYS * 86400;
  if (to - from > maxSpan) from = to - maxSpan;
  return { from, to };
}

function filterGaps(gaps, { minMs = 0, limit = MAX_GAPS } = {}) {
  let rows = gaps;
  if (minMs > 0) {
    rows = rows.filter((g) => (g.duration_ms == null ? true : g.duration_ms >= minMs));
  }
  rows = [...rows].sort((a, b) => b.started_at - a.started_at);
  if (limit > 0 && rows.length > limit) rows = rows.slice(0, limit);
  return rows;
}

async function scanWindowsLogs(params = {}) {
  if (process.platform !== "win32" && !runPowerShellOverride) {
    const { from, to } = clampRange(params);
    return {
      from,
      to,
      scanned_at: Date.now() / 1000,
      gaps: [],
      events: [],
      count: 0,
      event_count: 0,
      sources: [],
      warnings: ["System event log integration is only available on Windows."],
    };
  }
  const { from, to } = clampRange(params);
  const fromIso = new Date(from * 1000).toISOString();
  const toIso = new Date(to * 1000).toISOString();
  const warnings = [];
  const sourcesTried = QUERY_SPECS.map((s) => s.label);

  let raw;
  const runPs = runPowerShellOverride || runPowerShell;
  try {
    const { stdout, stderr } = await runPs(buildScanScript(fromIso, toIso), SCAN_TIMEOUT_MS);
    const text = stdout.trim();
    if (!text) {
      warnings.push(stderr.trim() || "No events returned (logs empty or inaccessible without elevation).");
      raw = [];
    } else {
      try {
        raw = JSON.parse(text);
      } catch {
        // PowerShell sometimes emits a BOM or trailing noise
        const start = text.indexOf("[");
        const end = text.lastIndexOf("]");
        if (start >= 0 && end > start) raw = JSON.parse(text.slice(start, end + 1));
        else throw new Error("Failed to parse event log JSON");
      }
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    warnings.push(msg);
    return {
      from,
      to,
      scanned_at: Date.now() / 1000,
      gaps: [],
      events: [],
      count: 0,
      event_count: 0,
      sources: sourcesTried,
      warnings,
    };
  }

  const events = normalizeRawEvents(raw);
  if (events.length === 0) {
    warnings.push(
      "No matching disconnect/connect events in this window. NIC may have stayed up, or those channels need elevation."
    );
  }

  let gaps = eventsToGaps(events, { nowSec: to });
  // Keep gaps that intersect the requested window
  gaps = gaps.filter((g) => {
    const end = g.ended_at == null ? to : g.ended_at;
    return end >= from && g.started_at <= to;
  });
  gaps = filterGaps(gaps, {
    minMs: params.min_ms != null ? Number(params.min_ms) : 0,
    limit: params.limit != null ? Number(params.limit) : MAX_GAPS,
  });

  const result = {
    from,
    to,
    scanned_at: Date.now() / 1000,
    gaps,
    events,
    count: gaps.length,
    event_count: events.length,
    sources: sourcesTried,
    warnings,
  };
  cache = result;
  return result;
}

function getCached(params = {}) {
  if (!cache) return null;
  const { from, to } = clampRange(params);
  // Return cache if it covers the requested range (same or wider)
  if (cache.from <= from + 1 && cache.to >= to - 1) {
    const gaps = filterGaps(cache.gaps, {
      minMs: params.min_ms != null ? Number(params.min_ms) : 0,
      limit: params.limit != null ? Number(params.limit) : MAX_GAPS,
    }).filter((g) => {
      const end = g.ended_at == null ? to : g.ended_at;
      return end >= from && g.started_at <= to;
    });
    return {
      ...cache,
      from,
      to,
      gaps,
      count: gaps.length,
      cached: true,
    };
  }
  return null;
}

async function getOrScan(params = {}) {
  if (params.refresh) return scanWindowsLogs(params);
  const hit = getCached(params);
  if (hit) return hit;
  return scanWindowsLogs(params);
}

function clearCache() {
  cache = null;
}

module.exports = {
  mergeGaps,
  eventsToGaps,
  normalizeRawEvents,
  classifyEvent,
  scanWindowsLogs,
  getOrScan,
  getCached,
  clearCache,
  powershellExe,
  QUERY_SPECS,
  setRunPowerShellForTest: (fn) => {
    runPowerShellOverride = fn;
  },
  resetRunPowerShellForTest: () => {
    runPowerShellOverride = null;
  },
  DEFAULT_DAYS,
  MAX_DAYS,
  MAX_GAPS,
  MERGE_GAP_MS,
};
