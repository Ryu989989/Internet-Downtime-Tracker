"use strict";

const { spawn } = require("child_process");

const DISCLAIMER =
  "Snapshot when you clicked — not a site survey. Hidden SSIDs may be missing. Not a heatmap or complete RF map.";

let runCmdOverride = null;

function setRunCmdForTest(fn) {
  runCmdOverride = typeof fn === "function" ? fn : null;
}

function resetRunCmdForTest() {
  runCmdOverride = null;
}

function normalizeMac(raw) {
  if (raw == null) return null;
  const hex = String(raw).toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return null;
  return hex.match(/../g).join(":");
}

function firstNumber(raw) {
  if (raw == null || raw === "") return null;
  const m = String(raw).match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function cleanSsid(raw) {
  if (raw == null) return null;
  const t = String(raw).trim().replace(/^"|"$/g, "");
  if (!t || /^(off\/any|n\/a|none)$/i.test(t)) return null;
  return t;
}

function bandFromChannel(channel, radioType) {
  const radio = String(radioType || "");
  if (/6\s*ghz|6e/i.test(radio)) return "6";
  if (/5\s*ghz/i.test(radio)) return "5";
  if (/2\.?4/i.test(radio)) return "2.4";
  if (channel == null) return null;
  if (channel >= 1 && channel <= 14) return "2.4";
  if (channel >= 32) return "5";
  return null;
}

function channelFromMhz(mhz) {
  if (mhz == null || !Number.isFinite(mhz)) return null;
  if (mhz >= 2400 && mhz < 2500) {
    if (Math.round(mhz) === 2484) return 14;
    const ch = Math.round((mhz - 2412) / 5) + 1;
    return ch >= 1 && ch <= 13 ? ch : null;
  }
  if (mhz >= 4900 && mhz < 5925) {
    const ch = Math.round((mhz - 5000) / 5);
    return ch > 0 ? ch : null;
  }
  if (mhz >= 5925 && mhz < 7200) {
    const ch = Math.round((mhz - 5955) / 5) + 1;
    return ch > 0 ? ch : null;
  }
  return null;
}

function bandFromMhz(mhz) {
  if (mhz == null || !Number.isFinite(mhz)) return null;
  if (mhz >= 2400 && mhz < 2500) return "2.4";
  if (mhz >= 4900 && mhz < 5925) return "5";
  if (mhz >= 5925 && mhz < 7200) return "6";
  return null;
}

function row({ ssid, bssid, channel, signal, rssi, security, band, radio_type }) {
  return {
    ssid: ssid || null,
    bssid: bssid || null,
    channel: channel != null ? channel : null,
    signal: signal != null ? signal : null,
    rssi: rssi != null ? rssi : null,
    security: security || null,
    band: band || null,
    radio_type: radio_type || null,
  };
}

/**
 * Parse `netsh wlan show networks mode=bssid`.
 * Signal is percent. rssi stays null unless a dBm token appears.
 */
function parseNetshWlanNetworks(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let ssid = null;
  let auth = null;
  let enc = null;
  let bssid = null;
  let signal = null;
  let radio = null;
  let channel = null;

  function flushBssid() {
    if (!bssid) return;
    const ch = channel != null ? Math.round(channel) : null;
    out.push(
      row({
        ssid,
        bssid,
        channel: ch,
        signal: signal != null ? Math.round(signal) : null,
        rssi: null,
        security: [auth, enc].filter(Boolean).join(" / ") || null,
        band: bandFromChannel(ch, radio),
        radio_type: radio,
      })
    );
    bssid = null;
    signal = null;
    radio = null;
    channel = null;
  }

  for (const line of lines) {
    const ssidM = line.match(/^\s*SSID\s+\d+\s*:\s*(.*)$/i);
    if (ssidM) {
      flushBssid();
      ssid = cleanSsid(ssidM[1]);
      auth = null;
      enc = null;
      continue;
    }
    const bssidM = line.match(/^\s*BSSID\s+\d+\s*:\s*(.+)$/i);
    if (bssidM) {
      flushBssid();
      bssid = normalizeMac(bssidM[1]);
      continue;
    }
    const kv = line.match(/^\s*([A-Za-z][A-Za-z0-9 .()/-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const val = kv[2].trim();
    if (key === "authentication") auth = val || null;
    else if (key === "encryption") enc = val || null;
    else if (key === "signal") signal = firstNumber(val);
    else if (key === "radio type") radio = val || null;
    else if (key === "channel") channel = firstNumber(val);
  }
  flushBssid();
  return out;
}

function parseIwScan(text) {
  const chunks = String(text || "").split(/(?=^BSS\s)/m);
  const out = [];
  for (const chunk of chunks) {
    if (!/^\s*BSS\s/i.test(chunk)) continue;
    const bssidM = chunk.match(/BSS\s+([0-9a-f:.-]+)/i);
    const freqM = chunk.match(/^\s*freq:\s*(\d+)/m);
    const rssiM = chunk.match(/^\s*signal:\s*(-?\d+(?:\.\d+)?)\s*dBm/m);
    const ssidM = chunk.match(/^\s*SSID:\s*(.*)$/m);
    const mhz = freqM ? Number(freqM[1]) : null;
    const hasRsn = /\bRSN:/i.test(chunk);
    const hasWpa = /\bWPA:/i.test(chunk);
    const security = hasRsn ? "RSN/WPA2+" : hasWpa ? "WPA" : null;
    const rssi = rssiM ? Number(rssiM[1]) : null;
    out.push(
      row({
        ssid: cleanSsid(ssidM && ssidM[1]),
        bssid: normalizeMac(bssidM && bssidM[1]),
        channel: channelFromMhz(mhz),
        signal: null,
        rssi: Number.isFinite(rssi) ? rssi : null,
        security,
        band: bandFromMhz(mhz),
      })
    );
  }
  return out;
}

function runCmd(cmd, args, timeoutMs) {
  if (runCmdOverride) {
    return Promise.resolve(runCmdOverride(cmd, args));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
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
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
      if (stdout.length > 2_000_000) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
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
        reject(new Error(stderr.trim() || `${cmd} exited ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function scanNearby() {
  const scanned_at = Date.now() / 1000;
  const base = { scanned_at, disclaimer: DISCLAIMER, networks: [], ok: false, warning: null };
  try {
    if (process.platform === "win32") {
      const text = await runCmd("netsh", ["wlan", "show", "networks", "mode=bssid"], 20_000);
      return { ...base, ok: true, networks: parseNetshWlanNetworks(text) };
    }
    let iface = null;
    try {
      const { getActiveAdapter } = require("./netcheck");
      const adapter = await getActiveAdapter();
      if (adapter && adapter.type === "wifi" && adapter.name) iface = adapter.name;
    } catch {
      /* ignore */
    }
    const args = iface ? ["dev", iface, "scan"] : ["scan"];
    const text = await runCmd("iw", args, 25_000);
    return { ...base, ok: true, networks: parseIwScan(text) };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return {
      ...base,
      ok: false,
      warning: msg || "Nearby BSS scan failed (may need privileges).",
    };
  }
}

module.exports = {
  DISCLAIMER,
  parseNetshWlanNetworks,
  parseIwScan,
  scanNearby,
  setRunCmdForTest,
  resetRunCmdForTest,
};
