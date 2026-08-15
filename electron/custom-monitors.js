"use strict";

/**
 * User-defined multi-target monitors (TCP/HTTP/PING) evaluated on independent
 * intervals. Results are written to monitor_checks; up/down transitions call
 * the shared notifier.
 */

const {
  tcpConnect,
  pingHost,
  checkHttp,
  isBlockedProbeHost,
  isBlockedHttpUrl,
} = require("./netcheck");
const { notify } = require("./notify-webhooks");

const active = new Map();
let stopped = true;
let notifyFn = notify;
let probeOverrides = null;

function setNotifyFn(fn) {
  notifyFn = fn || notify;
}

function setProbeFunctionsForTest(fns) {
  probeOverrides = fns || null;
}

function resetForTest() {
  stopCustomMonitors();
  notifyFn = notify;
  probeOverrides = null;
}

function parseMonitors(settings) {
  const raw = settings && settings.monitors_json ? String(settings.monitors_json) : "[]";
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((m) => {
      if (!m || typeof m !== "object" || typeof m.id !== "string" || !m.id) return false;
      const type = String(m.type || "").toLowerCase();
      if (!["tcp", "http", "ping"].includes(type)) return false;
      const rawUrl = String(m.url || "").trim();
      const rawHost = String(m.host || "").trim();
      if (type === "http") {
        if (!rawUrl && !rawHost) return false;
        const url = normalizeHttpUrl(rawUrl || rawHost);
        return !!url;
      }
      return !!rawHost && !isBlockedProbeHost(rawHost);
    });
  } catch {
    return [];
  }
}

function normalizeHttpUrl(raw) {
  let url = String(raw || "").trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return isBlockedHttpUrl(url) ? null : url;
}

async function probeMonitor(m) {
  const type = String(m.type || "").toLowerCase();
  const timeoutMs = Number.isFinite(Number(m.timeout_ms)) && Number(m.timeout_ms) > 0 ? Number(m.timeout_ms) : 5000;
  const started = Date.now();
  if (type === "tcp") {
    const host = String(m.host || "").trim();
    let port = Number.isFinite(Number(m.port)) ? Math.trunc(Number(m.port)) : 80;
    if (port <= 0 || port > 65535) port = 80;
    if (!host || isBlockedProbeHost(host)) {
      return { ok: false, latency_ms: null, error: "invalid tcp target" };
    }
    const impl = probeOverrides && probeOverrides.tcp ? probeOverrides.tcp : tcpConnect;
    const [ok, latency] = await impl(host, port, timeoutMs);
    return { ok: !!ok, latency_ms: ok ? latency : null, error: ok ? null : "tcp connect failed" };
  }
  if (type === "http") {
    const url = normalizeHttpUrl(m.url || m.host);
    if (!url) return { ok: false, latency_ms: null, error: "invalid http target" };
    const impl = probeOverrides && probeOverrides.http ? probeOverrides.http : checkHttp;
    const [ok, latency] = await impl({ url, timeoutMs });
    return { ok: !!ok, latency_ms: ok ? latency : null, error: ok ? null : "http failed" };
  }
  if (type === "ping") {
    const host = String(m.host || "").trim();
    if (!host || isBlockedProbeHost(host)) {
      return { ok: false, latency_ms: null, error: "invalid ping target" };
    }
    const timeoutS = timeoutMs / 1000;
    const impl = probeOverrides && probeOverrides.ping ? probeOverrides.ping : pingHost;
    const [ok, latency] = await impl(host, timeoutS);
    return { ok: !!ok, latency_ms: ok ? latency : null, error: ok ? null : "ping failed" };
  }
  return { ok: false, latency_ms: null, error: "unknown monitor type" };
}

async function tick(m, { db, monitor }) {
  const entry = active.get(m.id);
  if (!entry || stopped || entry.isRunning) return;
  if (monitor && (monitor.state.paused || monitor.state.probe_suppressed)) {
    return;
  }
  entry.isRunning = true;
  try {
    const result = await probeMonitor(m);
    const checkedAt = Date.now() / 1000;
    db.insertMonitorCheck({
      monitor_id: m.id,
      checked_at: checkedAt,
      ok: result.ok ? 1 : 0,
      latency_ms: result.latency_ms,
      error: result.error,
    });
    if (entry.lastOk !== null && entry.lastOk !== result.ok) {
      try {
        const settings = db.getSettings();
        const title = `Monitor ${result.ok ? "up" : "down"}: ${m.name || m.id}`;
        notifyFn({
          urls: settings.notify_webhooks_json,
          quietHours: settings.notify_quiet_hours_json,
          settings,
          event: result.ok ? "monitor_up" : "monitor_down",
          title,
          body: { monitor_id: m.id, name: m.name || m.id, type: m.type, host: m.host || m.url, ok: result.ok, latency_ms: result.latency_ms },
        });
      } catch (err) {
        console.error("monitor notify failed", err);
      }
    }
    entry.lastOk = result.ok;
  } catch (err) {
    console.error("custom monitor tick failed", err && err.stack ? err.stack : err);
  } finally {
    entry.isRunning = false;
  }
}

function startCustomMonitors({ db, monitor } = {}) {
  stopCustomMonitors();
  if (!db) return;
  const monitors = parseMonitors(db.getSettings());
  if (!monitors.length) return;
  stopped = false;
  for (const m of monitors) {
    const intervalMs = Math.max(5000, Math.trunc(Number(m.interval_s) || 60) * 1000);
    const first = setTimeout(async () => {
      await tick(m, { db, monitor });
    }, Math.floor(Math.random() * 3000));
    const timer = setInterval(async () => {
      await tick(m, { db, monitor });
    }, intervalMs);
    active.set(m.id, { timer, first, lastOk: null, isRunning: false });
  }
}

function stopCustomMonitors() {
  stopped = true;
  for (const entry of active.values()) {
    clearInterval(entry.timer);
    clearTimeout(entry.first);
  }
  active.clear();
}

function customMonitorStatus() {
  return Array.from(active.entries()).map(([id, entry]) => ({ id, lastOk: entry.lastOk, running: !stopped }));
}

function getActiveForTest() {
  return active;
}

module.exports = {
  startCustomMonitors,
  stopCustomMonitors,
  customMonitorStatus,
  parseMonitors,
  probeMonitor,
  setNotifyFn,
  setProbeFunctionsForTest,
  resetForTest,
  getActiveForTest,
};
