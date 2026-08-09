"use strict";

/**
 * Opt-in subnet discovery (ICMP/TCP ping) for local Unicast prefixes only.
 * Must call monitor.setProbeSuppress while running.
 */

const os = require("os");
const net = require("net");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { isPrivateOrLocalIp } = require("./port-scan");

const MIN_INTERVAL_MIN = 5;
const MAX_HOSTS = 256;
const PING_CONCURRENCY = 32;

let running = false;
let timer = null;

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

function ipv4ToInt(ip) {
  return ip.split(".").reduce((a, o) => (a << 8) + (Number(o) & 255), 0) >>> 0;
}

function intToIpv4(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function prefixHosts(cidr) {
  const [ip, bitsStr] = String(cidr).split("/");
  const bits = Number(bitsStr);
  if (!net.isIP(ip) || net.isIP(ip) !== 4 || !Number.isFinite(bits) || bits < 24 || bits > 30) {
    return [];
  }
  if (!isPrivateOrLocalIp(ip)) return [];
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const base = ipv4ToInt(ip) & mask;
  const size = 2 ** (32 - bits);
  const out = [];
  for (let i = 1; i < size - 1; i++) {
    out.push(intToIpv4(base + i));
    if (out.length >= MAX_HOSTS) break;
  }
  return out;
}

function localUnicastPrefixes() {
  const ifaces = os.networkInterfaces();
  const prefixes = [];
  for (const list of Object.values(ifaces || {})) {
    for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal) continue;
      if (!isPrivateOrLocalIp(a.address)) continue;
      // Derive /24 from address when netmask is typical LAN
      const parts = a.address.split(".").map(Number);
      prefixes.push(`${parts[0]}.${parts[1]}.${parts[2]}.0/24`);
    }
  }
  return [...new Set(prefixes)].slice(0, 4);
}

function tcpPing(host, port = 80, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const t = setTimeout(() => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(false);
    }, timeoutMs);
    sock.on("connect", () => {
      clearTimeout(t);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(true);
    });
    sock.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

async function icmpPing(host) {
  return new Promise((resolve) => {
    const ps = powershellExe();
    const child = spawn(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Test-Connection -ComputerName '${host.replace(/'/g, "")}' -Count 1 -Quiet`,
      ],
      { windowsHide: true }
    );
    let out = "";
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(false);
    }, 1500);
    child.stdout.on("data", (c) => {
      out += c.toString();
    });
    child.on("close", () => {
      clearTimeout(t);
      resolve(/True/i.test(out));
    });
    child.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

async function mapPool(items, limit, fn) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, () => worker()));
  return out;
}

/**
 * @param {{ setProbeSuppress?: (on: boolean, opts?: object) => void, onFound?: (ip: string) => void }} hooks
 */
async function runDiscovery(hooks = {}) {
  if (running) return { ok: false, error: "already running", found: [] };
  running = true;
  const found = [];
  try {
    if (hooks.setProbeSuppress) hooks.setProbeSuppress(true);
    const prefixes = localUnicastPrefixes();
    const hosts = [];
    for (const p of prefixes) {
      for (const h of prefixHosts(p)) {
        hosts.push(h);
        if (hosts.length >= MAX_HOSTS) break;
      }
      if (hosts.length >= MAX_HOSTS) break;
    }
    await mapPool(hosts, PING_CONCURRENCY, async (ip) => {
      const up = (await tcpPing(ip, 80)) || (await tcpPing(ip, 443)) || (await icmpPing(ip));
      if (up) {
        found.push(ip);
        if (hooks.onFound) hooks.onFound(ip);
      }
      return up;
    });
    return {
      ok: true,
      found,
      prefixes,
      badge: "active scan",
      disclaimer: "Active discovery — results are incomplete and opt-in.",
    };
  } finally {
    running = false;
    if (hooks.setProbeSuppress) {
      try {
        hooks.setProbeSuppress(false, { cooldownMs: 5000 });
      } catch {
        /* ignore */
      }
    }
  }
}

function schedule(intervalMin, hooks) {
  stopSchedule();
  const mins = Math.max(MIN_INTERVAL_MIN, Number(intervalMin) || MIN_INTERVAL_MIN);
  timer = setInterval(() => {
    runDiscovery(hooks).catch(() => {});
  }, mins * 60_000);
  if (timer.unref) timer.unref();
  return { ok: true, interval_min: mins };
}

function stopSchedule() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function isRunning() {
  return running;
}

module.exports = {
  MIN_INTERVAL_MIN,
  MAX_HOSTS,
  prefixHosts,
  localUnicastPrefixes,
  runDiscovery,
  schedule,
  stopSchedule,
  isRunning,
  ipv4ToInt,
  intToIpv4,
};
