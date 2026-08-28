"use strict";

/**
 * Read-only Merlin/ASUS chanim via key-based OpenSSH.
 * No password on argv; no ssh2. Fail closed on public host / missing ssh / unreadable key.
 */

const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { isPrivateOrLocalIp } = require("./port-scan");

const execFileAsync = promisify(execFile);

const DEFAULT_IFACES = ["eth6", "eth5", "wl1", "wl0"];
const IFACE_RE = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;
const SSH_USER_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SSH_TIMEOUT_MS = 12000;
const MAX_IFACES = 8;

/** @type {null | ((call: { bin: string, argv: string[] }) => Promise<string>)} */
let runSshOverride = null;

function setRunSshForTest(fn) {
  runSshOverride = typeof fn === "function" ? fn : null;
}

function resetRunSshForTest() {
  runSshOverride = null;
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseIfaceList(raw) {
  let parts;
  if (Array.isArray(raw)) parts = raw;
  else {
    const s = String(raw || "").trim();
    if (!s) return DEFAULT_IFACES.slice();
    parts = s.split(/[,;\s]+/);
  }
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const iface = String(p || "").trim();
    if (!IFACE_RE.test(iface)) continue;
    const key = iface.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(iface);
    if (out.length >= MAX_IFACES) break;
  }
  return out.length ? out : DEFAULT_IFACES.slice();
}

function fromMap(map, iface) {
  const idle = numOrNull(map.idle);
  if (idle == null) return null;
  const noise = map.noise != null ? numOrNull(map.noise) : numOrNull(map.knoise);
  const row = {
    iface,
    radio: iface,
    idle,
    tx: numOrNull(map.tx),
    rx: numOrNull(map.rx),
    inbss: numOrNull(map.inbss),
    noise,
  };
  const spec = map.chanspec != null ? String(map.chanspec).trim() : "";
  if (spec) row.chanspec = spec.slice(0, 32);
  return row;
}

/** Parse `wl chanim_stats` table or key:value dump. Requires idle. */
function parseChanimStats(text, iface) {
  const raw = String(text || "");
  if (!raw.trim() || !IFACE_RE.test(iface)) return null;
  const kv = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_]+)\s*[:=]\s*(\S+)/);
    if (m) kv[m[1].toLowerCase()] = m[2];
  }
  if (kv.idle != null) return fromMap(kv, iface);
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split(/\s+/);
    const lower = cols.map((c) => c.toLowerCase());
    if (lower.indexOf("idle") < 0) continue;
    const data = lines[i + 1];
    if (!data) continue;
    const vals = data.split(/\s+/);
    const map = {};
    for (let j = 0; j < cols.length && j < vals.length; j++) map[lower[j]] = vals[j];
    return fromMap(map, iface);
  }
  return null;
}

function looksLikeKeyBlob(s) {
  return /BEGIN .+ PRIVATE KEY/i.test(s) || /[\r\n\0]/.test(s);
}

function keyPathOk(keyPath) {
  const p = String(keyPath || "").trim();
  if (!p || p === "-" || p.startsWith("-") || looksLikeKeyBlob(p)) return "";
  return p;
}

function sshDest(user, host) {
  const bare = String(host || "").trim().replace(/^\[|\]$/g, "");
  if (bare.includes(":")) return `${user}@[${bare}]`;
  return `${user}@${bare}`;
}

function buildSshArgv({ keyPath, user, host, iface }) {
  return [
    "-i",
    keyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=8",
    sshDest(user, host),
    "--",
    "wl",
    "-i",
    iface,
    "chanim_stats",
  ];
}

async function defaultRunner(call) {
  const { stdout } = await execFileAsync(call.bin, call.argv, {
    timeout: SSH_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  return String(stdout || "");
}

function keyIsReadable(keyPath, override) {
  if (typeof override === "function") return !!override(keyPath);
  try {
    const st = fs.statSync(keyPath);
    if (!st.isFile()) return false;
    fs.accessSync(keyPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function mergeChanimExtra(extra, chanim) {
  let obj = extra;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      obj = {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) obj = {};
  if (!chanim || !chanim.length) return obj;
  return { ...obj, chanim };
}

/**
 * @returns {Promise<{ ok: boolean, error?: string, chanim: object[] }>}
 */
async function collectChanim(opts = {}) {
  const empty = (error) => ({ ok: false, error, chanim: [] });
  const vendor = String(opts.vendor || "").trim().toLowerCase();
  if (vendor !== "asuswrt") return empty("chanim is ASUS/Merlin only");
  const host = String(opts.host || "").trim().replace(/^\[|\]$/g, "");
  if (!host || !isPrivateOrLocalIp(host)) return empty("host must be a private or local IP");
  const keyPath = keyPathOk(opts.ssh_key_path);
  if (!keyPath) return empty("ssh key path required");
  if (!keyIsReadable(keyPath, opts.keyReadable)) return empty("ssh key unreadable");
  const user = String(opts.ssh_user || opts.user || "admin").trim() || "admin";
  if (!SSH_USER_RE.test(user)) return empty("invalid ssh user");
  const injected = !!(opts.runner || runSshOverride);
  if (!injected) {
    if (typeof opts.sshExists === "function" && !opts.sshExists()) return empty("ssh missing");
  }
  const runner = opts.runner || runSshOverride || defaultRunner;
  const ifaces = parseIfaceList(opts.ssh_ifaces);
  const chanim = [];
  for (const iface of ifaces) {
    const argv = buildSshArgv({ keyPath, user, host, iface });
    let text = "";
    try {
      text = await runner({ bin: "ssh", argv });
    } catch (err) {
      if (err && err.code === "ENOENT") return empty("ssh missing");
      continue;
    }
    const parsed = parseChanimStats(text, iface);
    if (parsed) chanim.push(parsed);
  }
  return chanim.length ? { ok: true, chanim } : empty("no chanim data");
}

module.exports = {
  DEFAULT_IFACES,
  parseIfaceList,
  parseChanimStats,
  buildSshArgv,
  collectChanim,
  mergeChanimExtra,
  setRunSshForTest,
  resetRunSshForTest,
};
