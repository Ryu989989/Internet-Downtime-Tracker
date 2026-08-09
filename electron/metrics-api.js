"use strict";

/**
 * InfluxDB2 / Elasticsearch push + localhost-only Prometheus + optional HTTP API.
 * Never binds 0.0.0.0.
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { isBlockedProbeHost } = require("./netcheck");

const BIND_HOST = "127.0.0.1";

/** @type {http.Server | null} */
let promServer = null;
/** @type {http.Server | null} */
let apiServer = null;
/** @type {() => object} */
let metricsProvider = () => ({ devices_online: 0, outages_open: 0 });
/** @type {() => object} */
let apiProvider = () => ({ devices: [], status: {}, outages: [] });
let apiToken = "";

function setMetricsProvider(fn) {
  metricsProvider = fn;
}
function setApiProvider(fn) {
  apiProvider = fn;
}

function assertLocalhostUrl(urlStr) {
  let u;
  try {
    u = new URL(String(urlStr));
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u;
}

function postBody(urlStr, body, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const u = assertLocalhostUrl(urlStr);
    if (!u) {
      resolve({ ok: false, error: "bad url" });
      return;
    }
    // Outbound push may target remote Influx/ES — block metadata only
    if (u.hostname === "169.254.169.254" || u.hostname === "metadata.google.internal") {
      resolve({ ok: false, error: "blocked host" });
      return;
    }
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      }
    );
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.write(payload);
    req.end();
  });
}

function renderPrometheus(m) {
  const lines = [
    "# HELP idt_devices_online Online LAN devices",
    "# TYPE idt_devices_online gauge",
    `idt_devices_online ${Number(m.devices_online) || 0}`,
    "# HELP idt_outages_open Open outages",
    "# TYPE idt_outages_open gauge",
    `idt_outages_open ${Number(m.outages_open) || 0}`,
    "# HELP idt_outages_total Closed+open outages observed (counter approx)",
    "# TYPE idt_outages_total counter",
    `idt_outages_total ${Number(m.outages_total) || 0}`,
  ];
  return lines.join("\n") + "\n";
}

function startPrometheus(port = 9108) {
  stopPrometheus();
  const p = Math.min(65535, Math.max(1024, Number(port) || 9108));
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/metrics" || req.url === "/metrics/") {
        const body = renderPrometheus(metricsProvider() || {});
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    server.on("error", reject);
    server.listen(p, BIND_HOST, () => {
      promServer = server;
      resolve({ ok: true, host: BIND_HOST, port: p, path: "/metrics" });
    });
  });
}

function stopPrometheus() {
  if (promServer) {
    try {
      promServer.close();
    } catch {
      /* ignore */
    }
    promServer = null;
  }
}

function startHttpApi(port = 9109, token = "") {
  stopHttpApi();
  apiToken = String(token || "");
  const p = Math.min(65535, Math.max(1024, Number(port) || 9109));
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const auth = req.headers.authorization || "";
      const q = new URL(req.url || "/", `http://${BIND_HOST}`).searchParams.get("token");
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const got = bearer || q || "";
      if (!apiToken || got !== apiToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      const pathName = (req.url || "").split("?")[0];
      const data = apiProvider() || {};
      if (pathName === "/api/status" || pathName === "/api/status/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, status: data.status || {} }));
        return;
      }
      if (pathName === "/api/devices" || pathName === "/api/devices/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, devices: data.devices || [] }));
        return;
      }
      if (pathName === "/api/outages" || pathName === "/api/outages/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, outages: data.outages || [] }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    });
    server.on("error", reject);
    server.listen(p, BIND_HOST, () => {
      apiServer = server;
      resolve({ ok: true, host: BIND_HOST, port: p });
    });
  });
}

function stopHttpApi() {
  if (apiServer) {
    try {
      apiServer.close();
    } catch {
      /* ignore */
    }
    apiServer = null;
  }
}

async function pushInflux(settings, fields) {
  if (!settings || !settings.influx_enabled) return { ok: false, skipped: true };
  const url = String(settings.influx_url || "").trim();
  const token = String(settings.influx_token || "").trim();
  const org = String(settings.influx_org || "").trim();
  const bucket = String(settings.influx_bucket || "").trim();
  if (!url || !token || !org || !bucket) return { ok: false, error: "incomplete influx settings" };
  const u = new URL(url.includes("/api/v2/write") ? url : url.replace(/\/$/, "") + "/api/v2/write");
  u.searchParams.set("org", org);
  u.searchParams.set("bucket", bucket);
  u.searchParams.set("precision", "s");
  const lines = [];
  const ts = Math.floor(Date.now() / 1000);
  lines.push(`idt_devices online=${Number(fields.devices_online) || 0}i ${ts}`);
  lines.push(`idt_outages open=${Number(fields.outages_open) || 0}i ${ts}`);
  return postBody(u.toString(), lines.join("\n"), {
    Authorization: `Token ${token}`,
    "Content-Type": "text/plain; charset=utf-8",
  });
}

async function pushElastic(settings, docs) {
  if (!settings || !settings.es_enabled) return { ok: false, skipped: true };
  const url = String(settings.es_url || "").trim();
  if (!url) return { ok: false, error: "missing es_url" };
  const key = String(settings.es_api_key || "").trim();
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `ApiKey ${key}`;
  const bulk = [];
  for (const doc of docs || []) {
    bulk.push(JSON.stringify({ index: { _index: doc._index || "idt" } }));
    bulk.push(JSON.stringify(doc.body || doc));
  }
  const endpoint = url.replace(/\/$/, "") + "/_bulk";
  return postBody(endpoint, bulk.join("\n") + "\n", headers);
}

function status() {
  return {
    prometheus: !!promServer,
    http_api: !!apiServer,
    bind: BIND_HOST,
  };
}

function stopAll() {
  stopPrometheus();
  stopHttpApi();
}

module.exports = {
  BIND_HOST,
  setMetricsProvider,
  setApiProvider,
  startPrometheus,
  stopPrometheus,
  startHttpApi,
  stopHttpApi,
  pushInflux,
  pushElastic,
  renderPrometheus,
  status,
  stopAll,
  isBlockedProbeHost,
};
