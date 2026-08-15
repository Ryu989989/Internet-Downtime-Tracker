"use strict";

/**
 * Devices-owned traceroute. Not in netcheck (pingHost/pingBurst only).
 * On-demand IPC — never snapshot() or monitor._tick.
 */

const { execFile } = require("child_process");
const net = require("net");
const { promisify } = require("util");
const { isPrivateOrLocalIp } = require("./port-scan");

const execFileAsync = promisify(execFile);

const MAX_HOPS = 15;
const HOP_TIMEOUT_MS = 2000;
const TOTAL_TIMEOUT_MS = 30_000;

/** @type {null | ((cmd: string, args: string[]) => Promise<{ stdout?: string } | string>)} */
let runOverride = null;

function setRunTracerouteForTest(fn) {
  runOverride = fn;
}

function resetRunTracerouteForTest() {
  runOverride = null;
}

function parseTraceroute(stdout) {
  const hops = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const hop = Number(m[1]);
    if (!Number.isFinite(hop) || hop < 1) continue;
    const rest = m[2];
    const ipM = rest.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
    const timedOut =
      !ipM && (/\*/.test(rest) || /timed out/i.test(rest) || /no response/i.test(rest));
    if (timedOut) {
      hops.push({ hop, ip: null, rtt_ms: null, timeout: true });
      continue;
    }
    const rtts = [...rest.matchAll(/<?([\d.]+)\s*ms/gi)].map((x) => Number(x[1]));
    const finite = rtts.filter((n) => Number.isFinite(n));
    hops.push({
      hop,
      ip: ipM ? ipM[1] : null,
      rtt_ms: finite.length ? Math.round(Math.min(...finite) * 10) / 10 : null,
      timeout: false,
    });
  }
  return hops;
}

function tracerouteArgs(host, { maxHops = MAX_HOPS, hopTimeoutMs = HOP_TIMEOUT_MS } = {}) {
  const hops = Math.min(30, Math.max(1, Number(maxHops) || MAX_HOPS));
  const wait = Math.min(10_000, Math.max(200, Number(hopTimeoutMs) || HOP_TIMEOUT_MS));
  if (process.platform === "win32") {
    return { cmd: "tracert", args: ["-d", "-h", String(hops), "-w", String(wait), host] };
  }
  return {
    cmd: "traceroute",
    args: ["-n", "-m", String(hops), "-w", String(Math.ceil(wait / 1000)), "-q", "1", host],
  };
}

function tracerouteTargetAllowed(host) {
  const bare = String(host || "").trim().replace(/^\[|\]$/g, "");
  if (!isPrivateOrLocalIp(bare)) return false;
  if (net.isIP(bare) === 6) return false;
  return true;
}

async function tracerouteHost(host, opts = {}) {
  const target = String(host || "").trim();
  const maxHops = Math.min(30, Math.max(1, Number(opts.maxHops) || MAX_HOPS));
  if (!target) return { ok: false, ip: "", error: "Missing host", hops: [], hop_limit: maxHops };
  if (!tracerouteTargetAllowed(target)) {
    return {
      ok: false,
      ip: target,
      error: "Target must be a private/local IP",
      hops: [],
      hop_limit: maxHops,
    };
  }
  const { cmd, args } = tracerouteArgs(target, { ...opts, maxHops });
  try {
    const run =
      runOverride ||
      ((c, a) =>
        execFileAsync(c, a, {
          timeout: TOTAL_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 1_000_000,
        }));
    const r = await run(cmd, args);
    const stdout = typeof r === "string" ? r : String((r && r.stdout) || "");
    const hops = parseTraceroute(stdout).slice(0, maxHops);
    return { ok: hops.length > 0, ip: target, hops, hop_limit: maxHops };
  } catch (err) {
    const stdout = String((err && err.stdout) || "");
    const hops = parseTraceroute(stdout).slice(0, maxHops);
    if (hops.length) return { ok: true, ip: target, hops, hop_limit: maxHops };
    return {
      ok: false,
      ip: target,
      error: (err && err.message) || "traceroute failed",
      hops: [],
      hop_limit: maxHops,
    };
  }
}

module.exports = {
  MAX_HOPS,
  HOP_TIMEOUT_MS,
  parseTraceroute,
  tracerouteArgs,
  tracerouteHost,
  setRunTracerouteForTest,
  resetRunTracerouteForTest,
};
