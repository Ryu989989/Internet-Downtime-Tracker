"use strict";

/**
 * Multi-channel notifications: Discord/Slack/ntfy/Telegram/email + generic HTTPS webhooks,
 * plus quiet-hours digest. No secrets in logs. SSRF guards on URLs.
 */

const https = require("https");
const http = require("http");
const { URL } = require("url");
const { isBlockedProbeHost } = require("./netcheck");

let nodemailer = null;
try {
  nodemailer = require("nodemailer");
} catch {
  /* optional dependency */
}

const MAX_URLS = 8;
const MAX_BODY = 8000;
/** @type {{ type?: string, url?: string, settings?: object, event: string, title: string, body: object, at: number }[]} */
const digestQueue = [];

let postJsonOverride = null;
let emailTransporterOverride = null;

function setPostJsonForTest(fn) {
  postJsonOverride = fn || null;
}

function setEmailTransporterForTest(fn) {
  emailTransporterOverride = fn || null;
}

function isBlockedWebhookHost(hostname) {
  if (!hostname) return true;
  let h = String(hostname).toLowerCase().trim();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "metadata.google.internal") return true;
  if (h.startsWith("fe80:")) return true;
  if (h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return true;
  if (h === "169.254.169.254" || h === "100.100.100.200") return true;
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
  if (u.protocol === "http:") {
    // public http is rejected; private/internal http is allowed for local ntfy etc.
    if (isBlockedProbeHost(u.hostname) === false) return null;
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
      obj = JSON.parse(json);
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
  if (s === e) return true;
  if (s < e) return h >= s && h < e;
  return h >= s || h < e;
}

function detectChannel(url, settings = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "generic";
  }
  const host = u.hostname.toLowerCase();
  if (host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com")) return "discord";
  if (host === "hooks.slack.com" || host.endsWith(".slack.com")) return "slack";
  if (host === "api.telegram.org") return "telegram";
  if (host === "ntfy.sh") return "ntfy";
  if (settings && settings.ntfy_host) {
    const ntfyHost = String(settings.ntfy_host).toLowerCase().trim();
    if (host === ntfyHost) return "ntfy";
  }
  return "generic";
}

function ntfyTopicFromUrl(url, settings) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return settings && settings.ntfy_topic ? String(settings.ntfy_topic) : "";
  }
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length) return parts[0];
  return settings && settings.ntfy_topic ? String(settings.ntfy_topic) : "";
}

function buildChannelPayload(channel, { event, title, body, url, settings }) {
  const t = String(title || "").slice(0, 200);
  const b = body && typeof body === "object" ? body : {};
  const details = JSON.stringify(b).slice(0, 1500);
  const ts = new Date().toISOString();
  switch (channel) {
    case "discord":
      return {
        content: t,
        embeds: [
          {
            title: String(event || "notification"),
            description: details,
            color: 0xff6600,
            timestamp: ts,
          },
        ],
      };
    case "slack":
      return {
        text: t,
        blocks: [
          { type: "header", text: { type: "plain_text", text: t } },
          { type: "section", text: { type: "mrkdwn", text: `*${event}*\n${details}` } },
        ],
      };
    case "ntfy": {
      const topic = ntfyTopicFromUrl(url, settings);
      return {
        topic,
        title: t,
        message: details,
        priority: 4,
      };
    }
    case "telegram": {
      const chatId = settings && settings.telegram_chat_id ? String(settings.telegram_chat_id) : "";
      const payload = {
        chat_id: chatId,
        text: `${t}\n${details}`.slice(0, 4000),
      };
      const parseMode = settings && settings.telegram_parse_mode ? String(settings.telegram_parse_mode).trim() : "";
      if (parseMode) payload.parse_mode = parseMode;
      return payload;
    }
    default:
      return {
        event: event || "generic",
        title: t,
        ts: Date.now() / 1000,
        ...(b || {}),
      };
  }
}

function postJson(urlStr, body, timeoutMs = 8000) {
  if (postJsonOverride) {
    return postJsonOverride(urlStr, body, timeoutMs);
  }
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

let emailTransporter = null;
let emailTransporterKey = null;

function buildEmailTransporterKey(settings) {
  const host = String(settings.email_smtp_host || "").toLowerCase();
  const port = Number(settings.email_smtp_port) || 587;
  const user = String(settings.email_smtp_user || "");
  const pass = String(settings.email_smtp_pass || "");
  return `${host}:${port}:${user}:${pass}`;
}

async function sendEmail(settings, title, body) {
  const host = String(settings.email_smtp_host || "").trim();
  const to = String(settings.email_to || "").trim();
  if (!host || !to) return { ok: false, error: "missing smtp host or recipient" };
  if (isBlockedProbeHost(host) || isBlockedWebhookHost(host)) {
    return { ok: false, error: "smtp host blocked by SSRF guard" };
  }
  const port = Number(settings.email_smtp_port) || 587;
  const from = String(settings.email_from || settings.email_smtp_user || "").trim();
  const text = `${String(title || "")}\n\n${JSON.stringify(body || {}, null, 2)}`.slice(0, 8000);

  const mail = {
    from,
    to,
    subject: String(title || "Internet Downtime Tracker notification").slice(0, 200),
    text,
  };

  if (emailTransporterOverride) {
    return emailTransporterOverride(mail, settings);
  }

  if (!nodemailer) {
    return { ok: false, error: "nodemailer not installed" };
  }

  const key = buildEmailTransporterKey(settings);
  if (!emailTransporter || emailTransporterKey !== key) {
    emailTransporterKey = key;
    emailTransporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: settings.email_smtp_user
        ? { user: String(settings.email_smtp_user), pass: String(settings.email_smtp_pass || "") }
        : undefined,
    });
  }

  try {
    await emailTransporter.sendMail(mail);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function sendToTarget(target, { event, title, body, settings }) {
  if (target.type === "email") {
    return sendEmail(settings, title, body);
  }
  if (target.type === "telegram") {
    const token = settings && settings.telegram_bot_token ? String(settings.telegram_bot_token).trim() : "";
    const chatId = settings && settings.telegram_chat_id ? String(settings.telegram_chat_id).trim() : "";
    if (!token || !chatId) return { ok: false, error: "telegram token/chat missing" };
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = buildChannelPayload("telegram", { event, title, body, settings });
    return postJson(url, payload);
  }
  if (target.type === "ntfy" && target.url) {
    const payload = buildChannelPayload("ntfy", { event, title, body, url: target.url, settings });
    return postJson(target.url, payload);
  }
  const payload = buildChannelPayload(target.type, { event, title, body, url: target.url, settings });
  return postJson(target.url, payload);
}

function buildTargetList(urls, settings) {
  const targets = [];
  for (const url of urls) {
    targets.push({ type: detectChannel(url, settings), url });
  }
  if (settings) {
    if (settings.telegram_bot_token && settings.telegram_chat_id) {
      targets.push({ type: "telegram" });
    }
    if (settings.ntfy_host && settings.ntfy_topic) {
      const ntfyUrl = normalizeWebhookUrl(`https://${settings.ntfy_host}/${settings.ntfy_topic}`);
      if (ntfyUrl) targets.push({ type: "ntfy", url: ntfyUrl });
    }
    if (settings.email_smtp_host && settings.email_to) {
      targets.push({ type: "email" });
    }
  }
  return targets;
}

/**
 * @param {{ urls: string[], quietHours?: object|null, settings?: object, event: string, title: string, body?: object, force?: boolean }} opts
 */
async function notify(opts = {}) {
  const urls = parseWebhookList(opts.urls || []);
  const settings = opts.settings || {};
  const targets = buildTargetList(urls, settings);
  if (!targets.length) return { ok: false, skipped: true, reason: "no targets" };

  const qh = opts.quietHours ? parseQuietHours(opts.quietHours) : null;
  if (!opts.force && inQuietHours(qh)) {
    for (const target of targets) {
      digestQueue.push({
        target,
        event: opts.event || "generic",
        title: String(opts.title || ""),
        body: opts.body || {},
        settings,
        at: Date.now() / 1000,
      });
    }
    while (digestQueue.length > 50) digestQueue.shift();
    return { ok: true, queued: true, digest_size: digestQueue.length };
  }

  const results = [];
  for (const target of targets) {
    const r = await sendToTarget(target, { event: opts.event, title: opts.title, body: opts.body, settings });
    results.push({ ok: r.ok, type: target.type, status: r.status || null });
  }
  return { ok: results.some((r) => r.ok), results };
}

async function flushDigest(opts = {}) {
  if (!digestQueue.length) return { ok: true, flushed: 0 };
  const settings = opts.settings || {};
  const urls = parseWebhookList(opts.urls || []);
  const allowedUrls = new Set(urls);
  const items = digestQueue.splice(0, digestQueue.length);
  const digestPayload = {
    event: "digest",
    title: `Quiet-hours digest (${items.length})`,
    ts: Date.now() / 1000,
    items: items.slice(0, 30).map((i) => ({ title: i.title, event: i.event, at: i.at })),
  };
  const results = [];
  // Send one digest per unique webhook URL.
  for (const url of urls) {
    const channel = detectChannel(url, settings);
    const payload =
      channel === "generic"
        ? digestPayload
        : buildChannelPayload(channel, { event: "digest", title: digestPayload.title, body: digestPayload, url, settings });
    results.push(await postJson(url, payload));
  }
  // Email/Telegram are not batched in digest; resend individually if configured.
  const nonWeb = items.filter((i) => i.target.type !== "generic" && i.target.type !== "discord" && i.target.type !== "slack" && i.target.type !== "ntfy");
  for (const item of nonWeb) {
    if (item.target.type === "telegram" && !(settings.telegram_bot_token && settings.telegram_chat_id)) continue;
    if (item.target.type === "email" && !(settings.email_smtp_host && settings.email_to)) continue;
    results.push(await sendToTarget(item.target, { event: item.event, title: item.title, body: item.body, settings }));
  }
  return { ok: results.some((r) => r.ok), flushed: items.length, results };
}

function pendingDigestCount() {
  return digestQueue.length;
}

function clearDigestForTest() {
  digestQueue.length = 0;
  emailTransporter = null;
  emailTransporterKey = null;
  postJsonOverride = null;
  emailTransporterOverride = null;
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
  detectChannel,
  buildChannelPayload,
  ntfyTopicFromUrl,
  setPostJsonForTest,
  setEmailTransporterForTest,
  buildEmailTransporterKey,
};
