"use strict";

/**
 * Netgear Nighthawk/Orbi SOAP client (Genie / pynetgear).
 * Writes: Allow/Block + guest enable only. Never reboot or firmware.
 */

const http = require("http");
const https = require("https");
const net = require("net");
const { isPrivateOrLocalIp } = require("./port-scan");
const { formatMac } = require("./oui");

const SOAP_PATH = "/soap/server_sa/";
const SESSION_ID = "A7D88AE69687E58D9A00";
const PREFIX = "urn:NETGEAR-ROUTER:service:";
const DEFAULT_USER = "admin";
const TIMEOUT_MS = 10000;

const SVC = {
  DeviceConfig: "DeviceConfig:1",
  DeviceInfo: "DeviceInfo:1",
  ParentalControl: "ParentalControl:1",
  WANEthernetLinkConfig: "WANEthernetLinkConfig:1",
  WANIPConnection: "WANIPConnection:1",
};

const WRITE_METHODS = new Set([
  "SetBlockDeviceEnable",
  "SetBlockDeviceByMAC",
  "SetGuestAccessEnabled",
  "SetGuestAccessEnabled2",
  "Set5GGuestAccessEnabled",
  "Set5G1GuestAccessEnabled2",
  "Set5GGuestAccessEnabled2",
]);

const FORBIDDEN = new Set([
  "EnableBlockDeviceForAll",
  "Reboot",
  "CheckNewFirmware",
  "UpdateNewFirmware",
  "CheckAppNewFirmware",
  "EnableTrafficMeter",
  "SetTrafficMeterOptions",
  "ConfigurationStarted",
  "ConfigurationFinished",
  "SetSmartConnectEnable",
  "SetUserOptionsTC",
  "SetOOKLASpeedTestStart",
]);

/** @type {null | ((url: string, init: object) => Promise<object>)} */
let injectedFetch = null;
/** @type {Map<string, object>} */
const sessions = new Map();

function setRequestFn(fn) {
  injectedFetch = typeof fn === "function" ? fn : null;
}

function resetForTest() {
  injectedFetch = null;
  sessions.clear();
}

function sessionKey(opts) {
  const host = bareHost(opts && opts.host);
  const user = (opts && opts.user) || DEFAULT_USER;
  return `${host}|${user}|${opts && opts.https ? "s" : "h"}`;
}

function getSession(opts) {
  const k = sessionKey(opts);
  let s = sessions.get(k);
  if (!s) {
    s = {
      cookie: null,
      port: null,
      skipAttach2: false,
      skipSystemInfo: false,
      skipWanLink: false,
      skipWanIp: false,
    };
    sessions.set(k, s);
  }
  return s;
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

function isBlankPort(port) {
  return port == null || port === "" || port === 0 || port === "0";
}

function parsePort(port) {
  if (isBlankPort(port)) return null;
  const n = Number(port);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

function guardHost(opts) {
  const host = bareHost(opts && opts.host);
  if (!isPrivateOrLocalIp(host)) {
    return { ok: false, error: "host must be a private or local IP" };
  }
  return null;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlDecode(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlTag(xml, name) {
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`,
    "i"
  );
  const m = String(xml || "").match(re);
  return m ? xmlDecode(m[1].trim()) : null;
}

function xmlBlocks(xml, name) {
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`,
    "gi"
  );
  const out = [];
  let m;
  while ((m = re.exec(String(xml || "")))) out.push(m[1]);
  return out;
}

function responseCode(body) {
  const c = xmlTag(body, "ResponseCode");
  return c == null ? null : c.trim();
}

function isSoapOk(status, body) {
  if (status !== 200) return false;
  const c = responseCode(body);
  if (c == null) return false;
  return /^(0+|1|001|2|002|3|003)$/.test(c);
}

function isUnsupported(status, body) {
  if (status === 404 || status === 501) return true;
  const c = responseCode(body);
  return c === "404" || c === "0404" || c === "501";
}

function isUnauthorized(status, body) {
  if (status === 401) return true;
  const c = responseCode(body);
  return c === "401";
}

function cookieFromHeaders(headers) {
  if (!headers) return null;
  const raw =
    headers["set-cookie"] ||
    headers["Set-Cookie"] ||
    (typeof headers.get === "function" ? headers.get("set-cookie") : null);
  if (!raw) return null;
  const parts = Array.isArray(raw) ? raw : [raw];
  const nv = parts
    .map((c) => String(c).split(";")[0].trim())
    .filter(Boolean);
  return nv.length ? nv.join("; ") : null;
}

function lowerHeaders(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === "function") {
    headers.forEach((v, k) => {
      out[String(k).toLowerCase()] = v;
    });
    return out;
  }
  for (const [k, v] of Object.entries(headers)) out[String(k).toLowerCase()] = v;
  return out;
}

async function normalizeRes(res) {
  if (!res) return { status: 0, headers: {}, body: "" };
  if (typeof res.text === "function") {
    const body = await res.text();
    return { status: res.status || 0, headers: lowerHeaders(res.headers), body };
  }
  return {
    status: res.status || 0,
    headers: lowerHeaders(res.headers || {}),
    body: res.body == null ? "" : String(res.body),
  };
}

function nodePost(url, headers, body, rejectUnauthorized) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const payload = Buffer.from(body || "", "utf8");
    const opts = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname || "/"}${parsed.search || ""}`,
      method: "POST",
      headers: { ...headers, "Content-Length": payload.length },
      timeout: TIMEOUT_MS,
    };
    if (isHttps) opts.rejectUnauthorized = rejectUnauthorized;
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

async function post(opts, url, headers, body) {
  const fn = (opts && opts.fetch) || injectedFetch;
  const rejectUnauthorized = !isPrivateOrLocalIp(bareHost(opts && opts.host));
  try {
    if (fn) {
      const res = await fn(url, { method: "POST", headers, body, rejectUnauthorized });
      return await normalizeRes(res);
    }
    return await nodePost(url, headers, body, rejectUnauthorized);
  } catch (e) {
    return {
      status: 0,
      headers: {},
      body: "",
      error: e && e.message ? e.message : "network error",
    };
  }
}

function soapUrl(opts, port) {
  const scheme = opts && opts.https ? "https" : "http";
  return `${scheme}://${hostForUrl(opts.host)}:${port}${SOAP_PATH}`;
}

function envelope(service, method, inner) {
  const svc = PREFIX + service;
  const params = inner || "";
  return (
    `<?xml version="1.0" encoding="utf-8" standalone="no"?>\n` +
    `<SOAP-ENV:Envelope xmlns:SOAPSDK1="http://www.w3.org/2001/XMLSchema"\n` +
    `  xmlns:SOAPSDK2="http://www.w3.org/2001/XMLSchema-instance"\n` +
    `  xmlns:SOAPSDK3="http://schemas.xmlsoap.org/soap/encoding/"\n` +
    `  xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">\n` +
    `<SOAP-ENV:Header>\n<SessionID>${SESSION_ID}</SessionID>\n</SOAP-ENV:Header>\n` +
    `<SOAP-ENV:Body>\n` +
    `<M1:${method} xmlns:M1="${svc}">\n${params}</M1:${method}>\n` +
    `</SOAP-ENV:Body>\n</SOAP-ENV:Envelope>\n`
  );
}

function loginV1Body(user, password) {
  return (
    `<SOAP-ENV:Body>\n<Authenticate>\n` +
    `  <NewUsername>${xmlEscape(user)}</NewUsername>\n` +
    `  <NewPassword>${xmlEscape(password)}</NewPassword>\n` +
    `</Authenticate>\n</SOAP-ENV:Body>`
  );
}

function fullEnvelope(bodyInner) {
  return (
    `<?xml version="1.0" encoding="utf-8" standalone="no"?>\n` +
    `<SOAP-ENV:Envelope xmlns:SOAPSDK1="http://www.w3.org/2001/XMLSchema"\n` +
    `  xmlns:SOAPSDK2="http://www.w3.org/2001/XMLSchema-instance"\n` +
    `  xmlns:SOAPSDK3="http://schemas.xmlsoap.org/soap/encoding/"\n` +
    `  xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">\n` +
    `<SOAP-ENV:Header>\n<SessionID>${SESSION_ID}</SessionID>\n</SOAP-ENV:Header>\n` +
    `${bodyInner}\n</SOAP-ENV:Envelope>\n`
  );
}

async function soapCall(opts, port, { service, method, params, body, needAuth, allowWrite }) {
  if (FORBIDDEN.has(method) || (WRITE_METHODS.has(method) && !allowWrite)) {
    return { ok: false, error: "method not allowed", status: 0, body: "", headers: {} };
  }
  const sess = getSession(opts);
  const xml = body
    ? fullEnvelope(body)
    : envelope(service, method, params || "");
  const headers = {
    SOAPAction: PREFIX + service + "#" + method,
    "Cache-Control": "no-cache",
    "User-Agent": "pynetgear",
    "Content-Type": "multipart/form-data",
  };
  if (needAuth && typeof sess.cookie === "string") headers.Cookie = sess.cookie;
  const res = await post(opts, soapUrl(opts, port), headers, xml);
  const cookie = cookieFromHeaders(res.headers);
  if (cookie) sess.cookie = cookie;
  return {
    ok: isSoapOk(res.status, res.body),
    status: res.status,
    body: res.body,
    headers: res.headers,
    error: res.error,
    unsupported: isUnsupported(res.status, res.body),
    unauthorized: isUnauthorized(res.status, res.body),
  };
}

function soapFailMessage(res, fallback) {
  if (res && res.unsupported) {
    return "SOAP 404 / try port 80 / ISP firmware may disable SOAP";
  }
  if (res && res.unauthorized) return "login failed";
  if (res && res.error) return res.error;
  return fallback || "SOAP request failed";
}

function soapWriteError(res, fallback) {
  if (res && res.unauthorized) return "Remote Management may be required";
  const body = String((res && res.body) || "");
  if (/remote\s*management/i.test(body)) return "Remote Management may be required";
  return soapFailMessage(res, fallback);
}

async function loginV2(opts, port) {
  const user = (opts && opts.user) || DEFAULT_USER;
  const password = (opts && opts.password) || "";
  const res = await soapCall(opts, port, {
    service: SVC.DeviceConfig,
    method: "SOAPLogin",
    params:
      `<Username>${xmlEscape(user)}</Username>\n` +
      `<Password>${xmlEscape(password)}</Password>\n`,
    needAuth: false,
  });
  const sess = getSession(opts);
  if (res.ok && typeof sess.cookie === "string") return { ok: true };
  return { ok: false, error: soapFailMessage(res, "login failed"), res };
}

async function loginV1(opts, port) {
  const user = (opts && opts.user) || DEFAULT_USER;
  const password = (opts && opts.password) || "";
  const res = await soapCall(opts, port, {
    service: SVC.ParentalControl,
    method: "Authenticate",
    body: loginV1Body(user, password),
    needAuth: false,
  });
  if (!res.ok) return { ok: false, error: soapFailMessage(res, "login failed"), res };
  const sess = getSession(opts);
  if (typeof sess.cookie !== "string") sess.cookie = true;
  return { ok: true };
}

async function ensureLogin(opts, port, force) {
  const sess = getSession(opts);
  if (!force && sess.cookie) return { ok: true };
  sess.cookie = null;
  const v2 = await loginV2(opts, port);
  if (v2.ok) return v2;
  const v1 = await loginV1(opts, port);
  if (v1.ok) return v1;
  return { ok: false, error: (v1.error || v2.error) || "login failed" };
}

async function soapAuthed(opts, port, spec) {
  let login = await ensureLogin(opts, port, false);
  if (!login.ok) return { ok: false, error: login.error, status: 0, body: "" };
  let res = await soapCall(opts, port, { ...spec, needAuth: true });
  if (res.unauthorized) {
    const sess = getSession(opts);
    sess.cookie = null;
    login = await ensureLogin(opts, port, true);
    if (!login.ok) return { ok: false, error: login.error, status: 0, body: "" };
    res = await soapCall(opts, port, { ...spec, needAuth: true });
  }
  return res;
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function cleanName(name) {
  if (name == null) return null;
  const s = String(name).trim();
  if (!s || s === "--" || s === "unknown" || s === "<unknown>") return null;
  return s;
}

function mapBand(type) {
  if (type == null || type === "") return null;
  const t = String(type).toLowerCase();
  if (/wired|ethernet|\blan\b/.test(t)) return "wired";
  if (/2\.?4/.test(t)) return "2.4";
  if (/\b6\b|6ghz|wifi\s*6e?/.test(t) && !/5/.test(t)) return "6";
  if (/5/.test(t)) return "5";
  if (/wireless|wifi|wlan/.test(t)) return "wifi";
  return String(type);
}

function mapSignal(raw, wired) {
  if (wired) return { rssi: null, signal_pct: null };
  const n = toNum(raw);
  if (n == null) return { rssi: null, signal_pct: null };
  // 0–100 is Genie percent; only negative values are dBm.
  if (n < 0) return { rssi: n, signal_pct: null };
  if (n <= 100) return { rssi: null, signal_pct: n };
  return { rssi: null, signal_pct: null };
}

function looksIpv4(s) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(s || "").trim());
}

function normalizeClient(raw) {
  const mac = formatMac(raw.mac);
  if (!mac) return null;
  const band = mapBand(raw.type);
  const wired = band === "wired";
  const sig = mapSignal(raw.signal, wired);
  return {
    mac,
    ip: raw.ip ? String(raw.ip).trim() : null,
    name: cleanName(raw.name),
    online: raw.online !== false,
    rssi: sig.rssi,
    signal_pct: sig.signal_pct,
    band,
    ssid: wired ? null : cleanName(raw.ssid),
    tx_mbps: toNum(raw.linkRate),
    rx_mbps: toNum(raw.rxRate),
    node_mac: formatMac(raw.connApMac),
  };
}

function parseDeviceXml(block) {
  return normalizeClient({
    ip: xmlTag(block, "IP") || xmlTag(block, "IPAddress"),
    name: xmlTag(block, "Name") || xmlTag(block, "DeviceName") || xmlTag(block, "HostName"),
    mac: xmlTag(block, "MAC") || xmlTag(block, "MacAddress") || xmlTag(block, "Mac"),
    type: xmlTag(block, "ConnectionType") || xmlTag(block, "Type"),
    signal: xmlTag(block, "SignalStrength") || xmlTag(block, "Signal"),
    linkRate: xmlTag(block, "LinkRate") || xmlTag(block, "Linkrate"),
    ssid: xmlTag(block, "SSID"),
    connApMac: xmlTag(block, "ConnAPMAC") || xmlTag(block, "ConnApMac"),
    online: !/^(0|false|offline)$/i.test(String(xmlTag(block, "Active") || "1")),
  });
}

function parseAttachV1(text) {
  if (text == null) return [];
  const decoded = String(text)
    .replace(/&lt;unknown&gt;/gi, "<unknown>")
    .trim();
  if (!decoded || decoded === "0") return [];
  const entries = decoded.split("@");
  if (entries.length > 1 && /^\d+$/.test(entries[0].trim())) entries.shift();
  const clients = [];
  for (const entry of entries) {
    if (!entry.trim()) continue;
    const info = entry.split(";");
    let ip;
    let name;
    let mac;
    let type;
    let linkRate;
    let signal;
    let ssid;
    let connApMac;
    if (looksIpv4(info[0])) {
      [ip, name, mac, type, linkRate, signal] = info;
    } else {
      ip = info[1];
      name = info[2];
      mac = info[3];
      type = info[4];
      linkRate = info[5];
      signal = info[6];
      ssid = info[8];
      connApMac = info[9];
    }
    const c = normalizeClient({ ip, name, mac, type, linkRate, signal, ssid, connApMac });
    if (c) clients.push(c);
  }
  return clients;
}

function parseAttachBody(body) {
  const devices = xmlBlocks(body, "Device").map(parseDeviceXml).filter(Boolean);
  if (devices.length) return devices;
  const raw = xmlTag(body, "NewAttachDevice");
  if (raw && /<Device[\s>]/i.test(raw)) {
    return xmlBlocks(raw, "Device").map(parseDeviceXml).filter(Boolean);
  }
  return parseAttachV1(raw);
}

function parseInfo(body) {
  return {
    model: xmlTag(body, "ModelName") || xmlTag(body, "Model") || xmlTag(body, "DeviceName"),
    firmware: xmlTag(body, "Firmwareversion") || xmlTag(body, "FirmwareVersion") || xmlTag(body, "Firmware"),
  };
}

function wanOkFrom(status) {
  if (status == null || status === "") return null;
  const t = String(status).trim().toLowerCase();
  if (t === "up" || t === "1" || t === "connected" || t === "true") return true;
  if (t === "down" || t === "0" || t === "disconnected" || t === "false") return false;
  return null;
}

function resolvePort(opts) {
  const explicit = parsePort(opts && opts.port);
  if (explicit) return explicit;
  const sess = getSession(opts);
  return sess.port || 5000;
}

async function fetchInfo(opts, port) {
  const res = await soapAuthed(opts, port, {
    service: SVC.DeviceInfo,
    method: "GetInfo",
  });
  if (!res.ok) return { ok: false, error: soapFailMessage(res, "GetInfo failed") };
  const info = parseInfo(res.body);
  return { ok: true, model: info.model, firmware: info.firmware };
}

async function testConnection(opts) {
  const bad = guardHost(opts);
  if (bad) return bad;
  const explicit = parsePort(opts && opts.port);
  const ports = explicit ? [explicit] : [5000, 80];
  let last = { ok: false, error: "login failed" };
  for (const port of ports) {
    const sess = getSession(opts);
    sess.cookie = null;
    const login = await ensureLogin(opts, port, true);
    if (!login.ok) {
      last = { ok: false, error: login.error || "login failed" };
      continue;
    }
    const info = await fetchInfo(opts, port);
    if (!info.ok) {
      last = info;
      continue;
    }
    sess.port = port;
    return { ok: true, model: info.model, firmware: info.firmware };
  }
  return last;
}

async function getClients(opts) {
  const bad = guardHost(opts);
  if (bad) return { ...bad, clients: [] };
  const port = resolvePort(opts);
  const sess = getSession(opts);

  async function attach(method) {
    return soapAuthed(opts, port, { service: SVC.DeviceInfo, method });
  }

  let res;
  if (!sess.skipAttach2) {
    res = await attach("GetAttachDevice2");
    if (res.unsupported) sess.skipAttach2 = true;
  }
  if (!res || res.unsupported || !res.ok) {
    const v1 = await attach("GetAttachDevice");
    if (v1.ok) {
      return { ok: true, clients: parseAttachBody(v1.body) };
    }
    if (res && res.ok) return { ok: true, clients: parseAttachBody(res.body) };
    return {
      ok: false,
      error: soapFailMessage(v1.ok === false ? v1 : res, "GetAttachDevice failed"),
      clients: [],
    };
  }
  return { ok: true, clients: parseAttachBody(res.body) };
}

async function getRouterHealth(opts) {
  const bad = guardHost(opts);
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
  const port = resolvePort(opts);
  const sess = getSession(opts);
  const info = await fetchInfo(opts, port);
  if (!info.ok) {
    return {
      ok: false,
      error: info.error,
      cpu_pct: null,
      mem_used: null,
      mem_total: null,
      wan_ok: null,
      wan_ip: null,
      model: null,
      firmware: null,
    };
  }

  let cpu_pct = null;
  let mem_used = null;
  let mem_total = null;
  let extra = null;

  if (!sess.skipSystemInfo) {
    const util = await soapAuthed(opts, port, {
      service: SVC.DeviceInfo,
      method: "GetSystemInfo",
    });
    if (util.unsupported) {
      sess.skipSystemInfo = true;
    } else if (util.ok) {
      cpu_pct = toNum(xmlTag(util.body, "NewCPUUtilization") || xmlTag(util.body, "CPUUtilization"));
      const memPct = toNum(
        xmlTag(util.body, "NewMemoryUtilization") || xmlTag(util.body, "MemoryUtilization")
      );
      mem_total = toNum(
        xmlTag(util.body, "NewPhysicalMemory") || xmlTag(util.body, "PhysicalMemory")
      );
      const avail = toNum(
        xmlTag(util.body, "NewAvailableMemory") || xmlTag(util.body, "AvailableMemory")
      );
      if (mem_total != null && avail != null) mem_used = mem_total - avail;
      if (mem_total == null && memPct != null) extra = { mem_pct: memPct };
    }
  }

  let wan_ok = null;
  let wan_ip = null;
  if (!sess.skipWanLink) {
    const link = await soapAuthed(opts, port, {
      service: SVC.WANEthernetLinkConfig,
      method: "GetEthernetLinkStatus",
    });
    if (link.unsupported) sess.skipWanLink = true;
    else if (link.ok) {
      wan_ok = wanOkFrom(
        xmlTag(link.body, "NewEthernetLinkStatus") || xmlTag(link.body, "EthernetLinkStatus")
      );
    }
  }
  if (!sess.skipWanIp) {
    const wan = await soapAuthed(opts, port, {
      service: SVC.WANIPConnection,
      method: "GetExternalIPAddress",
    });
    if (wan.unsupported) sess.skipWanIp = true;
    else if (wan.ok) {
      wan_ip =
        xmlTag(wan.body, "NewExternalIPAddress") || xmlTag(wan.body, "ExternalIPAddress");
    }
  }

  const out = {
    ok: true,
    cpu_pct,
    mem_used,
    mem_total,
    wan_ok,
    wan_ip,
    model: info.model,
    firmware: info.firmware,
  };
  if (extra) out.extra_json = extra;
  return out;
}

function canonicalBand(band) {
  const b = String(band || "").trim();
  if (b === "2.4" || b === "2" || b === "24" || b === "2g") return "2.4";
  if (b === "5" || b === "5g") return "5";
  if (b === "6" || b === "6g" || b === "6e") return "6";
  return null;
}

async function setClientBlocked(opts) {
  const bad = guardHost(opts);
  if (bad) return bad;
  const mac = formatMac(opts.mac);
  if (!mac) return { ok: false, error: "invalid mac" };
  const port = resolvePort(opts);
  const enable = await soapAuthed(opts, port, {
    service: SVC.DeviceConfig,
    method: "SetBlockDeviceEnable",
    params: `<NewBlockDeviceEnable>1</NewBlockDeviceEnable>\n`,
    allowWrite: true,
  });
  if (enable.unauthorized) return { ok: false, error: "Remote Management may be required" };
  const allowOrBlock = opts.blocked ? "Block" : "Allow";
  const res = await soapAuthed(opts, port, {
    service: SVC.DeviceConfig,
    method: "SetBlockDeviceByMAC",
    params:
      `<NewAllowOrBlock>${allowOrBlock}</NewAllowOrBlock>\n` +
      `<NewMACAddress>${xmlEscape(mac)}</NewMACAddress>\n`,
    allowWrite: true,
  });
  if (!res.ok) return { ok: false, error: soapWriteError(res, "block failed") };
  return { ok: true };
}

async function setGuestWifi(opts) {
  const bad = guardHost(opts);
  if (bad) return bad;
  const band = canonicalBand(opts.band);
  if (!band) return { ok: false, error: "invalid band" };
  if (band === "6") return { ok: false, error: "not supported" };
  const on = opts.enabled ? "1" : "0";
  const tries =
    band === "2.4"
      ? [
          ["SetGuestAccessEnabled2", "NewGuestAccessEnabled"],
          ["SetGuestAccessEnabled", "NewGuestAccessEnabled"],
        ]
      : [
          ["Set5GGuestAccessEnabled2", "New5GGuestAccessEnabled"],
          ["Set5GGuestAccessEnabled", "New5GGuestAccessEnabled"],
          ["Set5G1GuestAccessEnabled2", "New5G1GuestAccessEnabled"],
        ];
  const port = resolvePort(opts);
  let last = { ok: false, error: "not supported" };
  for (const [method, param] of tries) {
    const res = await soapAuthed(opts, port, {
      service: SVC.DeviceConfig,
      method,
      params: `<${param}>${on}</${param}>\n`,
      allowWrite: true,
    });
    if (res.unauthorized) return { ok: false, error: "Remote Management may be required" };
    if (res.ok) return { ok: true };
    last = { ok: false, error: soapWriteError(res, "not supported") };
    if (!res.unsupported) return last;
  }
  return last;
}

module.exports = {
  testConnection,
  getClients,
  getRouterHealth,
  setClientBlocked,
  setGuestWifi,
  setRequestFn,
  resetForTest,
};
