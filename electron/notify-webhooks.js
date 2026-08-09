"use strict";

/**
 * Shoutrrr-style HTTPS webhook notify + quiet hours digest.
 * No secrets in logs. SSRF guards on URLs.
 */

const https = require("https");
const http = require("http");
const { URL } = require("url");
const { isBlockedProbeHost } = require("./netcheck");

const MAX_URLS = 8;
const MAX_BODY = 8000;
/** @type {{ at: number, event: string, title: string, body: object }[]} */
const digestQueue = [];

function isBlockedWebhookHost(hostname) {
  if (!hostname) return true;
  let h = String(hostname).toLowerCase().trim();
  // URL.hostname may keep brackets for IPv6 literals
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "metadata.google.internal") return true;
  if (h.startsWith("fe80:")) return true;
  if (h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return true;
  if (h === "169.254.169.254" || h === "100.100.100.200") return true;
  // Block all link-local 169.254.0.0/16
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

function normalizeWebhookUrl(raw) {
  if (raw == null || typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 2000) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (isBlockedWebhookHost(u.hostname)) return null;
  // Prefer https; allow http only for private RFC1918 (local ntfy etc.)
  if (u.protocol === "http:") {
    if (isBlockedProbeHost(u.hostname) === false) {
      // public http — reject
      return null;
    }
    // isBlockedProbeHost true means private — OK for local notify
  }
  return u.toString();
}

function parseWebhookList(jsonOrArr) {
  let arr = jsonOrArr;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const url = normalizeWebhookUrl(typeof item === "string" ? item : item && item.url);
    if (url) out.push(url);
    if (out.length >= MAX_URLS) break;
  }
  return out;
}

function parseQuietHours(json) {
  let obj = json;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const start = Number(obj.start_hour);
  const end = Number(obj.end_hour);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start > 23 || end < 0 || end > 23) return null;
  return { start_hour: Math.trunc(start), end_hour: Math.trunc(end), enabled: obj.enabled !== false };
}

function inQuietHours(qh, date = new Date()) {
  if (!qh || qh.enabled === false) return false;
  const h = date.getHours();
  const { start_hour: s, end_hour: e } = qh;
  if (s === e) return true; // full-day quiet
  if (s < e) return h >= s && h < e;
  return h >= s || h < e;
}

function postJson(urlStr, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      resolve({ ok: false, error: "bad url" });
      return;
    }
    const payload = JSON.stringify(body).slice(0, MAX_BODY);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "User-Agent": "InternetDowntimeTracker/1.0",
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

/**
 * @param {{ urls: string[], quietHours?: object|null, event: string, title: string, body?: object, force?: boolean }} opts
 */
async function notify(opts = {}) {
  const urls = parseWebhookList(opts.urls || []);
  if (!urls.length) return { ok: false, skipped: true, reason: "no webhooks" };
  const qh = opts.quietHours ? parseQuietHours(opts.quietHours) : null;
  const payload = {
    event: opts.event || "generic",
    title: String(opts.title || "").slice(0, 200),
    ts: Date.now() / 1000,
    ...(opts.body || {}),
  };
  if (!opts.force && inQuietHours(qh)) {
    digestQueue.push({
      at: Date.now() / 1000,
      event: payload.event,
      title: payload.title,
      body: payload,
    });
    while (digestQueue.length > 50) digestQueue.shift();
    return { ok: true, queued: true, digest_size: digestQueue.length };
  }
  const results = [];
  for (const url of urls) {
    // Never log full URL (may contain tokens)
    const r = await postJson(url, payload);
    results.push({ ok: r.ok, status: r.status || null });
  }
  return { ok: results.some((r) => r.ok), results };
}

async function flushDigest(opts = {}) {
  const urls = parseWebhookList(opts.urls || []);
  if (!urls.length || !digestQueue.length) {
    return { ok: true, flushed: 0 };
  }
  const items = digestQueue.splice(0, digestQueue.length);
  const payload = {
    event: "digest",
    title: `Quiet-hours digest (${items.length})`,
    ts: Date.now() / 1000,
    items: items.slice(0, 30),
  };
  for (const url of urls) {
    await postJson(url, payload);
  }
  return { ok: true, flushed: items.length };
}

function pendingDigestCount() {
  return digestQueue.length;
}

function clearDigestForTest() {
  digestQueue.length = 0;
}

module.exports = {
  normalizeWebhookUrl,
  parseWebhookList,
  parseQuietHours,
  inQuietHours,
  notify,
  flushDigest,
  pendingDigestCount,
  clearDigestForTest,
  isBlockedWebhookHost,
};
