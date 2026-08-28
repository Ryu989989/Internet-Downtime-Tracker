"use strict";

/**
 * Omada SDN adapter (HTTPS login + site clients).
 * Writes: client block/unblock only when the cmd path is clear. No reboot/firmware.
 */

const http = require("http");
const https = require("https");
const net = require("net");
const { URL } = require("url");
const { isPrivateOrLocalIp } = require("./port-scan");
const { formatMac } = require("./oui");

const TIMEOUT_MS = 8000;
const MAX_BODY = 2_000_000;
const DEFAULT_PORT = 8043;
const WRITE_RE = /\/cmd\/|reconnect|blockClient|reboot|firmware/i;
const ALLOWED_WRITE_RE = /\/cmd\/clients\/[^/]+\/(block|unblock)$/i;

/** @type {null | ((url: string, init: object) => Promise<object>)} */
let injectedRequest = null;

/** @type {Map<string, { cookie: string|null, token: string|null, omadacId: string|null, siteId: string|null, controllerVer: string|null }>} */
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
  return DEFAULT_PORT;
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
  for (const line of lines) {
    const nv = String(line).split(";")[0].trim();
    if (!nv || /=deleted$/i.test(nv)) continue;
    parts.push(nv);
  }
  return parts.length ? parts.join("; ") : null;
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

function errorCodeOf(j) {
  if (!j || j.errorCode == null || j.errorCode === "") return 0;
  const n = Number(j.errorCode);
  return Number.isFinite(n) ? n : 0;
}

function unwrap(j) {
  if (!j) return null;
  if (errorCodeOf(j) !== 0) return null;
  return j.result != null ? j.result : j;
}

function rowsOf(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.data)) return result.data;
  return [];
}

function apiMsg(j) {
  if (!j) return null;
  if (errorCodeOf(j) !== 0) return String(j.msg || `errorCode ${j.errorCode}`);
  return null;
}

function looksUnauthorized(res) {
  if (res.status === 401 || res.status === 403) return true;
  const j = parseBody(res.body);
  const code = errorCodeOf(j);
  if (code === -1005 || code === -1001 || code === -1200) return true;
  const msg = j && j.msg != null ? String(j.msg) : "";
  return /not login|login required|LoginRequired/i.test(msg);
}

function isLoginPath(path) {
  return /\/api\/v2\/login$/.test(path);
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

function isWired(row) {
  if (row.wireless === false || row.wireless === 0 || row.wireless === "0") return true;
  const t = Number(row.connectType);
  if (t === 2) return true;
  const dev = String(row.connectDevType || "").toLowerCase();
  if (dev === "switch" || dev === "gateway") return true;
  return false;
}

function bandFromRow(row) {
  if (isWired(row)) return "wired";
  const rid = row.radioId;
  if (rid === 0 || rid === "0") return "2.4";
  if (rid === 1 || rid === "1" || rid === 2 || rid === "2") return "5";
  if (rid === 3 || rid === "3") return "6";
  const radio = String(row.radio || "").toLowerCase();
  if (/2\.?4/.test(radio)) return "2.4";
  if (/6/.test(radio)) return "6";
  if (/5/.test(radio)) return "5";
  return null;
}

function signalPct(row, rssi, wired) {
  if (wired) return null;
  if (rssi != null) return rssiToPct(rssi);
  const lvl = numOrNull(row.signalLevel != null ? row.signalLevel : row.signalRank);
  if (lvl == null) return null;
  if (lvl >= 0 && lvl <= 5) return Math.round(lvl * 20);
  if (lvl <= 100) return Math.round(lvl);
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
    const wired = isWired(row);
    const rssi = wired ? null : numOrNull(row.rssi);
    const name =
      (row.name && String(row.name).trim()) ||
      (row.hostName && String(row.hostName).trim()) ||
      null;
    const online = row.active !== false && row.active !== 0 && row.active !== "0";
    out.push({
      mac,
      ip: row.ip || null,
      name,
      online,
      rssi,
      signal_pct: signalPct(row, rssi, wired),
      band: bandFromRow(row),
      ssid: wired ? null : row.ssid || null,
      tx_mbps: wired ? null : rateToMbps(row.txRate != null ? row.txRate : row.tx_rate),
      rx_mbps: wired ? null : rateToMbps(row.rxRate != null ? row.rxRate : row.rx_rate),
      node_mac: formatMac(row.apMac || row.ap_mac) || null,
    });
  }
  return out;
}

function pickSite(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const def = list.find((s) => s && (s.name === "Default" || s.key === "Default"));
  const s = def || list[0];
  const id = s && (s.id || s.key);
  if (!id) return null;
  return { id: String(id), name: s.name ? String(s.name) : null };
}

function isGateway(row) {
  const t = String((row && (row.type || row.deviceType)) || "").toLowerCase();
  return t === "gateway";
}

function parseGateway(rows) {
  const gw = rows.find(isGateway);
  if (!gw) return { cpu_pct: null, mem_pct: null, wan_ok: null, wan_ip: null, model: null, firmware: null };
  const st = gw.internetState != null ? gw.internetState : gw.status;
  let wan_ok = null;
  if (st === 1 || st === true || st === "1" || st === "CONNECTED") wan_ok = true;
  else if (st === 0 || st === false || st === "0" || st === "DISCONNECTED") wan_ok = false;
  const wan_ip = gw.wanPortIpv4 || gw.ipv4 || gw.ip || null;
  return {
    cpu_pct: numOrNull(gw.cpuUtil) != null ? Math.round(numOrNull(gw.cpuUtil)) : null,
    mem_pct: numOrNull(gw.memUtil) != null ? Math.round(numOrNull(gw.memUtil)) : null,
    wan_ok,
    wan_ip: wan_ip ? String(wan_ip) : null,
    model: gw.model ? String(gw.model) : null,
    firmware: gw.firmwareVersion || gw.firmware ? String(gw.firmwareVersion || gw.firmware) : null,
  };
}

function parseControllerStatus(result) {
  if (!result || typeof result !== "object") return { model: null, firmware: null };
  const model = result.name || result.model || null;
  const firmware = result.controllerVer || result.version || null;
  return {
    model: model != null && String(model) ? String(model) : null,
    firmware: firmware != null && String(firmware) ? String(firmware) : null,
  };
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
      port: u.port || DEFAULT_PORT,
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
  if (flags && flags.allowWrite) {
    if (/reboot|firmware/i.test(path) || /reboot|firmware/i.test(String((init && init.body) || ""))) {
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

function v2(omadacId, rest) {
  const p = rest.startsWith("/") ? rest : `/${rest}`;
  return `/${omadacId}/api/v2${p}`;
}

function authHeaders(sess) {
  const headers = { "Omada-Request-Source": "web-local" };
  if (sess && sess.cookie) headers.Cookie = sess.cookie;
  if (sess && sess.token) headers["Csrf-Token"] = sess.token;
  return headers;
}

function getSess(opts) {
  const k = sessionKey(opts);
  let s = sessions.get(k);
  if (!s) {
    s = { cookie: null, token: null, omadacId: null, siteId: null, controllerVer: null };
    sessions.set(k, s);
  }
  return s;
}

function failFromRes(res) {
  if (res.error && !res.body) return res.error;
  const j = parseBody(res.body);
  const msg = apiMsg(j);
  if (msg) return msg;
  if (looksUnauthorized(res)) return "unauthorized";
  if (res.status && res.status >= 400) return `http ${res.status}`;
  return res.error || "request failed";
}

async function fetchInfo(opts) {
  const res = await rawRequest(opts, "/api/info", { method: "GET", headers: {} });
  if (res.error && !res.body) return { error: res.error };
  const j = parseBody(res.body);
  const msg = apiMsg(j);
  if (msg) return { error: msg };
  const result = unwrap(j);
  const omadacId = result && (result.omadacId || result.cId);
  if (!omadacId) return { error: failFromRes(res) === "request failed" ? "missing omadacId" : failFromRes(res) };
  return {
    omadacId: String(omadacId),
    controllerVer: result.controllerVer ? String(result.controllerVer) : null,
  };
}

async function login(opts, omadacId) {
  const body = JSON.stringify({
    username: String(opts.user || "").trim(),
    password: String(opts.password),
  });
  const res = await rawRequest(opts, v2(omadacId, "/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (res.error && !res.body) return { error: res.error };
  const j = parseBody(res.body);
  const msg = apiMsg(j);
  if (msg) return { error: msg };
  if (looksUnauthorized(res) || !j) return { error: "login failed" };
  const result = unwrap(j) || {};
  const token = result.token ? String(result.token) : null;
  if (!token) return { error: "login failed" };
  return { token, cookie: parseCookies(res.headers) };
}

async function discoverSite(opts, sess) {
  const sitesRes = await rawRequest(opts, `${v2(sess.omadacId, "/sites")}?currentPage=1&currentPageSize=100`, {
    method: "GET",
    headers: authHeaders(sess),
  });
  let picked = pickSite(rowsOf(unwrap(parseBody(sitesRes.body))));
  if (!picked) {
    const cur = await rawRequest(opts, v2(sess.omadacId, "/users/current"), {
      method: "GET",
      headers: authHeaders(sess),
    });
    const result = unwrap(parseBody(cur.body));
    const list = result && result.privilege && result.privilege.sites;
    picked = pickSite(list);
    if (!picked) return { error: failFromRes(sitesRes.status ? sitesRes : cur) === "request failed" ? "no site" : failFromRes(sitesRes.status ? sitesRes : cur) };
  }
  return picked;
}

async function ensureSession(opts) {
  const sess = getSess(opts);
  if (sess.token && sess.omadacId && sess.siteId) return sess;
  if (!sess.omadacId) {
    const info = await fetchInfo(opts);
    if (info.error) return info;
    sess.omadacId = info.omadacId;
    sess.controllerVer = info.controllerVer;
  }
  if (!sess.token) {
    const got = await login(opts, sess.omadacId);
    if (got.error) return got;
    sess.token = got.token;
    sess.cookie = got.cookie;
  }
  if (!sess.siteId) {
    const site = await discoverSite(opts, sess);
    if (site.error) return site;
    sess.siteId = site.id;
  }
  return sess;
}

async function apiGet(opts, path, allowRetry) {
  const sess = await ensureSession(opts);
  if (sess.error) return { status: 0, headers: {}, body: "", error: sess.error };
  const res = await rawRequest(opts, path, { method: "GET", headers: authHeaders(sess) });
  if (looksUnauthorized(res) && allowRetry !== false) {
    sessions.delete(sessionKey(opts));
    return apiGet(opts, path, false);
  }
  return res;
}

function sitePath(sess, rest) {
  const q = rest.includes("?") ? rest : rest;
  return v2(sess.omadacId, `/sites/${encodeURIComponent(sess.siteId)}${q.startsWith("/") ? q : `/${q}`}`);
}

async function testConnection(opts) {
  const bad = rejectHost(opts) || rejectCreds(opts);
  if (bad) return bad;
  const sess = await ensureSession(opts);
  if (sess.error) return { ok: false, error: sess.error };
  let model = null;
  let firmware = sess.controllerVer || null;
  const st = await apiGet(opts, v2(sess.omadacId, "/maintenance/controllerStatus"));
  if (st.status >= 200 && st.status < 300) {
    const info = parseControllerStatus(unwrap(parseBody(st.body)));
    if (info.model) model = info.model;
    if (info.firmware) firmware = info.firmware;
  }
  return { ok: true, model, firmware, omadacId: sess.omadacId, siteId: sess.siteId };
}

async function getClients(opts) {
  const bad = rejectHost(opts) || rejectCreds(opts);
  if (bad) return { ...bad, clients: [] };
  const sess = await ensureSession(opts);
  if (sess.error) return { ok: false, error: sess.error, clients: [] };
  const res = await apiGet(
    opts,
    `${sitePath(sess, "/clients")}?currentPage=1&currentPageSize=1000&filters.active=true`
  );
  if (res.error && !res.body) return { ok: false, error: res.error, clients: [] };
  if (res.status && res.status >= 400) return { ok: false, error: failFromRes(res), clients: [] };
  const j = parseBody(res.body);
  const msg = apiMsg(j);
  if (msg) return { ok: false, error: msg, clients: [] };
  if (!j) return { ok: false, error: "invalid json", clients: [] };
  return { ok: true, clients: normalizeClients(rowsOf(unwrap(j))) };
}

async function getRouterHealth(opts) {
  const bad = rejectHost(opts) || rejectCreds(opts);
  if (bad) return emptyHealth(bad.error);
  const sess = await ensureSession(opts);
  if (sess.error) return emptyHealth(sess.error);
  const [devRes, stRes] = await Promise.all([
    apiGet(opts, `${sitePath(sess, "/devices")}?currentPage=1&currentPageSize=100`),
    apiGet(opts, v2(sess.omadacId, "/maintenance/controllerStatus")),
  ]);
  const devices = devRes.status >= 200 && devRes.status < 300 ? rowsOf(unwrap(parseBody(devRes.body))) : [];
  const status = stRes.status >= 200 && stRes.status < 300 ? unwrap(parseBody(stRes.body)) : null;
  if (!devices.length && !status && (devRes.error || stRes.error || (devRes.status && devRes.status >= 400))) {
    return emptyHealth(failFromRes(devRes.status ? devRes : stRes));
  }
  const gw = parseGateway(devices);
  const info = parseControllerStatus(status);
  const extra = {};
  if (gw.mem_pct != null) extra.mem_pct = gw.mem_pct;
  if (sess.omadacId) extra.omadacId = sess.omadacId;
  if (sess.siteId) extra.siteId = sess.siteId;
  const out = {
    ok: true,
    cpu_pct: gw.cpu_pct,
    mem_used: null,
    mem_total: null,
    wan_ok: gw.wan_ok,
    wan_ip: gw.wan_ip,
    model: gw.model || info.model,
    firmware: gw.firmware || info.firmware || sess.controllerVer,
  };
  if (Object.keys(extra).length) out.extra_json = extra;
  return out;
}

async function setClientBlocked(opts) {
  const bad = rejectHost(opts) || rejectCreds(opts);
  if (bad) return bad;
  const mac = formatMac(opts.mac);
  if (!mac) return { ok: false, error: "invalid mac" };
  const sess = await ensureSession(opts);
  if (sess.error) return { ok: false, error: sess.error };
  const cmd = opts.blocked ? "block" : "unblock";
  const path = sitePath(sess, `/cmd/clients/${encodeURIComponent(mac)}/${cmd}`);
  let res = await rawRequest(
    opts,
    path,
    {
      method: "POST",
      headers: { ...authHeaders(sess), "Content-Type": "application/json" },
      body: "{}",
    },
    { allowWrite: true }
  );
  if (looksUnauthorized(res)) {
    sessions.delete(sessionKey(opts));
    const again = await ensureSession(opts);
    if (again.error) return { ok: false, error: again.error };
    res = await rawRequest(
      opts,
      sitePath(again, `/cmd/clients/${encodeURIComponent(mac)}/${cmd}`),
      {
        method: "POST",
        headers: { ...authHeaders(again), "Content-Type": "application/json" },
        body: "{}",
      },
      { allowWrite: true }
    );
  }
  if (res.status === 404) return { ok: false, error: "not supported" };
  const j = parseBody(res.body);
  const msg = apiMsg(j);
  if (msg) return { ok: false, error: /not support/i.test(msg) ? "not supported" : msg };
  if (res.error && !res.body) return { ok: false, error: res.error };
  if (res.status && res.status >= 400) return { ok: false, error: failFromRes(res) };
  return { ok: true };
}

module.exports = {
  testConnection,
  getClients,
  getRouterHealth,
  setClientBlocked,
  setRequestFn,
  resetRequestFn,
};
