"use strict";

const { execFile } = require("child_process");
const dns = require("dns");
const http = require("http");
const https = require("https");
const net = require("net");
const { promisify } = require("util");
const { URL } = require("url");

const execFileAsync = promisify(execFile);

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
  const out = await runCmd("ip", ["route", "show", "default"]);
  const m = out.match(/default via (\d+\.\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
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
  const args = isWin
    ? ["-n", "1", "-w", String(Math.floor(timeoutS * 1000)), host]
    : ["-c", "1", "-W", String(Math.floor(timeoutS)), host];
  let out = "";
  try {
    const r = await execFileAsync("ping", args, {
      timeout: (timeoutS + 2) * 1000,
      windowsHide: true,
    });
    out = String(r.stdout || "");
  } catch (err) {
    out = String((err && err.stdout) || "");
    if (!out) return [false, null];
  }
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

/**
 * Tiny HTTP(S) connectivity check (e.g. generate_204).
 */
function checkHttp({
  url = DEFAULT_HTTP_URL,
  timeoutMs = HTTP_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url || DEFAULT_HTTP_URL);
    } catch {
      resolve([false, null]);
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      resolve([false, null]);
      return;
    }
    const lib = parsed.protocol === "https:" ? https : http;
    const start = process.hrtime.bigint();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (req) req.destroy();
      const latency = ok ? Number(process.hrtime.bigint() - start) / 1e6 : null;
      resolve([ok, latency]);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    let req;
    try {
      req = lib.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: `${parsed.pathname || "/"}${parsed.search || ""}`,
          method: "GET",
          timeout: timeoutMs,
          headers: { Connection: "close", "User-Agent": "InternetDowntimeTracker/1.0" },
        },
        (res) => {
          // 204 preferred; 2xx/3xx still means the web path works.
          const code = res.statusCode || 0;
          res.resume();
          finish(code >= 200 && code < 400);
        }
      );
      req.on("timeout", () => finish(false));
      req.on("error", () => finish(false));
      req.end();
    } catch {
      finish(false);
    }
  });
}

/**
 * Light adapter snapshot (cached by caller). Windows-focused.
 */
async function getActiveAdapter() {
  if (process.platform !== "win32") {
    return { name: null, type: null, signal: null };
  }
  try {
    const ps = [
      "$a = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.HardwareInterface } |",
      "  Sort-Object -Property InterfaceMetric | Select-Object -First 1;",
      "if (-not $a) { '{}'; exit 0 }",
      "$sig = $null;",
      "if ($a.MediaType -match 'Native 802.11|Wireless') {",
      "  $w = netsh wlan show interfaces 2>$null | Select-String 'Signal\\s*:\\s*(\\d+)%';",
      "  if ($w) { $sig = [int]$w.Matches[0].Groups[1].Value }",
      "}",
      "@{ name = $a.Name; type = $a.InterfaceDescription; media = [string]$a.MediaType; signal = $sig } | ConvertTo-Json -Compress",
    ].join(" ");
    const out = await runCmd(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      8000
    );
    const json = out.trim();
    if (!json || json === "{}") return { name: null, type: null, signal: null };
    const obj = JSON.parse(json);
    const media = String(obj.media || "");
    const kind = /802\.11|Wireless|Wi-?Fi/i.test(media) || /wi-?fi/i.test(String(obj.type || ""))
      ? "wifi"
      : "ethernet";
    return {
      name: obj.name || null,
      type: kind,
      description: obj.type || null,
      signal: obj.signal != null ? Number(obj.signal) : null,
    };
  } catch {
    return { name: null, type: null, signal: null };
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

  if (lanOk) {
    [wanOk, wanLat] = await checkWan(wanTargets);
  }
  if (lanOk && wanOk) {
    [dnsOk, dnsLat] = await checkDns({ resolver: dnsResolver });
  }
  if (lanOk && wanOk && dnsOk) {
    [httpOk, httpLat] = await checkHttp({ url: httpUrl });
  }

  const latency =
    lanLat != null ? lanLat : wanLat != null ? wanLat : dnsLat != null ? dnsLat : httpLat;

  return {
    lan_ok: lanOk,
    wan_ok: wanOk,
    dns_ok: dnsOk,
    http_ok: httpOk,
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
  checkLan,
  checkWan,
  checkDns,
  checkHttp,
  parseWanTargets,
  classifyDomain,
  getActiveAdapter,
  probe,
};
