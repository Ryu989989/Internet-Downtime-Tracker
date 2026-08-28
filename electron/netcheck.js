"use strict";

const { execFile } = require("child_process");
const dns = require("dns");
const http = require("http");
const https = require("https");
const net = require("net");
const { promisify } = require("util");
const { URL } = require("url");

const execFileAsync = promisify(execFile);

let runCmdOverride = null;

function setRunCmdForTest(fn) {
  runCmdOverride = fn || null;
}

function resetRunCmdForTest() {
  runCmdOverride = null;
}

const WAN_TARGETS = [
  ["1.1.1.1", 443],
  ["8.8.8.8", 53],
];
const TCP_TIMEOUT_MS = 2000;
const DNS_TIMEOUT_MS = 2000;
const HTTP_TIMEOUT_MS = 2000;
const DEFAULT_DNS_RESOLVER = "1.1.1.1";
const DEFAULT_DNS_NAME = "dns.google";
const DEFAULT_HTTP_URL = "http://connectivitycheck.gstatic.com/generate_204";

function looksLikeIpv4(value) {
  const parts = String(value).split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/** Deny loopback, RFC1918, and link-local targets for probe settings (SSRF guard). */
function isBlockedProbeHost(host) {
  if (host == null || typeof host !== "string") return true;
  const raw = host.trim().toLowerCase();
  if (!raw) return true;
  if (raw === "localhost" || raw.endsWith(".localhost") || raw.endsWith(".local")) {
    return true;
  }
  const bare = raw.replace(/^\[|\]$/g, "");
  if (bare === "::1") return true;
  if (bare.startsWith("fe80:")) return true;
  if (bare.startsWith("fc") || bare.startsWith("fd")) return true;
  if (looksLikeIpv4(bare)) {
    const parts = bare.split(".").map(Number);
    const [a, b] = parts;
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

function isBlockedHttpUrl(urlStr) {
  try {
    const u = new URL(String(urlStr));
    return isBlockedProbeHost(u.hostname);
  } catch {
    return true;
  }
}

function parseWanTargets(raw, fallback = WAN_TARGETS) {
  if (Array.isArray(raw) && raw.length) {
    const out = [];
    for (const item of raw) {
      if (Array.isArray(item) && item.length >= 2) {
        const host = String(item[0]).trim();
        const port = Number(item[1]);
        if (host && Number.isInteger(port) && port > 0 && port <= 65535) {
          out.push([host, port]);
        }
      }
    }
    return out.length ? out : fallback;
  }
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const out = [];
  for (const part of raw.split(",")) {
    const bit = part.trim();
    if (!bit) continue;
    const [host, portStr] = bit.split(":");
    const port = portStr != null ? Number(portStr) : 443;
    if (host && Number.isInteger(port) && port > 0 && port <= 65535) {
      out.push([host.trim(), port]);
    }
  }
  return out.length ? out : fallback;
}

/**
 * Hierarchical failure domain for a probe snapshot.
 * null = all layers OK (or unknown).
 */
function classifyDomain(result) {
  if (!result) return null;
  if (result.lan_ok === false) return "lan";
  if (result.lan_ok !== true) return null;
  if (result.wan_ok === false) return "wan";
  if (result.wan_ok !== true) return null;
  if (result.dns_ok === false) return "dns";
  if (result.dns_ok !== true) return null;
  if (result.http_ok === false) return "http";
  return null;
}

async function runCmd(cmd, args, timeoutMs = 5000) {
  if (runCmdOverride) return runCmdOverride(cmd, args, timeoutMs);
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    return String(stdout || "");
  } catch (err) {
    if (err && err.stdout) return String(err.stdout);
    return "";
  }
}

async function getDefaultGateway() {
  if (process.platform === "win32") {
    return gatewayWindows();
  }
  return gatewayUnix();
}

async function gatewayWindows() {
  const out = await runCmd("route", ["print", "0.0.0.0"]);
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3 && parts[0] === "0.0.0.0" && parts[1] === "0.0.0.0") {
      const gw = parts[2];
      if (looksLikeIpv4(gw) && !gw.startsWith("0.")) return gw;
    }
  }

  const ipcfg = await runCmd("ipconfig", []);
  const gateways = [];
  for (const line of ipcfg.split(/\r?\n/)) {
    if (/Default Gateway|Standardgateway/i.test(line)) {
      const m = line.match(/(\d+\.\d+\.\d+\.\d+)/);
      if (m) gateways.push(m[1]);
    }
  }
  return gateways[0] || null;
}

async function gatewayUnix() {
  let out = "";
  try {
    out = await runCmd("ip", ["route", "show", "default"]);
  } catch {
    /* ignore */
  }
  const m = out.match(/default via (\d+\.\d+\.\d+\.\d+)/);
  if (m) return m[1];
  // macOS/BSD fallback
  try {
    out = await runCmd("route", ["-n", "get", "default"]);
  } catch {
    return null;
  }
  const mm = out.match(/gateway:\s*(\d+\.\d+\.\d+\.\d+)/i);
  return mm ? mm[1] : null;
}

function tcpConnect(host, port, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const socket = net.connect({ host, port });
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (!ok) {
        resolve([false, null]);
        return;
      }
      const latency = Number(process.hrtime.bigint() - start) / 1e6;
      resolve([true, latency]);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function pingHost(host, timeoutS = 2.0) {
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const timeoutMs = Math.floor(timeoutS * 1000);
  const timeoutArg = isMac ? String(timeoutMs) : String(Math.floor(timeoutS));
  const args = isWin
    ? ["-n", "1", "-w", String(timeoutMs), host]
    : ["-c", "1", "-W", timeoutArg, host];
  const out = await runCmd("ping", args, (timeoutS + 2) * 1000);
  if (!out) return [false, null];
  const m = out.match(/time[=<]([\d.]+)\s*ms/i);
  const latency = m ? Number(m[1]) : null;
  let ok;
  if (isWin) {
    ok = /TTL=/i.test(out);
  } else {
    ok = /TTL=/i.test(out) || (m != null && !out.includes("100%"));
  }
  return [ok, latency];
}

/**
 * Summarize ICMP burst samples into loss / jitter / latency stats.
 * samples: [{ ok: boolean, latency_ms: number|null }, ...]
 */
function summarizePingBurst(samples, { target = null, at = null } = {}) {
  const list = Array.isArray(samples) ? samples : [];
  const sent = list.length;
  const lost = list.filter((s) => !s || !s.ok).length;
  const lats = list
    .filter((s) => s && s.ok && s.latency_ms != null && !Number.isNaN(Number(s.latency_ms)))
    .map((s) => Number(s.latency_ms));
  const loss_pct = sent ? Math.round((lost / sent) * 1000) / 10 : null;
  const latency_avg_ms =
    lats.length > 0
      ? Math.round((lats.reduce((a, b) => a + b, 0) / lats.length) * 10) / 10
      : null;
  const latency_ms = lats.length ? lats[lats.length - 1] : null;
  let jitter_ms = null;
  if (lats.length >= 2) {
    let sum = 0;
    for (let i = 1; i < lats.length; i++) sum += Math.abs(lats[i] - lats[i - 1]);
    jitter_ms = Math.round((sum / (lats.length - 1)) * 10) / 10;
  }
  return {
    target: target || null,
    loss_pct,
    jitter_ms,
    latency_ms,
    latency_avg_ms,
    samples: sent,
    lost,
    at: at != null ? at : Date.now() / 1000,
  };
}

/** Lightweight 4-ping burst to one public host — informational only. */
async function pingBurst(host = "1.1.1.1", { count = 4, timeoutS = 1.2 } = {}) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    const [ok, latency_ms] = await pingHost(host, timeoutS);
    samples.push({ ok: !!ok, latency_ms });
  }
  return summarizePingBurst(samples, { target: host });
}

function isMonitorStale({
  last_probe_at,
  poll_interval_s = 5,
  paused = false,
  probe_suppressed = false,
  now = Date.now() / 1000,
} = {}) {
  if (paused || probe_suppressed) return false;
  if (last_probe_at == null) return false;
  const interval = Math.max(2, Number(poll_interval_s) || 5);
  return now - Number(last_probe_at) > 2 * interval;
}

async function checkLan(gateway = null) {
  const gw = gateway || (await getDefaultGateway());
  if (!gw) return [false, null, null, null];

  const [pingOk, pingLat] = await pingHost(gw);
  if (pingOk) return [true, pingLat, gw, "icmp"];

  for (const port of [80, 53]) {
    const [ok, latency] = await tcpConnect(gw, port);
    if (ok) return [true, latency, gw, `tcp:${port}`];
  }
  return [false, null, gw, "failed"];
}

async function checkWan(targets = WAN_TARGETS) {
  const list = parseWanTargets(targets, WAN_TARGETS);
  let best = null;
  let anyOk = false;
  for (const [host, port] of list) {
    const [ok, latency] = await tcpConnect(host, port);
    if (ok) {
      anyOk = true;
      if (latency != null && (best == null || latency < best)) best = latency;
    }
  }
  return [anyOk, best];
}

/**
 * One A-record lookup against a configured resolver (or system DNS).
 */
async function checkDns({
  resolver = DEFAULT_DNS_RESOLVER,
  name = DEFAULT_DNS_NAME,
  timeoutMs = DNS_TIMEOUT_MS,
} = {}) {
  const start = process.hrtime.bigint();
  const r = new dns.promises.Resolver();
  const servers = resolver && String(resolver).trim() ? [String(resolver).trim()] : undefined;
  if (servers) {
    try {
      r.setServers(servers);
    } catch {
      return [false, null];
    }
  }
  try {
    const addrs = await Promise.race([
      r.resolve4(name),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("dns timeout")), timeoutMs);
      }),
    ]);
    const ok = Array.isArray(addrs) && addrs.length > 0;
    const latency = Number(process.hrtime.bigint() - start) / 1e6;
    return [ok, ok ? latency : null];
  } catch {
    return [false, null];
  }
}

const MS_PER_DAY = 86_400_000;

/** Remaining whole days until cert.valid_to; null if missing/unparseable. HTTP callers never use this. */
function peerCertDays(cert, nowMs = Date.now()) {
  if (!cert || typeof cert !== "object") return null;
  const raw = cert.valid_to;
  if (raw == null || raw === "") return null;
  const exp = Date.parse(raw);
  if (!Number.isFinite(exp)) return null;
  return Math.floor((exp - nowMs) / MS_PER_DAY);
}

function certDaysFromSocket(socket, nowMs = Date.now()) {
  if (!socket || typeof socket.getPeerCertificate !== "function") return null;
  try {
    return peerCertDays(socket.getPeerCertificate(), nowMs);
  } catch {
    return null;
  }
}

/**
 * Tiny HTTP(S) connectivity check (e.g. generate_204).
 * Returns [ok, latency, certDays|null]. HTTP URL → certDays null (never 0).
 * HTTPS: remaining days from peer cert on this response only (no second fetch).
 * `ca` / `rejectUnauthorized` are optional TLS overrides (tests / private CA).
 */
function checkHttp({
  url = DEFAULT_HTTP_URL,
  timeoutMs = HTTP_TIMEOUT_MS,
  ca,
  rejectUnauthorized,
} = {}) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url || DEFAULT_HTTP_URL);
    } catch {
      resolve([false, null, null]);
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      resolve([false, null, null]);
      return;
    }
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const start = process.hrtime.bigint();
    let settled = false;
    const finish = (ok, certDays = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (req) req.destroy();
      const latency = ok ? Number(process.hrtime.bigint() - start) / 1e6 : null;
      resolve([ok, latency, isHttps ? certDays : null]);
    };
    const timer = setTimeout(() => finish(false, null), timeoutMs);
    let req;
    try {
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname || "/"}${parsed.search || ""}`,
        method: "GET",
        timeout: timeoutMs,
        headers: { Connection: "close", "User-Agent": "InternetDowntimeTracker/1.0" },
      };
      if (isHttps && ca) opts.ca = ca;
      if (isHttps && rejectUnauthorized === false) opts.rejectUnauthorized = false;
      req = lib.request(opts, (res) => {
        // 204 preferred; 2xx/3xx still means the web path works.
        const code = res.statusCode || 0;
        res.resume();
        const certDays = isHttps ? certDaysFromSocket(res.socket || req.socket) : null;
        finish(code >= 200 && code < 400, certDays);
      });
      req.on("timeout", () => finish(false, null));
      req.on("error", () => finish(false, null));
      req.end();
    } catch {
      finish(false, null);
    }
  });
}

function emptyAdapter(extra) {
  return {
    name: null,
    type: null,
    description: null,
    signal: null,
    ssid: null,
    bssid: null,
    band: null,
    channel: null,
    rssi: null,
    tx_mbps: null,
    rx_mbps: null,
    mac: null,
    state: null,
    radio_type: null,
    auth: null,
    cipher: null,
    ...extra,
  };
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

function mhzFromFreq(rawGhz, rawMhz) {
  if (rawMhz != null && rawMhz !== "") {
    const n = Number(rawMhz);
    return Number.isFinite(n) ? n : null;
  }
  if (rawGhz == null || rawGhz === "") return null;
  const n = Number(rawGhz);
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
}

function bandFromMhz(mhz) {
  if (mhz == null) return null;
  if (mhz >= 2400 && mhz < 2500) return "2.4";
  if (mhz >= 4900 && mhz < 5925) return "5";
  if (mhz >= 5925 && mhz < 7200) return "6";
  return null;
}

function channelFromMhz(mhz) {
  if (mhz == null) return null;
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

function bandFromNetsh(channel, radioType, bandField) {
  const labeled = String(bandField || "");
  if (/6\s*ghz/i.test(labeled)) return "6";
  if (/5\s*ghz/i.test(labeled)) return "5";
  if (/2\.?4\s*ghz/i.test(labeled)) return "2.4";
  const radio = String(radioType || "");
  if (/6\s*ghz|6e/i.test(radio)) return "6";
  if (channel == null) return null;
  if (channel >= 1 && channel <= 14) return "2.4";
  if (channel >= 32) return "5";
  return null;
}

function colonFields(text) {
  const map = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    if (key) map[key] = line.slice(i + 1).trim();
  }
  return map;
}

function fillWifiGaps(target, extra) {
  if (!extra) return target;
  for (const key of [
    "ssid",
    "bssid",
    "band",
    "channel",
    "rssi",
    "signal",
    "tx_mbps",
    "rx_mbps",
    "mac",
    "state",
    "radio_type",
    "auth",
    "cipher",
  ]) {
    if (target[key] == null && extra[key] != null) target[key] = extra[key];
  }
  return target;
}

function cleanAdapterField(raw) {
  if (raw == null) return null;
  const t = String(raw).trim();
  return t ? t : null;
}

function parseWlanState(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (/\bdisconnected\b/.test(s)) return "disconnected";
  if (/\bconnected\b/.test(s)) return "connected";
  return null;
}

/** RSSI only from an explicit dBm token. Never convert Signal percent to dBm. */
function parseExplicitDbm(fields, block) {
  const rssiRaw = fields && fields.rssi;
  if (rssiRaw != null && String(rssiRaw).trim() !== "") {
    const rssiStr = String(rssiRaw);
    if (!/%/.test(rssiStr)) {
      const n = firstNumber(rssiStr);
      if (n != null && (/\bdBm\b/i.test(rssiStr) || n < 0)) return n;
    }
  }
  const signalRaw = fields && fields.signal != null ? String(fields.signal) : "";
  if (/\bdBm\b/i.test(signalRaw)) {
    const n = firstNumber(signalRaw);
    if (n != null) return n;
  }
  const m = String(block || "").match(/Signal level\s*[=:]\s*(-?\d+(?:\.\d+)?)\s*dBm/i);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseNetshWlanInterfaces(text) {
  const parts = String(text || "")
    .split(/(?=^\s*Name\s*:)/m)
    .filter((p) => /\bName\s*:/i.test(p));
  let block = parts[0] || text || "";
  for (const p of parts) {
    if (/^\s*State\s*:\s*connected\b/im.test(p)) {
      block = p;
      break;
    }
  }
  const f = colonFields(block);
  const channel = firstNumber(f.channel);
  const signalRaw = f.signal != null ? String(f.signal) : "";
  const signalIsDbm = /\bdBm\b/i.test(signalRaw);
  const signal = signalIsDbm ? null : firstNumber(f.signal);
  const rateRx = firstNumber(f["receive rate (mbps)"] != null ? f["receive rate (mbps)"] : f["receive rate"]);
  const rateTx = firstNumber(f["transmit rate (mbps)"] != null ? f["transmit rate (mbps)"] : f["transmit rate"]);
  return {
    ssid: cleanSsid(f.ssid),
    bssid: normalizeMac(f.bssid),
    band: bandFromNetsh(channel, f["radio type"], f.band),
    channel: channel != null ? Math.round(channel) : null,
    signal: signal != null ? Math.round(signal) : null,
    rssi: parseExplicitDbm(f, block),
    rx_mbps: rateRx,
    tx_mbps: rateTx,
    mac: normalizeMac(f["physical address"]),
    state: parseWlanState(f.state),
    radio_type: cleanAdapterField(f["radio type"]),
    auth: cleanAdapterField(f.authentication),
    cipher: cleanAdapterField(f.cipher),
  };
}

function parseIwconfigBlock(block) {
  const text = String(block || "");
  const ssidM = text.match(/ESSID:"([^"]*)"/i) || text.match(/ESSID:(\S+)/i);
  const apM = text.match(/Access Point:\s*([0-9A-Fa-f]{2}(?:[:.-][0-9A-Fa-f]{2}){5})/i);
  const ghzM = text.match(/Frequency:([\d.]+)\s*GHz/i);
  const mhzM = text.match(/Frequency:([\d.]+)\s*MHz/i);
  const chM = text.match(/Channel[=:](\d+)/i);
  const rateM = text.match(/Bit Rate[=:]([\d.]+)/i);
  const rssiM = text.match(/Signal level[=:](-?\d+(?:\.\d+)?)\s*dBm/i);
  const quality = text.match(/Link Quality[=:](\d+)\/(\d+)/i);
  const mhz = mhzFromFreq(ghzM && ghzM[1], mhzM && mhzM[1]);
  const rate = rateM ? Number(rateM[1]) : null;
  let signal = null;
  if (quality) signal = Math.round((Number(quality[1]) / Number(quality[2])) * 100);
  return {
    ssid: cleanSsid(ssidM && ssidM[1]),
    bssid: apM ? normalizeMac(apM[1]) : null,
    band: bandFromMhz(mhz),
    channel: chM ? Number(chM[1]) : channelFromMhz(mhz),
    rssi: rssiM ? Number(rssiM[1]) : null,
    signal,
    tx_mbps: Number.isFinite(rate) ? rate : null,
    rx_mbps: Number.isFinite(rate) ? rate : null,
    mac: null,
  };
}

function parseIwLink(text) {
  const s = String(text || "");
  if (!s.trim() || /^not connected\.?$/im.test(s.trim())) return null;
  const ssidM = s.match(/^\s*SSID:\s*(.+)$/m);
  const bssidM = s.match(/Connected to\s+([0-9A-Fa-f:.-]+)/i);
  const freqM = s.match(/^\s*freq:\s*(\d+)/m);
  const rssiM = s.match(/^\s*signal:\s*(-?\d+(?:\.\d+)?)\s*dBm/m);
  const rxM = s.match(/^\s*rx bitrate:\s*([\d.]+)/m);
  const txM = s.match(/^\s*tx bitrate:\s*([\d.]+)/m);
  const mhz = freqM ? Number(freqM[1]) : null;
  const rx = rxM ? Number(rxM[1]) : null;
  const tx = txM ? Number(txM[1]) : null;
  return {
    ssid: cleanSsid(ssidM && ssidM[1]),
    bssid: bssidM ? normalizeMac(bssidM[1]) : null,
    band: bandFromMhz(mhz),
    channel: channelFromMhz(mhz),
    rssi: rssiM ? Number(rssiM[1]) : null,
    signal: null,
    tx_mbps: Number.isFinite(tx) ? tx : null,
    rx_mbps: Number.isFinite(rx) ? rx : null,
    mac: null,
  };
}

function parseIwInfo(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  const ssidM = s.match(/^\s*ssid\s+(.+)$/m);
  const macM = s.match(/^\s*addr\s+([0-9A-Fa-f:.-]+)/m);
  const chM = s.match(/channel\s+(\d+)\s*\((\d+)\s*MHz\)/i);
  const mhz = chM ? Number(chM[2]) : null;
  return {
    ssid: cleanSsid(ssidM && ssidM[1]),
    bssid: null,
    band: bandFromMhz(mhz),
    channel: chM ? Number(chM[1]) : null,
    rssi: null,
    signal: null,
    tx_mbps: null,
    rx_mbps: null,
    mac: macM ? normalizeMac(macM[1]) : null,
  };
}

function parseMacFromIpLink(text) {
  const m = String(text || "").match(/link\/ether\s+([0-9A-Fa-f:.-]{11,})/i);
  return m ? normalizeMac(m[1]) : null;
}

function looksWifiName(name) {
  return /^(wl|wlan|ath|wifi)/i.test(String(name || ""));
}

function wlanTextFromPs(obj) {
  const v = obj && (obj.wlan != null ? obj.wlan : obj.Wlan);
  if (v == null) return "";
  return Array.isArray(v) ? v.join("\n") : String(v);
}

async function getActiveAdapterUnix() {
  const adapter = emptyAdapter();
  try {
    const out = await runCmd("ip", ["route", "get", "1.1.1.1"]);
    const m = out.match(/dev\s+(\S+)/);
    if (m) adapter.name = m[1];
  } catch {
    /* ignore */
  }
  if (!adapter.name) {
    try {
      const out = await runCmd("route", ["-n", "get", "default"]);
      const m = out.match(/interface:\s*(\S+)/i);
      if (m) adapter.name = m[1];
    } catch {
      /* ignore */
    }
  }
  if (adapter.name) {
    let wifi = null;
    try {
      const iw = await runCmd("iwconfig");
      const block = iw.split(/\n(?=\S)/).find((b) => b.includes(adapter.name));
      if (block) {
        wifi = parseIwconfigBlock(block);
        adapter.type = "wifi";
      }
    } catch {
      /* ignore */
    }
    if (adapter.type === "wifi" || looksWifiName(adapter.name)) {
      try {
        fillWifiGaps(wifi || (wifi = {}), parseIwLink(await runCmd("iw", ["dev", adapter.name, "link"])));
        fillWifiGaps(wifi, parseIwInfo(await runCmd("iw", ["dev", adapter.name, "info"])));
      } catch {
        /* ignore */
      }
    }
    if (wifi) fillWifiGaps(adapter, wifi);
    if (adapter.type !== "wifi" && wifi && (wifi.ssid || wifi.bssid || wifi.rssi != null || wifi.signal != null)) {
      adapter.type = "wifi";
    }
    try {
      const link = await runCmd("ip", ["link", "show", adapter.name]);
      if (!adapter.mac) adapter.mac = parseMacFromIpLink(link);
      if (!adapter.type) adapter.type = /wl/i.test(link) ? "wifi" : "ethernet";
    } catch {
      /* ignore */
    }
  }
  return adapter;
}

/**
 * Light adapter snapshot (cached by caller). Windows-focused.
 */
async function getActiveAdapter() {
  if (process.platform !== "win32") {
    return getActiveAdapterUnix();
  }
  try {
    const ps = [
      "$a = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.HardwareInterface } |",
      "  Sort-Object -Property InterfaceMetric | Select-Object -First 1;",
      "if (-not $a) { '{}'; exit 0 }",
      "$wlan = '';",
      "if ($a.MediaType -match 'Native 802.11|Wireless') {",
      "  $wlan = (netsh wlan show interfaces 2>$null | Out-String)",
      "}",
      "@{ name = $a.Name; type = $a.InterfaceDescription; media = [string]$a.MediaType; mac = [string]$a.MacAddress; wlan = $wlan } | ConvertTo-Json -Compress",
    ].join(" ");
    const out = await runCmd(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      8000
    );
    const json = out.trim();
    if (!json || json === "{}") return emptyAdapter();
    const obj = JSON.parse(json);
    const media = String(obj.media || obj.Media || "");
    const desc = obj.type || obj.Type || null;
    const kind = /802\.11|Wireless|Wi-?Fi/i.test(media) || /wi-?fi/i.test(String(desc || ""))
      ? "wifi"
      : "ethernet";
    const parsed = parseNetshWlanInterfaces(wlanTextFromPs(obj));
    const signal =
      parsed.signal != null
        ? parsed.signal
        : obj.signal != null
          ? Number(obj.signal)
          : null;
    return emptyAdapter({
      name: obj.name || obj.Name || null,
      type: kind,
      description: desc,
      signal: Number.isFinite(signal) ? signal : null,
      ssid: parsed.ssid,
      bssid: parsed.bssid,
      band: parsed.band,
      channel: parsed.channel,
      rssi: parsed.rssi,
      tx_mbps: parsed.tx_mbps,
      rx_mbps: parsed.rx_mbps,
      mac: normalizeMac(obj.mac || obj.Mac || obj.MacAddress) || parsed.mac,
      state: parsed.state,
      radio_type: parsed.radio_type,
      auth: parsed.auth,
      cipher: parsed.cipher,
    });
  } catch {
    return emptyAdapter();
  }
}

async function probe(gatewayResolverOrOptions = null, options = {}) {
  let resolver = getDefaultGateway;
  let opts = options || {};
  if (typeof gatewayResolverOrOptions === "function") {
    resolver = gatewayResolverOrOptions;
  } else if (
    gatewayResolverOrOptions &&
    typeof gatewayResolverOrOptions === "object"
  ) {
    opts = gatewayResolverOrOptions;
    if (typeof opts.gatewayResolver === "function") {
      resolver = opts.gatewayResolver;
    }
  }
  const wanTargets = parseWanTargets(opts.wanTargets, WAN_TARGETS);
  const dnsResolver = opts.dnsResolver || DEFAULT_DNS_RESOLVER;
  const httpUrl = opts.httpUrl || DEFAULT_HTTP_URL;

  const gwHint = await resolver();
  const [lanOk, lanLat, gw, method] = await checkLan(gwHint);

  let wanOk = false;
  let wanLat = null;
  let dnsOk = false;
  let dnsLat = null;
  let httpOk = false;
  let httpLat = null;
  let httpCertDays = null;

  if (lanOk) {
    [wanOk, wanLat] = await checkWan(wanTargets);
  }
  if (lanOk && wanOk) {
    [dnsOk, dnsLat] = await checkDns({ resolver: dnsResolver });
  }
  if (lanOk && wanOk && dnsOk) {
    [httpOk, httpLat, httpCertDays = null] = await checkHttp({ url: httpUrl });
  }

  const latency =
    lanLat != null ? lanLat : wanLat != null ? wanLat : dnsLat != null ? dnsLat : httpLat;

  return {
    lan_ok: lanOk,
    wan_ok: wanOk,
    dns_ok: dnsOk,
    http_ok: httpOk,
    http_cert_days: httpCertDays == null ? null : httpCertDays,
    gateway: gw,
    latency_ms: latency,
    lan_method: method,
    domain: classifyDomain({
      lan_ok: lanOk,
      wan_ok: wanOk,
      dns_ok: dnsOk,
      http_ok: httpOk,
    }),
  };
}

module.exports = {
  WAN_TARGETS,
  TCP_TIMEOUT_MS,
  DNS_TIMEOUT_MS,
  HTTP_TIMEOUT_MS,
  DEFAULT_DNS_RESOLVER,
  DEFAULT_DNS_NAME,
  DEFAULT_HTTP_URL,
  getDefaultGateway,
  tcpConnect,
  pingHost,
  summarizePingBurst,
  pingBurst,
  isMonitorStale,
  checkLan,
  checkWan,
  checkDns,
  checkHttp,
  tcpConnect,
  pingHost,
  peerCertDays,
  parseWanTargets,
  classifyDomain,
  isBlockedProbeHost,
  isBlockedHttpUrl,
  getActiveAdapter,
  parseNetshWlanInterfaces,
  emptyAdapter,
  fillWifiGaps,
  probe,
  setRunCmdForTest,
  resetRunCmdForTest,
};
