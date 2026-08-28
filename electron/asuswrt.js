"use strict";

/**
 * ASUSWRT / Merlin / AiMesh HTTP adapter (login + appGet.cgi).
 * Writes: applyapp.cgi block/guest only — never reboot or firmware.
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");
const { isPrivateOrLocalIp } = require("./port-scan");
const { formatMac } = require("./oui");

const USER_AGENT = "asusrouter-Android-DUTUtil-1.0.0.3.58-163";
const TIMEOUT_MS = 8000;
const MAX_BODY = 2_000_000;
const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 8443;

/** @type {null | ((url: string, init: object) => Promise<object>)} */
let injectedRequest = null;

/** @type {Map<string, { cookie: string, cpuPrev: object|null }>} */
const sessions = new Map();

function setRequestFn(fn) {
  injectedRequest = typeof fn === "function" ? fn : null;
}

function resetRequestFn() {
  injectedRequest = null;
  sessions.clear();
}

function sessionKey(opts) {
  return `${opts.https ? "s" : "h"}|${String(opts.host).trim()}|${resolvePort(opts)}|${opts.user || ""}`;
}

function resolvePort(opts) {
  if (opts.port != null && String(opts.port).trim() !== "") {
    const n = Number(opts.port);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  return opts.https ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT;
}

function originOf(opts) {
  const host = String(opts.host || "").trim().replace(/^\[|\]$/g, "");
  const port = resolvePort(opts);
  const proto = opts.https ? "https" : "http";
  return { host, port, proto, base: `${proto}://${host}:${port}` };
}

function rejectHost(opts) {
  const host = String(opts && opts.host ? opts.host : "").trim().replace(/^\[|\]$/g, "");
  if (!isPrivateOrLocalIp(host)) {
    return { ok: false, error: "host must be a private or local IP" };
  }
  return null;
}

function rejectCreds(opts) {
  if (!opts || !String(opts.user || "").trim() || opts.password == null || opts.password === "") {
    return { ok: false, error: "missing credentials" };
  }
  return null;
}

function sha256hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function formBody(fields) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) p.set(k, v);
  return p.toString();
}

function headerGet(headers, name) {
  if (!headers) return "";
  const want = name.toLowerCase();
  if (typeof headers.get === "function") return headers.get(name) || headers.get(want) || "";
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want) return Array.isArray(v) ? v.join("\n") : String(v || "");
  }
  return "";
}

function extractAsusToken(headers, body) {
  const raw = headerGet(headers, "set-cookie");
  const lines = String(raw || "").split(/\n/).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/asus_token=([^;]*)/i);
    if (m && m[1] && m[1] !== "deleted") return m[1].trim();
  }
  const t = String(body || "");
  try {
    const j = JSON.parse(t);
    if (j && j.asus_token) return String(j.asus_token);
  } catch {
    /* not json */
  }
  const m = t.match(/asus_token=([A-Za-z0-9+/=_-]+)/);
  return m ? m[1] : null;
}

function matchBracket(s, i) {
  const open = s[i];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let q = null;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (q) {
      if (c === "\\" ) {
        j++;
        continue;
      }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

function parseJsonish(s, i) {
  const ch = s[i];
  if (ch === "{" || ch === "[") {
    const end = matchBracket(s, i);
    if (end < 0) return null;
    const raw = s.slice(i, end + 1);
    try {
      return { value: JSON.parse(raw), end: end + 1 };
    } catch {
      try {
        return { value: JSON.parse(raw.replace(/'/g, '"')), end: end + 1 };
      } catch {
        return { value: raw, end: end + 1 };
      }
    }
  }
  if (ch === '"' || ch === "'") {
    const q = ch;
    let j = i + 1;
    let out = "";
    while (j < s.length) {
      if (s[j] === "\\") {
        out += s[j + 1] || "";
        j += 2;
        continue;
      }
      if (s[j] === q) return { value: out, end: j + 1 };
      out += s[j++];
    }
    return null;
  }
  let j = i;
  while (j < s.length && s[j] !== ";" && s[j] !== "\n" && s[j] !== "\r") j++;
  const raw = s.slice(i, j).trim();
  if (raw === "true") return { value: true, end: j };
  if (raw === "false") return { value: false, end: j };
  if (raw === "null") return { value: null, end: j };
  if (raw !== "" && Number.isFinite(Number(raw))) return { value: Number(raw), end: j };
  return { value: raw, end: j };
}

function parseAppGet(text) {
  const s = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!s) return {};
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      return JSON.parse(s);
    } catch {
      /* JS assignments */
    }
  }
  const out = {};
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s;]/.test(s[i])) i++;
    const start = i;
    while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) i++;
    if (i === start) {
      i++;
      continue;
    }
    const key = s.slice(start, i);
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== "=") continue;
    i++;
    while (i < s.length && /\s/.test(s[i])) i++;
    const parsed = parseJsonish(s, i);
    if (parsed) {
      out[key] = parsed.value;
      i = parsed.end;
    }
  }
  return out;
}

function parseNonce(body) {
  const t = String(body || "").trim();
  try {
    const j = JSON.parse(t);
    if (j && j.nonce != null && String(j.nonce)) return String(j.nonce);
  } catch {
    /* assignments / nonce= */
  }
  const parsed = parseAppGet(t);
  if (parsed.nonce != null && String(parsed.nonce)) return String(parsed.nonce);
  const m = t.match(/nonce["'\s:=]+([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

async function normalizeRes(res) {
  if (!res) return { status: 0, headers: {}, body: "" };
  if (typeof res.text === "function") {
    const body = await res.text();
    return { status: res.status || 0, headers: res.headers || {}, body };
  }
  return {
    status: res.status || 0,
    headers: res.headers || {},
    body: res.body == null ? "" : String(res.body),
  };
}

function nodeRequest(urlStr, init, allowedHost) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      resolve({ status: 0, headers: {}, body: "", error: "bad url" });
      return;
    }
    if (u.hostname !== allowedHost) {
      resolve({ status: 0, headers: {}, body: "", error: "host mismatch" });
      return;
    }
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const headers = { ...(init.headers || {}) };
    if (init.body) headers["Content-Length"] = Buffer.byteLength(init.body);
    const reqOpts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT),
      path: u.pathname + u.search,
      method: init.method || "GET",
      headers,
      timeout: TIMEOUT_MS,
    };
    if (isHttps) {
      reqOpts.rejectUnauthorized = false;
      reqOpts.agent = new https.Agent({ rejectUnauthorized: false });
    }
    const req = lib.request(reqOpts, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size <= MAX_BODY) chunks.push(c);
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", (err) => resolve({ status: 0, headers: {}, body: "", error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, headers: {}, body: "", error: "timeout" });
    });
    if (init.body) req.write(init.body);
    req.end();
  });
}

function forbiddenWriteBody(body) {
  return /reboot|firmware/i.test(String(body || ""));
}

async function rawRequest(opts, path, init, flags) {
  if (flags && flags.allowWrite) {
    if (!/applyapp\.cgi/i.test(path) || forbiddenWriteBody(init && init.body)) {
      return { status: 0, headers: {}, body: "", error: "writes are not allowed" };
    }
  } else if (/applyapp\.cgi/i.test(path)) {
    return { status: 0, headers: {}, body: "", error: "writes are not allowed" };
  }
  const { host, base } = originOf(opts);
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = {
    "User-Agent": USER_AGENT,
    Referer: `${base}/`,
    ...(init.headers || {}),
  };
  const payload = { method: init.method || "GET", headers, body: init.body };
  const fn = opts.fetch || injectedRequest;
  if (fn) return normalizeRes(await fn(url, payload));
  return nodeRequest(url, payload, host);
}

function cookieHeaders(cookie) {
  return cookie ? { Cookie: `asus_token=${cookie}` } : {};
}

function looksUnauthorized(res) {
  if (res.status === 401 || res.status === 403) return true;
  const b = String(res.body || "");
  return /Main_Login\.asp/i.test(b) && /error_status/i.test(b);
}

async function loginLegacy(opts) {
  const token = Buffer.from(`${opts.user}:${opts.password}`, "utf8").toString("base64");
  const res = await rawRequest(opts, "/login.cgi", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({ login_authorization: token }),
  });
  return extractAsusToken(res.headers, res.body);
}

async function loginV2(opts) {
  const nonceRes = await rawRequest(opts, "/get_Nonce.cgi", { method: "GET", headers: {} });
  const nonce = parseNonce(nonceRes.body);
  if (!nonce) return null;
  const cnonce = crypto.randomBytes(16).toString("hex");
  const hash = sha256hex(`${opts.user}:${nonce}:${opts.password}:${cnonce}`);
  const res = await rawRequest(opts, "/login_v2.cgi", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({ login_authorization: hash, login_cnonce: cnonce }),
  });
  return extractAsusToken(res.headers, res.body);
}

async function login(opts) {
  const legacy = await loginLegacy(opts);
  if (legacy) return legacy;
  return loginV2(opts);
}

async function ensureSession(opts) {
  const key = sessionKey(opts);
  const existing = sessions.get(key);
  if (existing && existing.cookie) return existing;
  const cookie = await login(opts);
  if (!cookie) return null;
  const sess = { cookie, cpuPrev: existing ? existing.cpuPrev : null };
  sessions.set(key, sess);
  return sess;
}

async function appGet(opts, hook, sess) {
  return rawRequest(opts, "/appGet.cgi", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...cookieHeaders(sess.cookie),
    },
    body: `hook=${hook}`,
  });
}

async function appGetAuthed(opts, hook) {
  let sess = await ensureSession(opts);
  if (!sess) return { ok: false, error: "login failed" };
  let res = await appGet(opts, hook, sess);
  if (looksUnauthorized(res)) {
    sessions.delete(sessionKey(opts));
    sess = await ensureSession(opts);
    if (!sess) return { ok: false, error: "login failed" };
    res = await appGet(opts, hook, sess);
  }
  if (res.error && !res.body) return { ok: false, error: res.error };
  if (res.status && res.status >= 400) return { ok: false, error: `http ${res.status}` };
  return { ok: true, parsed: parseAppGet(res.body), sess };
}

function looksMac(s) {
  return /^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/.test(String(s || ""));
}

function rssiToPct(rssi) {
  if (rssi == null || !Number.isFinite(rssi)) return null;
  return Math.max(0, Math.min(100, Math.round(2 * (rssi + 100))));
}

function parseRf(raw, wired) {
  if (wired) return { rssi: null, signal_pct: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return { rssi: null, signal_pct: null };
  if (n < 0) return { rssi: Math.round(n), signal_pct: rssiToPct(n) };
  if (n <= 100) return { rssi: null, signal_pct: Math.round(n) };
  return { rssi: null, signal_pct: null };
}

function bandFromIsWl(isWL) {
  const n = Number(isWL);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return "wired";
  if (n === 1) return "2.4";
  if (n === 2) return "5";
  if (n === 3) return "5-2";
  if (n === 4) return "6";
  return String(n);
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isOnlineFlag(row) {
  const v = row.isOnline != null ? row.isOnline : row.online;
  return v === true || v === 1 || v === "1" || v === "true";
}

function extractClientList(parsed) {
  let list = parsed.get_clientlist;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = parseAppGet(list);
    }
  }
  if (list && typeof list === "object") return list;
  if (parsed.macList || Object.keys(parsed).some(looksMac)) return parsed;
  return {};
}

function staMaps(parsed) {
  const bands = [
    ["wl_sta_list_2g", "2.4"],
    ["wl_sta_list_5g", "5"],
    ["wl_sta_list_5g_2", "5-2"],
    ["wl_sta_list_6g", "6"],
  ];
  const byMac = new Map();
  for (const [key, band] of bands) {
    const table = parsed[key];
    if (!table || typeof table !== "object") continue;
    for (const [macKey, val] of Object.entries(table)) {
      const mac = formatMac(macKey);
      if (!mac) continue;
      let rssi = null;
      let tx = null;
      let rx = null;
      if (Array.isArray(val)) {
        rssi = val[0];
        tx = val[1];
        rx = val[2];
      } else if (val && typeof val === "object") {
        rssi = val.rssi;
        tx = val.tx != null ? val.tx : val.curTx;
        rx = val.rx != null ? val.rx : val.curRx;
      }
      byMac.set(mac, { band, rssi, tx, rx });
    }
  }
  return byMac;
}

function normalizeClients(parsed) {
  const list = extractClientList(parsed);
  const sta = staMaps(parsed);
  const keys = Array.isArray(list.macList)
    ? list.macList
    : Object.keys(list).filter((k) => k !== "macList" && looksMac(k));
  const out = [];
  const seen = new Set();
  for (const macKey of keys) {
    const row = list[macKey] || list[String(macKey).toUpperCase()] || list[String(macKey).toLowerCase()] || {};
    const mac = formatMac(row.mac || macKey);
    if (!mac || seen.has(mac)) continue;
    seen.add(mac);
    const isWL = row.isWL != null ? Number(row.isWL) : null;
    const wired = isWL === 0;
    const extra = sta.get(mac);
    const rf = parseRf(row.rssi != null ? row.rssi : extra && extra.rssi, wired);
    out.push({
      mac,
      ip: row.ip || row.ipaddr || null,
      name: (row.nickName && String(row.nickName).trim()) || (row.name && String(row.name).trim()) || null,
      online: isOnlineFlag(row),
      rssi: rf.rssi,
      signal_pct: rf.signal_pct,
      band: bandFromIsWl(isWL) || (extra && extra.band) || null,
      ssid: row.ssid || null,
      tx_mbps: numOrNull(row.curTx != null ? row.curTx : extra && extra.tx),
      rx_mbps: numOrNull(row.curRx != null ? row.curRx : extra && extra.rx),
      node_mac: formatMac(row.from || row.node || row.amesh_mac) || null,
    });
  }
  return out;
}

function pickModel(parsed) {
  const v = parsed.productid || parsed.odmpid || parsed.nvram_get_productid;
  return v != null && String(v) ? String(v) : null;
}

function pickFirmware(parsed) {
  const v = parsed.firmver || parsed.nvram_get_firmver;
  if (v == null || !String(v)) return null;
  const build = parsed.buildno;
  return build != null && String(build) ? `${v}.${build}` : String(v);
}

function cpuPct(cpuUsage, prev) {
  if (cpuUsage == null) return { pct: null, snap: prev };
  if (typeof cpuUsage === "number" && cpuUsage >= 0 && cpuUsage <= 100) {
    return { pct: Math.round(cpuUsage), snap: prev };
  }
  if (typeof cpuUsage !== "object") return { pct: null, snap: prev };
  const snap = {};
  for (const [k, v] of Object.entries(cpuUsage)) {
    if (!/^cpu/i.test(k)) continue;
    if (v && typeof v === "object") {
      const total = Number(v.total);
      const usage = Number(v.usage);
      if (Number.isFinite(total) && Number.isFinite(usage)) snap[k] = { total, usage };
    } else {
      const n = Number(v);
      if (Number.isFinite(n)) snap[k] = { total: 100, usage: n };
    }
  }
  const tot = snap.cpu_total || snap.cpu0 || Object.values(snap)[0];
  if (!tot) return { pct: null, snap };
  if (tot.total === 100 && tot.usage >= 0 && tot.usage <= 100) {
    return { pct: Math.round(tot.usage), snap };
  }
  const prevTot = prev && (prev.cpu_total || prev.cpu0 || Object.values(prev)[0]);
  if (prevTot) {
    const dt = tot.total - prevTot.total;
    const du = tot.usage - prevTot.usage;
    if (dt > 0) return { pct: Math.round((du / dt) * 100), snap };
  }
  return { pct: null, snap };
}

function parseWan(parsed) {
  const status = parsed.wanlink_status;
  const state = parsed.wanlink_state != null ? parsed.wanlink_state : parsed.wanstate;
  let wan_ok = null;
  if (status === 1 || status === "1" || status === true) wan_ok = true;
  else if (status === 0 || status === "0" || status === false) wan_ok = false;
  else if (state === 2 || state === 1 || state === "2" || state === "1") wan_ok = true;
  else if (state === 0 || state === "0") wan_ok = false;
  const wan_ip = parsed.wanlink_ipaddr || parsed.wan0_ipaddr || parsed.ipaddr || null;
  return { wan_ok, wan_ip: wan_ip ? String(wan_ip) : null };
}

async function testConnection(opts) {
  const bad = rejectHost(opts) || rejectCreds(opts);
  if (bad) return bad;
  const got = await appGetAuthed(opts, "nvram_get(productid);nvram_get(firmver)");
  if (!got.ok) return { ok: false, error: got.error };
  return { ok: true, model: pickModel(got.parsed), firmware: pickFirmware(got.parsed) };
}

async function getClients(opts) {
  const bad = rejectHost(opts) || rejectCreds(opts);
  if (bad) return { ...bad, clients: [] };
  const hook = "get_clientlist();wl_sta_list_2g();wl_sta_list_5g();wl_sta_list_5g_2()";
  const got = await appGetAuthed(opts, hook);
  if (!got.ok) return { ok: false, error: got.error, clients: [] };
  return { ok: true, clients: normalizeClients(got.parsed) };
}

async function getRouterHealth(opts) {
  const bad = rejectHost(opts) || rejectCreds(opts);
  if (bad) {
    return {
      ...bad,
      cpu_pct: null,
      mem_used: null,
      mem_total: null,
      wan_ok: null,
      wan_ip: null,
      model: null,
      firmware: null,
    };
  }
  const hook = "cpu_usage(appobj);memory_usage(appobj);wanlink_state();nvram_get(productid);nvram_get(firmver)";
  const got = await appGetAuthed(opts, hook);
  if (!got.ok) {
    return {
      ok: false,
      error: got.error,
      cpu_pct: null,
      mem_used: null,
      mem_total: null,
      wan_ok: null,
      wan_ip: null,
      model: null,
      firmware: null,
    };
  }
  const mem = got.parsed.memory_usage && typeof got.parsed.memory_usage === "object" ? got.parsed.memory_usage : {};
  const cpu = cpuPct(got.parsed.cpu_usage, got.sess.cpuPrev);
  got.sess.cpuPrev = cpu.snap;
  const wan = parseWan(got.parsed);
  const extra = {};
  if (mem.mem_free != null) extra.mem_free = numOrNull(mem.mem_free);
  if (got.parsed.wanlink_state != null) extra.wanlink_state = got.parsed.wanlink_state;
  const out = {
    ok: true,
    cpu_pct: cpu.pct,
    mem_used: numOrNull(mem.mem_used),
    mem_total: numOrNull(mem.mem_total),
    wan_ok: wan.wan_ok,
    wan_ip: wan.wan_ip,
    model: pickModel(got.parsed),
    firmware: pickFirmware(got.parsed),
  };
  if (Object.keys(extra).length) out.extra_json = extra;
  return out;
}

function splitGt(s) {
  if (s == null || s === "") return [];
  return String(s)
    .split(">")
    .map((x) => String(x).trim());
}

function canonicalBand(band) {
  const b = String(band || "").trim();
  if (b === "2.4" || b === "2" || b === "24" || b === "2g") return "2.4";
  if (b === "5" || b === "5g") return "5";
  if (b === "6" || b === "6g" || b === "6e") return "6";
  return null;
}

const GUEST_NVRAM = {
  "2.4": "wl0.1_bss_enabled",
  "5": "wl1.1_bss_enabled",
  "6": "wl3.1_bss_enabled",
};

async function applyApp(opts, fields, sessIn) {
  let sess = sessIn || (await ensureSession(opts));
  if (!sess) return { ok: false, error: "login failed" };
  const body = formBody(fields);
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...cookieHeaders(sess.cookie),
    },
    body,
  };
  let res = await rawRequest(opts, "/applyapp.cgi", init, { allowWrite: true });
  if (looksUnauthorized(res)) {
    sessions.delete(sessionKey(opts));
    sess = await ensureSession(opts);
    if (!sess) return { ok: false, error: "login failed" };
    init.headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      ...cookieHeaders(sess.cookie),
    };
    res = await rawRequest(opts, "/applyapp.cgi", init, { allowWrite: true });
  }
  if (res.error && !res.body) return { ok: false, error: res.error };
  if (res.status && res.status >= 400) return { ok: false, error: `http ${res.status}` };
  return { ok: true };
}

async function setClientBlocked(opts) {
  const bad = rejectHost(opts) || rejectCreds(opts);
  if (bad) return bad;
  const mac = formatMac(opts.mac);
  if (!mac) return { ok: false, error: "invalid mac" };
  const got = await appGetAuthed(
    opts,
    "nvram_get(MULTIFILTER_MAC);nvram_get(MULTIFILTER_ENABLE);nvram_get(MULTIFILTER_DEVICENAME);nvram_get(MULTIFILTER_MACFILTER_DAYTIME);nvram_get(MULTIFILTER_ALL)"
  );
  if (!got.ok) return { ok: false, error: got.error || "nvram failed" };
  const p = got.parsed || {};
  const macs = splitGt(p.MULTIFILTER_MAC);
  const ens = splitGt(p.MULTIFILTER_ENABLE);
  const names = splitGt(p.MULTIFILTER_DEVICENAME);
  const days = splitGt(p.MULTIFILTER_MACFILTER_DAYTIME);
  const idx = macs.findIndex((m) => formatMac(m) === mac);
  if (opts.blocked) {
    if (idx >= 0) ens[idx] = "2";
    else {
      macs.push(mac);
      ens.push("2");
      names.push(String(opts.name || mac).slice(0, 32));
      days.push("");
    }
  } else if (idx >= 0) {
    macs.splice(idx, 1);
    ens.splice(idx, 1);
    if (names.length > idx) names.splice(idx, 1);
    if (days.length > idx) days.splice(idx, 1);
  }
  while (ens.length < macs.length) ens.push("2");
  while (names.length < macs.length) names.push("");
  while (days.length < macs.length) days.push("");
  return applyApp(
    opts,
    {
      action_mode: "apply",
      rc_service: "restart_firewall",
      MULTIFILTER_ALL: macs.length ? "1" : "0",
      MULTIFILTER_MAC: macs.join(">"),
      MULTIFILTER_ENABLE: ens.join(">"),
      MULTIFILTER_DEVICENAME: names.join(">"),
      MULTIFILTER_MACFILTER_DAYTIME: days.join(">"),
    },
    got.sess
  );
}

async function setGuestWifi(opts) {
  const bad = rejectHost(opts) || rejectCreds(opts);
  if (bad) return bad;
  const band = canonicalBand(opts.band);
  if (!band) return { ok: false, error: "invalid band" };
  const key = GUEST_NVRAM[band];
  return applyApp(opts, {
    action_mode: "apply",
    rc_service: "restart_wireless",
    [key]: opts.enabled ? "1" : "0",
  });
}

module.exports = {
  testConnection,
  getClients,
  getRouterHealth,
  setClientBlocked,
  setGuestWifi,
  setRequestFn,
  resetRequestFn,
  USER_AGENT,
};
