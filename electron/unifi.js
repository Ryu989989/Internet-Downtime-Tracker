"use strict";

/**
 * UniFi OS / controller adapter (stat/sta + health/sysinfo).
 * Writes: stamgr block-sta/unblock-sta + WLAN enable only. Never reboot/firmware.
 */

const http = require("http");
const https = require("https");
const net = require("net");
const { URL } = require("url");
const { isPrivateOrLocalIp } = require("./port-scan");
const { formatMac } = require("./oui");

const TIMEOUT_MS = 8000;
const MAX_BODY = 2_000_000;
const DEFAULT_HTTPS_PORT = 443;
const DEFAULT_HTTP_PORT = 8080;
const OS_PREFIX = "/proxy/network";
const STA_PATH = "/api/s/default/stat/sta";
const HEALTH_PATH = "/api/s/default/stat/health";
const SYSINFO_PATH = "/api/s/default/stat/sysinfo";
const WRITE_RE = /stamgr|block-sta|unblock-sta|kick-sta|\/cmd\/|authorize-guest|unauthorize-guest/i;
const ALLOWED_WRITE_RE = /\/cmd\/stamgr$|\/rest\/wlanconf(\/[^/?#]+)?$/i;
const FORBIDDEN_WRITE_RE = /reboot|firmware|upgrade/i;

/** @type {null | ((url: string, init: object) => Promise<object>)} */
let injectedRequest = null;

/** @type {Map<string, { cookie: string|null, csrf: string|null, prefix: string|null }>} */
const sessions = new Map();

function setRequestFn(fn) {
  injectedRequest = typeof fn === "function" ? fn : null;
}

function resetRequestFn() {
  injectedRequest = null;
  sessions.clear();
}

function useHttps(opts) {
  return !opts || opts.https !== false;
}

function resolvePort(opts) {
  if (opts && opts.port != null && String(opts.port).trim() !== "") {
    const n = Number(opts.port);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  return useHttps(opts) ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT;
}

function bareHost(host) {
  return String(host || "")
    .trim()
    .replace(/^\[|\]$/g, "");
}

function hostForUrl(host) {
  const bare = bareHost(host);
  return net.isIP(bare) === 6 ? `[${bare}]` : bare;
}

function originOf(opts) {
  const host = bareHost(opts && opts.host);
  const port = resolvePort(opts);
  const proto = useHttps(opts) ? "https" : "http";
  return { host, port, proto, base: `${proto}://${hostForUrl(host)}:${port}` };
}

function sessionKey(opts) {
  return `${useHttps(opts) ? "s" : "h"}|${bareHost(opts && opts.host)}|${resolvePort(opts)}|${(opts && opts.user) || ""}`;
}

function rejectHost(opts) {
  const host = bareHost(opts && opts.host);
  if (!isPrivateOrLocalIp(host)) {
    return { ok: false, error: "host must be a private or local IP" };
  }
  return null;
}

function rejectCreds(opts) {
  if (opts && String(opts.api_key || "").trim()) return null;
  if (opts && String(opts.user || "").trim() && opts.password != null && opts.password !== "") {
    return null;
  }
  return { ok: false, error: "missing credentials" };
}

function emptyHealth(error) {
  return {
    ok: false,
    error,
    cpu_pct: null,
    mem_used: null,
    mem_total: null,
    wan_ok: null,
    wan_ip: null,
    model: null,
    firmware: null,
  };
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

function parseCookies(headers) {
  const raw = headerGet(headers, "set-cookie");
  const lines = String(raw || "")
    .split(/\n/)
    .filter(Boolean);
  const parts = [];
  let csrf = null;
  for (const line of lines) {
    const nv = String(line).split(";")[0].trim();
    if (!nv || /=deleted$/i.test(nv)) continue;
    parts.push(nv);
    const eq = nv.indexOf("=");
    if (eq < 1) continue;
    const name = nv.slice(0, eq).trim();
    const val = nv.slice(eq + 1);
    if (/^(TOKEN|csrf_token)$/i.test(name) && val) csrf = val;
  }
  return { cookie: parts.length ? parts.join("; ") : null, csrf };
}

function parseBody(body) {
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) return body;
  const t = String(body || "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function dataOf(j) {
  if (!j) return [];
  if (Array.isArray(j.data)) return j.data;
  if (Array.isArray(j)) return j;
  return [];
}

function metaError(j) {
  if (!j || !j.meta || j.meta.rc == null || j.meta.rc === "ok") return null;
  return String(j.meta.msg || j.meta.rc);
}

function looksUnauthorized(res) {
  if (res.status === 401 || res.status === 403) return true;
  const j = parseBody(res.body);
  const msg = j && j.meta ? String(j.meta.msg || "") : "";
  if (/LoginRequired/i.test(msg)) return true;
  return /api\.err\.LoginRequired/i.test(String(res.body || ""));
}

function isLoginPath(path) {
  return /\/api\/auth\/login$|\/api\/login$/.test(path);
}

function rssiToPct(rssi) {
  if (rssi == null || !Number.isFinite(rssi)) return null;
  return Math.max(0, Math.min(100, Math.round(2 * (rssi + 100))));
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rateToMbps(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 10_000_000) return Math.round(n / 1_000_000);
  if (n >= 1000) return Math.round(n / 1000);
  return Math.round(n);
}

function bandFromRadio(row) {
  if (row.is_wired === true || row.is_wired === 1 || row.is_wired === "1") return "wired";
  const r = String(row.radio || row.radio_proto || "").toLowerCase();
  if (/ng|2g|\bbg\b|^g$/.test(r)) return "2.4";
  if (/6e|6g|ax6|be6/.test(r)) return "6";
  if (/na|ac|5g|^a$|ax/.test(r)) return "5";
  const ch = Number(row.channel);
  if (Number.isFinite(ch) && ch >= 1 && ch <= 14) return "2.4";
  if (Number.isFinite(ch) && ch >= 32 && ch <= 177) return "5";
  if (Number.isFinite(ch) && ch > 177) return "6";
  return null;
}

function normalizeClients(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const mac = formatMac(row.mac);
    if (!mac || seen.has(mac)) continue;
    seen.add(mac);
    const wired = row.is_wired === true || row.is_wired === 1 || row.is_wired === "1";
    const rssi = wired ? null : numOrNull(row.rssi != null ? row.rssi : row.signal);
    const name =
      (row.name && String(row.name).trim()) ||
      (row.hostname && String(row.hostname).trim()) ||
      null;
    out.push({
      mac,
      ip: row.ip || row.last_ip || null,
      name,
      online: row.offline !== true && row.disconnected !== true,
      rssi,
      signal_pct: rssi == null ? null : rssiToPct(rssi),
      band: bandFromRadio(row),
      ssid: wired ? null : row.essid || row.ssid || null,
      tx_mbps: wired ? null : rateToMbps(row.tx_rate),
      rx_mbps: wired ? null : rateToMbps(row.rx_rate),
      node_mac: formatMac(row.ap_mac || row.sw_mac) || null,
    });
  }
  return out;
}

function parseSysinfo(rows) {
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || typeof row !== "object") return { model: null, firmware: null };
  const model = row.ubnt_device_type || row.name || row.hostname || null;
  const firmware = row.version || row.unifi_version || null;
  return {
    model: model != null && String(model) ? String(model) : null,
    firmware: firmware != null && String(firmware) ? String(firmware) : null,
  };
}

function parseHealthRows(rows) {
  let wan_ok = null;
  let wan_ip = null;
  let cpu_pct = null;
  let mem_pct = null;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (row.subsystem !== "wan") continue;
    if (row.status === "ok") wan_ok = true;
    else if (row.status === "error" || row.status === "disconnected") wan_ok = false;
    if (row.wan_ip) wan_ip = String(row.wan_ip);
    const stats = row["gw_system-stats"] || row["system-stats"];
    if (stats && typeof stats === "object") {
      const cpu = numOrNull(stats.cpu);
      const mem = numOrNull(stats.mem);
      if (cpu != null) cpu_pct = Math.round(cpu);
      if (mem != null) mem_pct = Math.round(mem);
    }
  }
  return { wan_ok, wan_ip, cpu_pct, mem_pct };
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
    if (isHttps && isPrivateOrLocalIp(allowedHost)) {
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

async function rawRequest(opts, path, init, flags) {
  const method = (init && init.method) || "GET";
  const body = init && init.body;
  if (flags && flags.allowWrite) {
    if (FORBIDDEN_WRITE_RE.test(path) || /"cmd"\s*:\s*"(reboot|upgrade)/i.test(String(body || ""))) {
      return { status: 0, headers: {}, body: "", error: "writes are not allowed" };
    }
    if (!ALLOWED_WRITE_RE.test(path)) {
      return { status: 0, headers: {}, body: "", error: "writes are not allowed" };
    }
  } else if (WRITE_RE.test(path) || (method !== "GET" && !isLoginPath(path))) {
    return { status: 0, headers: {}, body: "", error: "writes are not allowed" };
  }
  const { host, base } = originOf(opts);
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = {
    Accept: "application/json",
    Referer: `${base}/`,
    ...(init.headers || {}),
  };
  const payload = { method, headers, body: init.body };
  const fn = (opts && opts.fetch) || injectedRequest;
  if (fn) return normalizeRes(await fn(url, payload));
  return nodeRequest(url, payload, host);
}

function apiKeyOf(opts) {
  return opts && String(opts.api_key || "").trim();
}

function authHeaders(opts, sess) {
  const headers = {};
  const key = apiKeyOf(opts);
  if (key) headers["X-API-KEY"] = key;
  if (sess && sess.cookie) headers.Cookie = sess.cookie;
  if (sess && sess.csrf) headers["X-CSRF-Token"] = sess.csrf;
  return headers;
}

function getSess(opts) {
  const k = sessionKey(opts);
  let s = sessions.get(k);
  if (!s) {
    s = { cookie: null, csrf: null, prefix: null };
    sessions.set(k, s);
  }
  return s;
}

async function login(opts) {
  const body = JSON.stringify({
    username: String(opts.user || "").trim(),
    password: String(opts.password),
  });
  const headers = { "Content-Type": "application/json" };
  const os = await rawRequest(opts, "/api/auth/login", { method: "POST", headers, body });
  if (os.status >= 200 && os.status < 300 && !looksUnauthorized(os)) {
    const c = parseCookies(os.headers);
    if (c.cookie) return { cookie: c.cookie, csrf: c.csrf, prefix: OS_PREFIX };
  }
  if (os.status && os.status !== 404 && looksUnauthorized(os)) {
    return { error: "login failed" };
  }
  const classic = await rawRequest(opts, "/api/login", { method: "POST", headers, body });
  if (classic.status >= 200 && classic.status < 300 && !looksUnauthorized(classic)) {
    const c = parseCookies(classic.headers);
    if (c.cookie) return { cookie: c.cookie, csrf: c.csrf, prefix: "" };
  }
  const err =
    classic.error ||
    os.error ||
    (looksUnauthorized(classic) || looksUnauthorized(os) ? "login failed" : `http ${classic.status || os.status || 0}`);
  return { error: err };
}

async function ensureAuth(opts) {
  const sess = getSess(opts);
  if (apiKeyOf(opts)) return sess;
  if (sess.cookie) return sess;
  const got = await login(opts);
  if (got.error) return got;
  sess.cookie = got.cookie;
  sess.csrf = got.csrf;
  sess.prefix = got.prefix;
  return sess;
}

async function apiGet(opts, rel, allowRetry) {
  const sess = await ensureAuth(opts);
  if (sess.error && !sess.cookie && !apiKeyOf(opts)) {
    return { status: 0, headers: {}, body: "", error: sess.error };
  }
  const prefixes = sess.prefix != null ? [sess.prefix] : [OS_PREFIX, ""];
  let last = { status: 0, headers: {}, body: "", error: "no response" };
  for (const pfx of prefixes) {
    const res = await rawRequest(opts, `${pfx}${rel}`, {
      method: "GET",
      headers: authHeaders(opts, sess),
    });
    last = res;
    if (res.status === 404) continue;
    if (looksUnauthorized(res) && !apiKeyOf(opts) && allowRetry !== false) {
      sessions.delete(sessionKey(opts));
      return apiGet(opts, rel, false);
    }
    if (res.status >= 200 && res.status < 300) {
      sess.prefix = pfx;
      return res;
    }
    return res;
  }
  return last;
}

async function apiWrite(opts, rel, { method, body }, allowRetry) {
  const sess = await ensureAuth(opts);
  if (sess.error && !sess.cookie && !apiKeyOf(opts)) {
    return { status: 0, headers: {}, body: "", error: sess.error };
  }
  const prefixes = sess.prefix != null ? [sess.prefix] : [OS_PREFIX, ""];
  let last = { status: 0, headers: {}, body: "", error: "no response" };
  const payload = typeof body === "string" ? body : JSON.stringify(body || {});
  for (const pfx of prefixes) {
    const res = await rawRequest(
      opts,
      `${pfx}${rel}`,
      {
        method: method || "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(opts, sess),
        },
        body: payload,
      },
      { allowWrite: true }
    );
    last = res;
    if (res.status === 404) continue;
    if (looksUnauthorized(res) && !apiKeyOf(opts) && allowRetry !== false) {
      sessions.delete(sessionKey(opts));
      return apiWrite(opts, rel, { method, body }, false);
    }
    if (res.status >= 200 && res.status < 300) {
      sess.prefix = pfx;
      return res;
    }
    return res;
  }
  return last;
}

function failFromRes(res) {
  if (res.error && !res.body) return res.error;
  const j = parseBody(res.body);
  const meta = metaError(j);
  if (meta) return meta;
  if (looksUnauthorized(res)) return "unauthorized";
  if (res.status && res.status >= 400) return `http ${res.status}`;
  return res.error || "request failed";
}

async function testConnection(opts) {
  const bad = rejectHost(opts) || rejectCreds(opts);
  if (bad) return bad;
  const sys = await apiGet(opts, SYSINFO_PATH);
  if (sys.status >= 200 && sys.status < 300) {
    const j = parseBody(sys.body);
    const meta = metaError(j);
    if (!meta) {
      const info = parseSysinfo(dataOf(j));
      return { ok: true, model: info.model, firmware: info.firmware };
    }
  }
  const sta = await apiGet(opts, STA_PATH);
  if (sta.status >= 200 && sta.status < 300 && !metaError(parseBody(sta.body))) {
    return { ok: true, model: null, firmware: null };
  }
  return { ok: false, error: failFromRes(sta.status ? sta : sys) };
}

async function getClients(opts) {
  const bad = rejectHost(opts) || rejectCreds(opts);
  if (bad) return { ...bad, clients: [] };
  const res = await apiGet(opts, STA_PATH);
  if (res.error && !res.body) return { ok: false, error: res.error, clients: [] };
  if (res.status && res.status >= 400) return { ok: false, error: failFromRes(res), clients: [] };
  const j = parseBody(res.body);
  const meta = metaError(j);
  if (meta) return { ok: false, error: meta, clients: [] };
  if (!j) return { ok: false, error: "invalid json", clients: [] };
  return { ok: true, clients: normalizeClients(dataOf(j)) };
}

async function getRouterHealth(opts) {
  const bad = rejectHost(opts) || rejectCreds(opts);
  if (bad) return emptyHealth(bad.error);
  const healthRes = await apiGet(opts, HEALTH_PATH);
  const sysRes = await apiGet(opts, SYSINFO_PATH);
  const healthJ = healthRes.status >= 200 && healthRes.status < 300 ? parseBody(healthRes.body) : null;
  const sysJ = sysRes.status >= 200 && sysRes.status < 300 ? parseBody(sysRes.body) : null;
  if (!healthJ && !sysJ) return emptyHealth(failFromRes(healthRes.status ? healthRes : sysRes));
  const health = parseHealthRows(dataOf(healthJ));
  const info = parseSysinfo(dataOf(sysJ));
  const extra = {};
  if (health.mem_pct != null) extra.mem_pct = health.mem_pct;
  const out = {
    ok: true,
    cpu_pct: health.cpu_pct,
    mem_used: null,
    mem_total: null,
    wan_ok: health.wan_ok,
    wan_ip: health.wan_ip,
    model: info.model,
    firmware: info.firmware,
  };
  if (Object.keys(extra).length) out.extra_json = extra;
  return out;
}

function canonicalBand(band) {
  const b = String(band || "").trim();
  if (b === "2.4" || b === "2" || b === "24" || b === "2g") return "2.4";
  if (b === "5" || b === "5g") return "5";
  if (b === "6" || b === "6g" || b === "6e") return "6";
  return null;
}

function guestBandOf(row) {
  const raw = String((row && (row.wlan_band || row.band)) || "").toLowerCase();
  if (!raw || raw === "both" || raw.includes(",")) return null;
  if (raw === "6g" || raw === "6e" || raw === "6") return "6";
  if (raw === "5g" || raw === "na" || raw === "5") return "5";
  if (raw === "2g" || raw === "ng" || raw === "2.4" || raw === "2") return "2.4";
  if (/6/.test(raw)) return "6";
  if (/5/.test(raw)) return "5";
  if (/2/.test(raw)) return "2.4";
  return null;
}

async function setClientBlocked(opts) {
  const bad = rejectHost(opts) || rejectCreds(opts);
  if (bad) return bad;
  const mac = formatMac(opts.mac);
  if (!mac) return { ok: false, error: "invalid mac" };
  const res = await apiWrite(opts, "/api/s/default/cmd/stamgr", {
    method: "POST",
    body: { cmd: opts.blocked ? "block-sta" : "unblock-sta", mac: mac.toLowerCase() },
  });
  if (res.error && !res.body) return { ok: false, error: res.error };
  const j = parseBody(res.body);
  const meta = metaError(j);
  if (meta) return { ok: false, error: meta };
  if (res.status && res.status >= 400) return { ok: false, error: failFromRes(res) };
  return { ok: true };
}

async function setGuestWifi(opts) {
  const bad = rejectHost(opts) || rejectCreds(opts);
  if (bad) return bad;
  const band = canonicalBand(opts.band);
  if (!band) return { ok: false, error: "invalid band" };
  const list = await apiGet(opts, "/api/s/default/rest/wlanconf");
  if (list.error && !list.body) return { ok: false, error: list.error };
  if (list.status && list.status >= 400) return { ok: false, error: failFromRes(list) };
  const j = parseBody(list.body);
  const meta = metaError(j);
  if (meta) return { ok: false, error: meta };
  const rows = dataOf(j).filter((w) => w && (w.is_guest === true || w.is_guest === 1) && guestBandOf(w) === band);
  if (!rows.length) return { ok: false, error: "not supported" };
  for (const w of rows) {
    const id = w._id || w.id;
    if (!id) continue;
    const res = await apiWrite(opts, `/api/s/default/rest/wlanconf/${id}`, {
      method: "PUT",
      body: { enabled: !!opts.enabled },
    });
    const err = metaError(parseBody(res.body));
    if (err) return { ok: false, error: err };
    if (res.status && res.status >= 400) return { ok: false, error: failFromRes(res) };
  }
  return { ok: true };
}

module.exports = {
  testConnection,
  getClients,
  getRouterHealth,
  setClientBlocked,
  setGuestWifi,
  setRequestFn,
  resetRequestFn,
};
