"use strict";

/**
 * Generic router/action webhook (quarantine-ish). No vendor SDKs.
 */

const https = require("https");
const http = require("http");
const { URL } = require("url");
const { normalizeWebhookUrl } = require("./notify-webhooks");

function renderTemplate(tpl, vars) {
  const s = String(tpl || "");
  return s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v == null ? "" : String(v);
  });
}

function buildPayload(device, event, template) {
  const vars = {
    mac: device.mac || "",
    ip: device.ip || "",
    alias: device.alias || "",
    vendor: device.vendor || "",
    event: event || "manual",
  };
  if (template && String(template).trim()) {
    try {
      return JSON.parse(renderTemplate(template, vars));
    } catch {
      return { ...vars, message: renderTemplate(template, vars) };
    }
  }
  return {
    event: vars.event,
    mac: vars.mac,
    ip: vars.ip,
    alias: vars.alias,
    vendor: vars.vendor,
    ts: Date.now() / 1000,
    note: "IDT router action webhook — wire to OPNsense/firewall script; no bundled vendor plugins.",
  };
}

function post(urlStr, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const safe = normalizeWebhookUrl(urlStr);
    if (!safe) {
      resolve({ ok: false, error: "invalid or blocked webhook URL" });
      return;
    }
    let u;
    try {
      u = new URL(safe);
    } catch {
      resolve({ ok: false, error: "bad url" });
      return;
    }
    const payload = JSON.stringify(body).slice(0, 8000);
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

async function notifyRouter({ url, template, device, event }) {
  if (!url) return { ok: false, error: "no router webhook URL" };
  const body = buildPayload(device || {}, event || "manual", template);
  const r = await post(url, body);
  return { ...r, payload_keys: Object.keys(body) };
}

module.exports = {
  renderTemplate,
  buildPayload,
  notifyRouter,
  normalizeWebhookUrl,
};
