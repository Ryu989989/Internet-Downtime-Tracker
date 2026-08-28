"use strict";

const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const initSqlJs = require("sql.js");
const { isBlockedProbeHost, isBlockedHttpUrl } = require("./netcheck");
const { normalizeWebhookUrl, parseWebhookList } = require("./notify-webhooks");

const APP_DIR_NAME = "InternetDowntimeTracker";
/** Full sql.js export is expensive; debounce aggressively (probes are high-churn). */
const PERSIST_DEBOUNCE_MS = 30_000;

const DEFAULT_WIDGET_MODULES = {
  headline: true,
  layers: true,
  metrics: true,
  quality: false,
  streak: false,
  recent: false,
  quiet: false,
  speed: true,
};

const DEFAULT_SETTINGS = {
  poll_interval_s: 5,
  debounce_fail_count: 2,
  autostart: false,
  port: 8765, // unused in Electron; kept for Python DB compatibility
  probe_retention_days: 14,
  toast_alerts: false,
  /** When true: window close/minimize hide to tray (Quit still exits). */
  minimize_to_tray: true,
  wan_targets: "1.1.1.1:443,8.8.8.8:53",
  dns_resolver: "1.1.1.1",
  http_url: "http://connectivitycheck.gstatic.com/generate_204",
  connections_enabled: true,
  connections_resolve_dns: false,
  usage_monitoring: false,
  network_control_enabled: false,
  usage_caps_json: "{}",
  usage_alerts_json: "{}",
  wifi_alerts_json: "{}",
  lan_devices_enabled: true,
  lan_new_device_toast: false,
  snmp_enabled: false,
  snmp_community: "public",
  snmp_targets: "",
  sniffer_enabled: false,
  sniffer_always_on: false,
  notify_webhooks_json: "[]",
  notify_quiet_hours_json: "{}",
  influx_enabled: false,
  influx_url: "",
  influx_token: "",
  influx_org: "",
  influx_bucket: "",
  es_enabled: false,
  es_url: "",
  es_api_key: "",
  prom_metrics_enabled: false,
  http_api_enabled: false,
  http_api_token: "",
  lan_active_discovery: false,
  lan_discovery_interval_min: 15,
  router_webhook_url: "",
  router_webhook_template: "",
  router_webhook_auto_new: false,
  router_poll_enabled: false,
  router_writes_enabled: false,
  router_vendor: "asuswrt",
  router_host: "",
  router_https: false,
  router_user: "admin",
  router_password: "",
  router_interval_s: 30,
  router_port: "",
  router_targets_json: "[]",
  router_secrets_json: "{}",
  speedtest_interval_min: 0,
  auto_traceroute_on_outage: false,
  degradation_loss_pct: 0,
  degradation_latency_ms: 0,
  degradation_jitter_ms: 0,
  monitors_json: "[]",
  telegram_bot_token: "",
  telegram_chat_id: "",
  ntfy_host: "",
  ntfy_topic: "",
  email_smtp_host: "",
  email_smtp_port: "587",
  email_smtp_user: "",
  email_smtp_pass: "",
  email_from: "",
  email_to: "",
  widget_enabled: false,
  widget_always_on_top: true,
  widget_width: 360,
  widget_height: 220,
  widget_x: null,
  widget_y: null,
  widget_fill_pct: 72,
  widget_modules_json: JSON.stringify(DEFAULT_WIDGET_MODULES),
};

const SETTINGS_BOUNDS = {
  poll_interval_s: { min: 2, max: 3600 },
  debounce_fail_count: { min: 1, max: 20 },
  probe_retention_days: { min: 1, max: 365 },
  port: { min: 1, max: 65535 },
  lan_discovery_interval_min: { min: 5, max: 1440 },
  router_interval_s: { min: 15, max: 300 },
  speedtest_interval_min: { min: 0, max: 10080 },
  degradation_loss_pct: { min: 0, max: 100 },
  degradation_latency_ms: { min: 0, max: 30000 },
  degradation_jitter_ms: { min: 0, max: 30000 },
  email_smtp_port: { min: 1, max: 65535 },
  widget_fill_pct: { min: 20, max: 92 },
  widget_width: { min: 220, max: 720 },
  widget_height: { min: 88, max: 480 },
};

const BOOL_SETTINGS = new Set([
  "autostart",
  "toast_alerts",
  "minimize_to_tray",
  "connections_enabled",
  "connections_resolve_dns",
  "usage_monitoring",
  "network_control_enabled",
  "lan_devices_enabled",
  "lan_new_device_toast",
  "snmp_enabled",
  "sniffer_enabled",
  "sniffer_always_on",
  "influx_enabled",
  "es_enabled",
  "prom_metrics_enabled",
  "http_api_enabled",
  "lan_active_discovery",
  "router_webhook_auto_new",
  "router_poll_enabled",
  "router_writes_enabled",
  "router_https",
  "auto_traceroute_on_outage",
  "widget_enabled",
  "widget_always_on_top",
]);

const JSON_SETTINGS = new Set([
  "usage_caps_json",
  "usage_alerts_json",
  "wifi_alerts_json",
  "notify_webhooks_json",
  "notify_quiet_hours_json",
  "monitors_json",
  "widget_modules_json",
  "router_targets_json",
  "router_secrets_json",
]);

const STRING_SETTINGS_MAX = {
  snmp_community: 64,
  snmp_targets: 500,
  notify_webhooks_json: 8000,
  notify_quiet_hours_json: 500,
  influx_url: 500,
  influx_token: 500,
  influx_org: 120,
  influx_bucket: 120,
  es_url: 500,
  es_api_key: 500,
  http_api_token: 128,
  router_webhook_url: 2000,
  router_webhook_template: 4000,
  router_host: 253,
  router_user: 64,
  router_password: 256,
  telegram_bot_token: 256,
  telegram_chat_id: 120,
  ntfy_host: 120,
  ntfy_topic: 120,
  email_smtp_host: 120,
  email_smtp_port: 16,
  email_smtp_user: 256,
  email_smtp_pass: 256,
  email_from: 256,
  email_to: 256,
};

const OUTAGE_TYPES = new Set(["lan", "wan", "dns", "http"]);
const LIST_OUTAGES_LIMIT_MAX = 5000;

const SECRET_SETTINGS = new Set([
  "telegram_bot_token",
  "email_smtp_pass",
  "router_password",
  "router_secrets_json",
  "influx_token",
  "es_api_key",
  "http_api_token",
]);

const ROUTER_TARGETS_CAP = 4;
const ROUTER_TARGET_VENDORS = new Set(["asuswrt", "nighthawk", "unifi", "omada"]);

/**
 * Coerce/clamp a settings value. Returns null to reject (keep prior / skip write).
 * Rejects NaN, 0, and negatives for numeric tunables.
 */
function coerceBoolSetting(value) {
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "false" || s === "0" || s === "no" || s === "off") return false;
    if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
    return null;
  }
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return null;
}

const USAGE_JSON_SETTINGS_MAX = 8000;
const WIFI_ALERTS_MACS_CAP = 64;
const DEFAULT_WIFI_ALERTS = {
  enabled: false,
  rssi_dbm: null,
  signal_pct: null,
  debounce_n: 3,
  macs: [],
};

function normalizeAlertMac(raw) {
  const hex = String(raw || "")
    .replace(/[^0-9a-fA-F]/g, "")
    .toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(":");
}

/** Canonical wifi_alerts_json: { enabled, rssi_dbm, signal_pct, debounce_n, macs[] }. */
function normalizeWifiAlertsJson(value) {
  let obj;
  if (value == null) return null;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  } else if (typeof value === "object") {
    obj = value;
  } else {
    return null;
  }
  if (obj === null || Array.isArray(obj) || typeof obj !== "object") return null;
  const rssiRaw = obj.rssi_dbm;
  let rssi_dbm = null;
  if (rssiRaw != null && rssiRaw !== "") {
    const n = Number(rssiRaw);
    if (Number.isFinite(n)) rssi_dbm = Math.min(0, Math.max(-120, Math.round(n)));
  }
  const pctRaw = obj.signal_pct;
  let signal_pct = null;
  if (pctRaw != null && pctRaw !== "") {
    const n = Number(pctRaw);
    if (Number.isFinite(n)) signal_pct = Math.min(100, Math.max(0, Math.round(n)));
  }
  let debounce_n = Math.trunc(Number(obj.debounce_n));
  if (!Number.isFinite(debounce_n) || debounce_n < 1) debounce_n = 3;
  debounce_n = Math.min(20, Math.max(1, debounce_n));
  const macs = [];
  const seen = new Set();
  const rawMacs = Array.isArray(obj.macs) ? obj.macs : typeof obj.macs === "string" ? obj.macs.split(/[\s,]+/) : [];
  for (const item of rawMacs) {
    const mac = normalizeAlertMac(item);
    if (!mac || seen.has(mac)) continue;
    seen.add(mac);
    macs.push(mac);
    if (macs.length >= WIFI_ALERTS_MACS_CAP) break;
  }
  const text = JSON.stringify({
    enabled: !!obj.enabled,
    rssi_dbm,
    signal_pct,
    debounce_n,
    macs,
  });
  if (text.length > USAGE_JSON_SETTINGS_MAX) return null;
  return text;
}

function parseWifiAlertsJson(value) {
  const n = normalizeWifiAlertsJson(value);
  if (n == null) return { ...DEFAULT_WIFI_ALERTS, macs: [] };
  try {
    return JSON.parse(n);
  } catch {
    return { ...DEFAULT_WIFI_ALERTS, macs: [] };
  }
}

/** Normalize usage_caps_json / usage_alerts_json to a compact object JSON string. */
function normalizeUsageJsonSetting(value) {
  let obj;
  if (value == null) return null;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  } else if (typeof value === "object") {
    obj = value;
  } else {
    return null;
  }
  if (obj === null || Array.isArray(obj) || typeof obj !== "object") return null;
  const text = JSON.stringify(obj);
  if (text.length > USAGE_JSON_SETTINGS_MAX) return null;
  return text;
}

/** Serialize snapshot JSON without mid-string truncation (keeps parseable JSON). */
function encodeSnapshotJson(snapshot, maxLen = 8000) {
  if (snapshot == null) return null;
  if (typeof snapshot === "string") {
    try {
      return encodeSnapshotJson(JSON.parse(snapshot), maxLen);
    } catch {
      return JSON.stringify({ note: snapshot.slice(0, Math.max(0, maxLen - 20)) }).slice(
        0,
        maxLen
      );
    }
  }
  let text = JSON.stringify(snapshot);
  if (text.length <= maxLen) return text;
  // Drop bulky nested blobs first, then shrink string fields.
  const slim = { ...snapshot };
  for (const key of Object.keys(slim)) {
    if (slim[key] && typeof slim[key] === "object") {
      slim[key] = { truncated: true };
      text = JSON.stringify(slim);
      if (text.length <= maxLen) return text;
    }
  }
  for (const key of Object.keys(slim)) {
    if (typeof slim[key] === "string" && slim[key].length > 120) {
      slim[key] = slim[key].slice(0, 120);
    }
  }
  text = JSON.stringify(slim);
  if (text.length <= maxLen) return text;
  return JSON.stringify({ truncated: true, type: slim.type || null });
}

function normalizeJsonArrayOrObjectSetting(value, preferArray) {
  if (value == null) return null;
  let obj;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return preferArray ? "[]" : "{}";
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  } else {
    obj = value;
  }
  if (preferArray) {
    if (!Array.isArray(obj)) return null;
  } else if (obj === null || Array.isArray(obj) || typeof obj !== "object") {
    return null;
  }
  const text = JSON.stringify(obj);
  if (text.length > USAGE_JSON_SETTINGS_MAX) return null;
  return text;
}

function normalizeWidgetModulesJson(value) {
  let obj;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return JSON.stringify(DEFAULT_WIDGET_MODULES);
    try {
      obj = JSON.parse(s);
    } catch {
      return JSON.stringify(DEFAULT_WIDGET_MODULES);
    }
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    obj = value;
  } else {
    return JSON.stringify(DEFAULT_WIDGET_MODULES);
  }
  const out = { ...DEFAULT_WIDGET_MODULES };
  for (const k of Object.keys(DEFAULT_WIDGET_MODULES)) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const b = coerceBoolSetting(obj[k]);
    if (b != null) out[k] = b;
  }
  return JSON.stringify(out);
}

function normalizeWidgetCoord(value) {
  if (value == null || String(value).trim() === "") return null;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return null;
  return n;
}

function legacyRouterTargetFromSettings(s) {
  const vendor = String((s && s.router_vendor) || "asuswrt")
    .trim()
    .toLowerCase();
  return {
    id: "default",
    vendor: ROUTER_TARGET_VENDORS.has(vendor) ? vendor : "asuswrt",
    host: String((s && s.router_host) || "").trim(),
    user: String((s && s.router_user) || "").trim() || "admin",
    port: String((s && s.router_port) || "").trim(),
    https: !!(s && s.router_https),
    enabled: true,
  };
}

function parseRouterTargetsJson(value) {
  let arr;
  if (value == null || value === "") return [];
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return [];
    try {
      arr = JSON.parse(s);
    } catch {
      return null;
    }
  } else if (Array.isArray(value)) {
    arr = value;
  } else {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const out = [];
  const seen = new Set();
  for (const t of arr) {
    if (out.length >= ROUTER_TARGETS_CAP) break;
    if (!t || typeof t !== "object") continue;
    const id = String(t.id || "")
      .trim()
      .slice(0, 64);
    if (!id || seen.has(id) || !/^[a-zA-Z0-9_-]+$/.test(id)) continue;
    const vendor = String(t.vendor || "")
      .trim()
      .toLowerCase();
    if (!ROUTER_TARGET_VENDORS.has(vendor)) continue;
    const host = String(t.host == null ? "" : t.host)
      .trim()
      .slice(0, 253);
    const user = String(t.user == null ? "" : t.user)
      .trim()
      .slice(0, 64) || "admin";
    let port = "";
    if (t.port != null && String(t.port).trim() !== "") {
      const n = Math.trunc(Number(t.port));
      if (!Number.isFinite(n) || n < 1 || n > 65535) continue;
      port = String(n);
    }
    const en = coerceBoolSetting(t.enabled);
    const row = {
      id,
      vendor,
      host,
      user,
      port,
      https: !!t.https,
      enabled: en == null ? true : en,
    };
    if (vendor === "asuswrt") {
      const ssh_user = String(t.ssh_user == null ? "" : t.ssh_user).trim().slice(0, 64);
      let ssh_key_path = String(t.ssh_key_path == null ? "" : t.ssh_key_path)
        .trim()
        .slice(0, 512)
        .replace(/[\r\n\0]/g, "");
      if (/BEGIN .+ PRIVATE KEY/i.test(ssh_key_path) || ssh_key_path === "-" || ssh_key_path.startsWith("-")) {
        ssh_key_path = "";
      }
      const ifaceRaw = Array.isArray(t.ssh_ifaces) ? t.ssh_ifaces.join(",") : t.ssh_ifaces;
      const ssh_ifaces = String(ifaceRaw == null ? "" : ifaceRaw).trim().slice(0, 128);
      if (ssh_user) row.ssh_user = ssh_user;
      if (ssh_key_path) row.ssh_key_path = ssh_key_path;
      if (ssh_ifaces) row.ssh_ifaces = ssh_ifaces;
    }
    out.push(row);
    seen.add(id);
  }
  return out;
}

function parseRouterSecretsJson(value) {
  let obj;
  if (value == null || value === "") return {};
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return {};
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  } else if (typeof value === "object" && !Array.isArray(value)) {
    obj = value;
  } else {
    return null;
  }
  const out = {};
  for (const [id, creds] of Object.entries(obj)) {
    const key = String(id)
      .trim()
      .slice(0, 64);
    if (!key || !creds || typeof creds !== "object") continue;
    out[key] = {
      password: String(creds.password == null ? "" : creds.password).slice(0, 256),
      api_key: String(creds.api_key == null ? "" : creds.api_key).slice(0, 256),
    };
  }
  const text = JSON.stringify(out);
  if (text.length > USAGE_JSON_SETTINGS_MAX) return null;
  return out;
}

function mergeRouterSecrets(incoming, existing, targetIds) {
  const old = parseRouterSecretsJson(existing) || {};
  const inc = parseRouterSecretsJson(incoming);
  if (inc == null) return old;
  const ids =
    Array.isArray(targetIds) && targetIds.length ? targetIds : Object.keys({ ...old, ...inc });
  const out = {};
  for (const id of ids) {
    const n = inc[id] || {};
    const o = old[id] || {};
    out[id] = {
      password: String(n.password || "").trim() || o.password || "",
      api_key: String(n.api_key || "").trim() || o.api_key || "",
    };
  }
  return out;
}

function resolveRouterTargets(s) {
  const settings = s || {};
  let targets = parseRouterTargetsJson(settings.router_targets_json);
  if (targets == null) targets = [];
  let secrets = parseRouterSecretsJson(settings.router_secrets_json);
  if (secrets == null) secrets = {};
  if (!targets.length) {
    const t = legacyRouterTargetFromSettings(settings);
    targets = [t];
    const prev = secrets.default || {};
    secrets = {
      ...secrets,
      default: {
        password: String(settings.router_password || prev.password || ""),
        api_key: String(prev.api_key || ""),
      },
    };
  }
  return { targets, secrets };
}

function normalizeSettingValue(key, value) {
  if (BOOL_SETTINGS.has(key)) {
    return coerceBoolSetting(value);
  }
  if (key === "usage_caps_json" || key === "usage_alerts_json") {
    return normalizeUsageJsonSetting(value);
  }
  if (key === "wifi_alerts_json") {
    return normalizeWifiAlertsJson(value);
  }
  if (key === "notify_webhooks_json") {
    const raw = normalizeJsonArrayOrObjectSetting(value, true);
    if (raw == null) return null;
    const cleaned = parseWebhookList(raw);
    return JSON.stringify(cleaned);
  }
  if (key === "notify_quiet_hours_json") {
    return normalizeJsonArrayOrObjectSetting(value, false);
  }
  if (key === "widget_modules_json") {
    return normalizeWidgetModulesJson(value);
  }
  if (key === "widget_x" || key === "widget_y") {
    return normalizeWidgetCoord(value);
  }
  if (key === "router_webhook_url") {
    if (value == null || value === "") return "";
    const s = String(value).trim();
    if (s.length > STRING_SETTINGS_MAX.router_webhook_url) return null;
    return normalizeWebhookUrl(s) || null;
  }
  if (key === "router_vendor") {
    const s = String(value == null ? "" : value).trim().toLowerCase();
    if (ROUTER_TARGET_VENDORS.has(s)) return s;
    return null;
  }
  if (key === "router_port") {
    if (value == null || String(value).trim() === "") return "";
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n) || n < 1 || n > 65535) return null;
    return String(n);
  }
  if (key === "router_user") {
    const s = String(value == null ? "" : value).trim();
    if (!s) return "admin";
    if (s.length > STRING_SETTINGS_MAX.router_user) return null;
    return s;
  }
  if (key === "router_targets_json") {
    const parsed = parseRouterTargetsJson(value);
    if (parsed == null) return null;
    const text = JSON.stringify(parsed);
    if (text.length > USAGE_JSON_SETTINGS_MAX) return null;
    return text;
  }
  if (key === "router_secrets_json") {
    const parsed = parseRouterSecretsJson(value);
    if (parsed == null) return null;
    return JSON.stringify(parsed);
  }
  if (STRING_SETTINGS_MAX[key] != null && key !== "notify_webhooks_json" && key !== "notify_quiet_hours_json") {
    if (value == null) return "";
    const s = String(value).trim();
    if (s.length > STRING_SETTINGS_MAX[key]) return null;
    return s;
  }
  if (
    key === "speedtest_interval_min" ||
    key === "widget_fill_pct" ||
    key === "widget_width" ||
    key === "widget_height"
  ) {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n)) return null;
    const bounds = SETTINGS_BOUNDS[key];
    return Math.min(bounds.max, Math.max(bounds.min, n));
  }
  if (key === "degradation_loss_pct" || key === "degradation_latency_ms" || key === "degradation_jitter_ms" || key === "email_smtp_port") {
    const n = value === "" || value == null ? 0 : Math.trunc(Number(value));
    if (!Number.isFinite(n)) return null;
    const bounds = SETTINGS_BOUNDS[key];
    return Math.min(bounds.max, Math.max(bounds.min, n));
  }
  if (key === "monitors_json") {
    const raw = normalizeJsonArrayOrObjectSetting(value, true);
    if (raw == null) return null;
    let arr;
    try { arr = JSON.parse(raw); } catch { return null; }
    const out = [];
    for (const m of arr) {
      if (!m || typeof m !== "object" || typeof m.id !== "string" || !m.id) continue;
      const type = String(m.type || "").toLowerCase();
      if (!["tcp", "http", "ping"].includes(type)) continue;
      const rawUrl = String(m.url || "").trim();
      const rawHost = String(m.host || "").trim();
      if (type === "http") {
        if (!rawUrl && !rawHost) continue;
        let url = rawUrl || rawHost;
        if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
        if (isBlockedHttpUrl(url)) continue;
      } else {
        if (!rawHost) continue;
        if (isBlockedProbeHost(rawHost)) continue;
      }
      const interval_s = Math.trunc(Number(m.interval_s));
      const interval = Number.isFinite(interval_s) && interval_s >= 5 ? interval_s : 60;
      let port = m.port != null ? Math.trunc(Number(m.port)) : null;
      const host = type === "http" ? (rawUrl || rawHost) : rawHost;
      const clean = { id: m.id, name: String(m.name || m.id).slice(0, 64), type, host, interval_s: interval };
      if (type === "tcp") {
        if (port == null || port <= 0 || port > 65535) port = 80;
        clean.port = port;
      }
      if (type === "http") clean.url = rawUrl ? rawUrl.slice(0, 500) : (rawHost ? (rawHost.startsWith("http") ? rawHost.slice(0, 500) : `http://${rawHost}`.slice(0, 500)) : "");
      out.push(clean);
    }
    return JSON.stringify(out);
  }
  if (key === "wan_targets" || key === "dns_resolver" || key === "http_url") {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s || s.length > 500) return null;
    if (key === "http_url") {
      try {
        const u = new URL(s);
        if (u.protocol !== "http:" && u.protocol !== "https:") return null;
        if (isBlockedHttpUrl(s)) return null;
      } catch {
        return null;
      }
      return s;
    }
    if (key === "dns_resolver") {
      if (isBlockedProbeHost(s)) return null;
      return s;
    }
    for (const part of s.split(",")) {
      const bit = part.trim();
      if (!bit) continue;
      const host = bit.split(":")[0].trim();
      if (isBlockedProbeHost(host)) return null;
    }
    return s;
  }
  const bounds = SETTINGS_BOUNDS[key];
  if (!bounds) return value;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(bounds.max, Math.max(bounds.min, n));
}

function normalizeSettingsObject(settings) {
  const out = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const norm = normalizeSettingValue(key, out[key]);
    out[key] = norm == null ? DEFAULT_SETTINGS[key] : norm;
  }
  return out;
}

function dataDir() {
  const platform = process.platform;
  const home = require("os").homedir();
  let base;
  if (platform === "win32") {
    base = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  } else if (platform === "darwin") {
    base = path.join(home, "Library", "Application Support");
  } else {
    base = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  }
  const dir = path.join(base, APP_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dbPath() {
  return path.join(dataDir(), "tracker.db");
}

function wasmPath() {
  // sql.js exports block package.json; resolve main then sibling wasm.
  const main = require.resolve("sql.js");
  const normal = path.join(path.dirname(main), "sql-wasm.wasm");
  if (fs.existsSync(normal)) return normal;
  const unpacked = normal.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  if (fs.existsSync(unpacked)) return unpacked;
  return normal;
}

function rowsFromExec(result) {
  if (!result || !result.length) return [];
  const { columns, values } = result[0];
  return values.map((vals) => {
    const obj = {};
    columns.forEach((c, i) => {
      obj[c] = vals[i];
    });
    return obj;
  });
}

class TrackerDb {
  /**
   * @param {import('sql.js').Database} db
   * @param {string} filePath
   */
  constructor(db, filePath, SQL = null) {
    this.db = db;
    this.path = filePath;
    this._SQL = SQL;
    this._persistTimer = null;
    this._persistDirty = false;
    this._persistFailCount = 0;
    this._recovering = false;
    this._initSchema();
    this._persistImmediate();
  }

  static async open(filePath = null) {
    const SQL = await initSqlJs({
      locateFile: () => wasmPath(),
    });
    const fp = filePath || dbPath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    let db;
    if (fs.existsSync(fp)) {
      db = new SQL.Database(fs.readFileSync(fp));
    } else {
      db = new SQL.Database();
    }
    return new TrackerDb(db, fp, SQL);
  }

  /**
   * Atomic-ish write. Never throws — probe loop / IPC must stay alive if AV
   * briefly locks tracker.db (common source of intermittent "disk I/O error").
   */
  _persistNow() {
    let tmp = null;
    try {
      const data = Buffer.from(this.db.export());
      const dir = path.dirname(this.path);
      fs.mkdirSync(dir, { recursive: true });
      tmp = path.join(dir, `.${path.basename(this.path)}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, data);
      try {
        fs.renameSync(tmp, this.path);
        tmp = null;
      } catch {
        // Windows: rename-over often fails while readers/AV hold the file.
        try {
          fs.copyFileSync(tmp, this.path);
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* ignore */
          }
          tmp = null;
        } catch (err2) {
          throw err2;
        }
      }
      this._persistFailCount = 0;
      return true;
    } catch (err) {
      this._persistFailCount += 1;
      try {
        console.error("db persist failed", err);
      } catch {
        /* ignore */
      }
      if (tmp) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
      return false;
    }
  }

  _schedulePersist() {
    this._persistDirty = true;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      try {
        this._flushPersist();
      } catch (err) {
        // Belt-and-suspenders — _persistNow should not throw.
        try {
          console.error("db flush persist failed", err);
        } catch {
          /* ignore */
        }
      }
    }, PERSIST_DEBOUNCE_MS);
  }

  _flushPersist() {
    if (!this._persistDirty) return;
    this._persistDirty = false;
    if (!this._persistNow()) {
      // Retry later; keep dirty so we don't drop probe history.
      this._persistDirty = true;
      if (!this._persistTimer) {
        this._persistTimer = setTimeout(() => {
          this._persistTimer = null;
          try {
            this._flushPersist();
          } catch (err) {
            try {
              console.error("db flush persist retry failed", err);
            } catch {
              /* ignore */
            }
          }
        }, Math.min(60_000, PERSIST_DEBOUNCE_MS));
      }
    }
  }

  _persistImmediate() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    this._persistDirty = false;
    if (!this._persistNow()) {
      this._persistDirty = true;
      this._schedulePersist();
    }
  }

  /** Flush any debounced probe writes (e.g. before quit). */
  flushPersist() {
    this._persistImmediate();
  }

  _persist() {
    this._schedulePersist();
  }

  _isTransientDbError(err) {
    const msg = String((err && err.message) || err || "");
    return /disk I\/O|SQLITE_IOERR|malformed|corrupt|out of memory/i.test(msg);
  }

  /** Reload in-memory DB from the last on-disk snapshot after IOERR. */
  _tryRecoverFromDisk() {
    if (this._recovering || !this._SQL || !this.path) return false;
    if (!fs.existsSync(this.path)) return false;
    this._recovering = true;
    try {
      const buf = fs.readFileSync(this.path);
      const next = new this._SQL.Database(buf);
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      this.db = next;
      try {
        console.error("db recovered from disk after transient error");
      } catch {
        /* ignore */
      }
      return true;
    } catch (err) {
      try {
        console.error("db recover failed", err);
      } catch {
        /* ignore */
      }
      return false;
    } finally {
      this._recovering = false;
    }
  }

  _putSetting(key, value) {
    this._run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [key, JSON.stringify(value)]
    );
  }

  _settingRow(key) {
    const row = this._get("SELECT value FROM settings WHERE key=?", [key]);
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  _migrateLegacyRouterTargets() {
    const existing = parseRouterTargetsJson(this._settingRow("router_targets_json"));
    if (existing && existing.length) return;
    const s = {
      router_vendor: this._settingRow("router_vendor"),
      router_host: this._settingRow("router_host"),
      router_user: this._settingRow("router_user"),
      router_password: this._settingRow("router_password"),
      router_port: this._settingRow("router_port"),
      router_https: this._settingRow("router_https"),
    };
    const target = legacyRouterTargetFromSettings(s);
    const secrets = parseRouterSecretsJson(this._settingRow("router_secrets_json")) || {};
    if (!String((secrets.default && secrets.default.password) || "").trim()) {
      secrets.default = {
        password: String(s.router_password || "").slice(0, 256),
        api_key: (secrets.default && secrets.default.api_key) || "",
      };
    }
    this._putSetting("router_targets_json", JSON.stringify([target]));
    this._putSetting("router_secrets_json", JSON.stringify(secrets));
  }

  _applyRouterTargetUpdates(updates, existing, next) {
    const hasTargets = Object.prototype.hasOwnProperty.call(updates, "router_targets_json");
    const hasSecrets = Object.prototype.hasOwnProperty.call(updates, "router_secrets_json");
    const legacyKeys = [
      "router_vendor",
      "router_host",
      "router_user",
      "router_password",
      "router_port",
      "router_https",
    ];
    const hasLegacy = legacyKeys.some((k) => Object.prototype.hasOwnProperty.call(updates, k));
    if (!hasTargets && !hasSecrets && !hasLegacy) return;

    let targets = parseRouterTargetsJson(next.router_targets_json) || [];
    if (hasTargets) {
      const parsed = parseRouterTargetsJson(updates.router_targets_json);
      if (parsed) targets = parsed;
    }
    if (!targets.length) {
      targets = [legacyRouterTargetFromSettings(next)];
    } else if (hasLegacy && !hasTargets) {
      let idx = targets.findIndex((t) => t.id === "default");
      if (idx < 0) idx = 0;
      const t = { ...targets[idx] };
      if (Object.prototype.hasOwnProperty.call(updates, "router_vendor")) {
        t.vendor = next.router_vendor === "nighthawk" ? "nighthawk" : t.vendor;
      }
      if (Object.prototype.hasOwnProperty.call(updates, "router_host")) {
        t.host = String(next.router_host || "").trim();
      }
      if (Object.prototype.hasOwnProperty.call(updates, "router_user")) {
        t.user = String(next.router_user || "").trim() || "admin";
      }
      if (Object.prototype.hasOwnProperty.call(updates, "router_port")) {
        t.port = String(next.router_port || "").trim();
      }
      if (Object.prototype.hasOwnProperty.call(updates, "router_https")) {
        t.https = !!next.router_https;
      }
      targets[idx] = t;
    }

    const ids = targets.map((t) => t.id);
    let secrets = parseRouterSecretsJson(next.router_secrets_json) || {};
    if (hasSecrets) {
      const raw = updates.router_secrets_json;
      const blank = raw == null || String(raw).trim() === "";
      secrets = mergeRouterSecrets(blank ? "{}" : raw, secrets, ids);
    } else {
      secrets = mergeRouterSecrets("{}", secrets, ids);
      if (Object.prototype.hasOwnProperty.call(updates, "router_password")) {
        const pw = String(updates.router_password || "").trim();
        if (pw) {
          const id = (targets.find((x) => x.id === "default") || targets[0]).id;
          const prev = secrets[id] || {};
          secrets[id] = { password: pw, api_key: prev.api_key || "" };
        }
      }
    }

    const targetsJson = JSON.stringify(targets);
    const secretsJson = JSON.stringify(secrets);
    this._putSetting("router_targets_json", targetsJson);
    this._putSetting("router_secrets_json", secretsJson);
    next.router_targets_json = targetsJson;
    next.router_secrets_json = secretsJson;

    const t0 = targets[0];
    if (!t0) return;
    this._putSetting("router_vendor", t0.vendor);
    this._putSetting("router_host", t0.host);
    this._putSetting("router_user", t0.user);
    this._putSetting("router_port", t0.port);
    this._putSetting("router_https", t0.https);
    next.router_vendor = t0.vendor;
    next.router_host = t0.host;
    next.router_user = t0.user;
    next.router_port = t0.port;
    next.router_https = t0.https;
    const pw = secrets[t0.id] && secrets[t0.id].password;
    if (pw) {
      this._putSetting("router_password", pw);
      next.router_password = pw;
    }
  }

  _run(sql, params = []) {
    try {
      this.db.run(sql, params);
    } catch (err) {
      if (this._isTransientDbError(err) && this._tryRecoverFromDisk()) {
        this.db.run(sql, params);
        return;
      }
      throw err;
    }
  }

  _all(sql, params = []) {
    const run = () => {
      const stmt = this.db.prepare(sql);
      try {
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject());
        }
        return rows;
      } finally {
        try {
          stmt.free();
        } catch {
          /* ignore */
        }
      }
    };
    try {
      return run();
    } catch (err) {
      if (this._isTransientDbError(err) && this._tryRecoverFromDisk()) {
        return run();
      }
      throw err;
    }
  }

  _get(sql, params = []) {
    const rows = this._all(sql, params);
    return rows[0] || null;
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('lan', 'wan', 'dns', 'http')),
        started_at REAL NOT NULL,
        ended_at REAL,
        duration_ms INTEGER,
        notes TEXT,
        snapshot_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outages_started ON outages(started_at);
      CREATE INDEX IF NOT EXISTS idx_outages_type ON outages(type);
      CREATE INDEX IF NOT EXISTS idx_outages_open ON outages(ended_at);

      CREATE TABLE IF NOT EXISTS probes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp REAL NOT NULL,
        lan_ok INTEGER NOT NULL,
        wan_ok INTEGER NOT NULL,
        latency_ms REAL,
        dns_ok INTEGER,
        http_ok INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_probes_ts ON probes(timestamp);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS speed_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tested_at REAL NOT NULL,
        download_mbps REAL,
        upload_mbps REAL,
        ping_ms REAL,
        jitter_ms REAL,
        packet_loss REAL,
        server_name TEXT,
        server_id TEXT,
        server_location TEXT,
        isp TEXT,
        result_url TEXT,
        raw_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_speed_tests_at ON speed_tests(tested_at);

      CREATE TABLE IF NOT EXISTS usage_apps (
        app_key TEXT PRIMARY KEY,
        display_name TEXT,
        exe_path TEXT,
        ignored INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS usage_hourly (
        app_key TEXT NOT NULL,
        bucket_ts INTEGER NOT NULL,
        bytes_in INTEGER NOT NULL DEFAULT 0,
        bytes_out INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(app_key, bucket_ts)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_hourly_ts ON usage_hourly(bucket_ts);

      CREATE TABLE IF NOT EXISTS usage_daily (
        app_key TEXT NOT NULL,
        bucket_ts INTEGER NOT NULL,
        bytes_in INTEGER NOT NULL DEFAULT 0,
        bytes_out INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(app_key, bucket_ts)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_daily_ts ON usage_daily(bucket_ts);

      CREATE TABLE IF NOT EXISTS usage_alert_state (
        rule_key TEXT PRIMARY KEY,
        last_fired_at REAL
      );

      CREATE TABLE IF NOT EXISTS lan_devices (
        mac TEXT PRIMARY KEY,
        ip TEXT,
        vendor TEXT,
        alias TEXT,
        notes TEXT,
        hostname TEXT,
        state TEXT,
        iface TEXT,
        first_seen REAL,
        last_seen REAL,
        online INTEGER NOT NULL DEFAULT 0,
        source TEXT,
        gateway INTEGER NOT NULL DEFAULT 0,
        wifi_rssi REAL,
        wifi_signal_pct REAL,
        wifi_band TEXT,
        wifi_tx_mbps REAL,
        wifi_rx_mbps REAL,
        wifi_node_mac TEXT,
        wifi_ssid TEXT,
        last_wifi_at REAL
      );
      CREATE INDEX IF NOT EXISTS idx_lan_devices_ip ON lan_devices(ip);
      CREATE INDEX IF NOT EXISTS idx_lan_devices_last ON lan_devices(last_seen);

      CREATE TABLE IF NOT EXISTS wifi_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mac TEXT NOT NULL,
        source TEXT,
        at REAL NOT NULL,
        rssi REAL,
        signal_pct REAL,
        band TEXT,
        ssid TEXT,
        bssid TEXT,
        channel INTEGER,
        tx_mbps REAL,
        rx_mbps REAL,
        node_mac TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_wifi_samples_mac_at ON wifi_samples(mac, at);

      CREATE TABLE IF NOT EXISTS wifi_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at REAL NOT NULL,
        kind TEXT NOT NULL,
        ssid TEXT,
        bssid_from TEXT,
        bssid_to TEXT,
        reason_code TEXT,
        reason_text TEXT,
        event_id INTEGER,
        source TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_wifi_events_at ON wifi_events(at);

      CREATE TABLE IF NOT EXISTS router_health_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at REAL NOT NULL,
        cpu_pct REAL,
        mem_used REAL,
        mem_total REAL,
        wan_ok INTEGER,
        wan_ip TEXT,
        model TEXT,
        firmware TEXT,
        vendor TEXT,
        extra_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_router_health_at ON router_health_samples(at);

      CREATE TABLE IF NOT EXISTS router_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at REAL NOT NULL,
        target_id TEXT,
        action TEXT NOT NULL,
        mac TEXT,
        ok INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_router_actions_at ON router_actions(at);

      CREATE TABLE IF NOT EXISTS lan_scan_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_ip TEXT NOT NULL,
        started_at REAL NOT NULL,
        finished_at REAL,
        ports_json TEXT,
        cve_json TEXT,
        status TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_lan_scan_at ON lan_scan_results(started_at);

      CREATE TABLE IF NOT EXISTS monitor_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id TEXT NOT NULL,
        checked_at REAL NOT NULL,
        ok INTEGER NOT NULL DEFAULT 0,
        latency_ms REAL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_monitor_checks_monitor ON monitor_checks(monitor_id, checked_at);

      CREATE TABLE IF NOT EXISTS degradation_windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at REAL NOT NULL,
        ended_at REAL,
        duration_ms INTEGER,
        loss_pct REAL,
        jitter_ms REAL,
        latency_avg_ms REAL,
        notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_degradation_started ON degradation_windows(started_at);
    `);
    this._migrateSchema();
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      this._run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [
        key,
        JSON.stringify(value),
      ]);
    }
    this._migrateLegacyRouterTargets();
  }

  _migrateSchema() {
    // Expand outage type CHECK for DBs created before dns/http domains.
    const master = this._get(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='outages'"
    );
    if (master && master.sql && !String(master.sql).includes("'dns'")) {
      this.db.exec(`
        CREATE TABLE outages_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK(type IN ('lan', 'wan', 'dns', 'http')),
          started_at REAL NOT NULL,
          ended_at REAL,
          duration_ms INTEGER,
          notes TEXT,
          snapshot_json TEXT
        );
        INSERT INTO outages_new (id, type, started_at, ended_at, duration_ms, notes)
          SELECT id, type, started_at, ended_at, duration_ms, notes FROM outages;
        DROP TABLE outages;
        ALTER TABLE outages_new RENAME TO outages;
        CREATE INDEX IF NOT EXISTS idx_outages_started ON outages(started_at);
        CREATE INDEX IF NOT EXISTS idx_outages_type ON outages(type);
        CREATE INDEX IF NOT EXISTS idx_outages_open ON outages(ended_at);
      `);
    }

    const outageCols = new Set(
      this._all("PRAGMA table_info(outages)").map((c) => c.name)
    );
    if (!outageCols.has("snapshot_json")) {
      this._run("ALTER TABLE outages ADD COLUMN snapshot_json TEXT");
    }

    const probeCols = new Set(
      this._all("PRAGMA table_info(probes)").map((c) => c.name)
    );
    if (!probeCols.has("dns_ok")) {
      this._run("ALTER TABLE probes ADD COLUMN dns_ok INTEGER");
    }
    if (!probeCols.has("http_ok")) {
      this._run("ALTER TABLE probes ADD COLUMN http_ok INTEGER");
    }

    const lanCols = new Set(
      this._all("PRAGMA table_info(lan_devices)").map((c) => c.name)
    );
    if (!lanCols.has("hostname")) {
      this._run("ALTER TABLE lan_devices ADD COLUMN hostname TEXT");
    }
    if (!lanCols.has("state")) {
      this._run("ALTER TABLE lan_devices ADD COLUMN state TEXT");
    }
    if (!lanCols.has("iface")) {
      this._run("ALTER TABLE lan_devices ADD COLUMN iface TEXT");
    }
    if (!lanCols.has("wifi_rssi")) {
      this._run("ALTER TABLE lan_devices ADD COLUMN wifi_rssi REAL");
    }
    if (!lanCols.has("wifi_signal_pct")) {
      this._run("ALTER TABLE lan_devices ADD COLUMN wifi_signal_pct REAL");
    }
    if (!lanCols.has("wifi_band")) {
      this._run("ALTER TABLE lan_devices ADD COLUMN wifi_band TEXT");
    }
    if (!lanCols.has("wifi_tx_mbps")) {
      this._run("ALTER TABLE lan_devices ADD COLUMN wifi_tx_mbps REAL");
    }
    if (!lanCols.has("wifi_rx_mbps")) {
      this._run("ALTER TABLE lan_devices ADD COLUMN wifi_rx_mbps REAL");
    }
    if (!lanCols.has("wifi_node_mac")) {
      this._run("ALTER TABLE lan_devices ADD COLUMN wifi_node_mac TEXT");
    }
    if (!lanCols.has("wifi_ssid")) {
      this._run("ALTER TABLE lan_devices ADD COLUMN wifi_ssid TEXT");
    }
    if (!lanCols.has("last_wifi_at")) {
      this._run("ALTER TABLE lan_devices ADD COLUMN last_wifi_at REAL");
    }
  }

  close() {
    try {
      this._persistImmediate();
    } finally {
      this.db.close();
    }
  }

  getSettings() {
    const rows = this._all("SELECT key, value FROM settings");
    const out = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        out[row.key] = row.value;
      }
    }
    return normalizeSettingsObject(out);
  }

  updateSettings(updates) {
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
    const existing = this.getSettings();
    const next = { ...existing };
    const skip = new Set(["router_targets_json", "router_secrets_json"]);
    for (const [key, value] of Object.entries(updates || {})) {
      if (!allowed.has(key) || skip.has(key)) continue;
      // The UI redacts secrets to empty strings. Don't overwrite a saved secret
      // with a blank value from the form.
      if (
        SECRET_SETTINGS.has(key) &&
        String(value).trim() === "" &&
        existing[key] != null &&
        existing[key] !== ""
      ) {
        continue;
      }
      const normalized = normalizeSettingValue(key, value);
      if (normalized == null && key !== "widget_x" && key !== "widget_y") continue;
      next[key] = normalized;
      this._putSetting(key, normalized);
    }
    this._applyRouterTargetUpdates(updates || {}, existing, next);
    this._persistImmediate();
    return this.getSettings();
  }

  openOutage(outageType, startedAt = null, notes = null, snapshot = null) {
    const typ = String(outageType || "").toLowerCase();
    if (!OUTAGE_TYPES.has(typ)) {
      throw new Error(`invalid outage type: ${outageType}`);
    }
    const existing = this.getOpenOutage(typ);
    if (existing) return Number(existing.id);
    const ts = startedAt != null ? startedAt : Date.now() / 1000;
    const snap = encodeSnapshotJson(snapshot);
    this._run(
      "INSERT INTO outages (type, started_at, notes, snapshot_json) VALUES (?, ?, ?, ?)",
      [typ, ts, notes, snap]
    );
    const row = this._get("SELECT last_insert_rowid() AS id");
    this._persistImmediate();
    return Number(row.id);
  }

  updateOutageNotes(outageId, notes) {
    const id = Number(outageId);
    if (!Number.isFinite(id)) return null;
    const text = notes == null ? null : String(notes).slice(0, 2000);
    this._run("UPDATE outages SET notes=? WHERE id=?", [text, id]);
    this._persistImmediate();
    return this._get("SELECT * FROM outages WHERE id=?", [id]);
  }

  mergeOutageSnapshot(outageId, patch) {
    const id = Number(outageId);
    if (!Number.isFinite(id) || patch == null) return null;
    const row = this._get("SELECT snapshot_json FROM outages WHERE id=?", [id]);
    if (!row) return null;
    let cur = {};
    if (row.snapshot_json) {
      try {
        cur = JSON.parse(row.snapshot_json) || {};
      } catch {
        cur = {};
      }
    }
    const merged = { ...cur, ...(typeof patch === "object" ? patch : {}) };
    const text = encodeSnapshotJson(merged);
    this._run("UPDATE outages SET snapshot_json=? WHERE id=?", [text, id]);
    this._persistImmediate();
    return this._get("SELECT * FROM outages WHERE id=?", [id]);
  }

  closeOutage(outageId, endedAt = null, notes = null, snapshotPatch = null) {
    const ts = endedAt != null ? endedAt : Date.now() / 1000;
    const row = this._get(
      "SELECT started_at, notes, snapshot_json FROM outages WHERE id=?",
      [outageId]
    );
    if (!row) return;
    const durationMs = Math.max(0, Math.floor((ts - row.started_at) * 1000));
    let merged = notes;
    if (notes && row.notes) merged = `${row.notes}; ${notes}`;
    else if (row.notes && !notes) merged = row.notes;
    let snapText = row.snapshot_json || null;
    if (snapshotPatch != null) {
      let cur = {};
      if (row.snapshot_json) {
        try {
          cur = JSON.parse(row.snapshot_json) || {};
        } catch {
          cur = {};
        }
      }
      const next = {
        ...cur,
        ...(typeof snapshotPatch === "object" ? snapshotPatch : {}),
      };
      snapText = encodeSnapshotJson(next);
    }
    this._run(
      "UPDATE outages SET ended_at=?, duration_ms=?, notes=?, snapshot_json=? WHERE id=?",
      [ts, durationMs, merged, snapText, outageId]
    );
    this._persistImmediate();
  }

  insertMonitorCheck({ monitor_id, checked_at, ok, latency_ms, error }) {
    const ts = checked_at != null ? Number(checked_at) : Date.now() / 1000;
    this._run(
      `INSERT INTO monitor_checks (monitor_id, checked_at, ok, latency_ms, error)
       VALUES (?, ?, ?, ?, ?)`,
      [
        String(monitor_id || "").slice(0, 64),
        ts,
        ok ? 1 : 0,
        latency_ms != null ? Number(latency_ms) : null,
        error != null ? String(error).slice(0, 200) : null,
      ]
    );
    this._persist();
  }

  listMonitorChecks({ monitor_id = null, fromTs = null, toTs = null, limit = 1000 } = {}) {
    const clauses = [];
    const params = [];
    if (monitor_id != null && String(monitor_id).trim()) {
      clauses.push("monitor_id = ?");
      params.push(String(monitor_id).slice(0, 64));
    }
    if (fromTs != null) {
      clauses.push("checked_at >= ?");
      params.push(Number(fromTs));
    }
    if (toTs != null) {
      clauses.push("checked_at <= ?");
      params.push(Number(toTs));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const lim = Math.max(1, Math.min(10000, Math.trunc(Number(limit)) || 1000));
    params.push(lim);
    return this._all(
      `SELECT * FROM monitor_checks ${where} ORDER BY checked_at DESC LIMIT ?`,
      params
    );
  }

  getLatestMonitorCheck(monitor_id) {
    return this._get(
      `SELECT * FROM monitor_checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 1`,
      [String(monitor_id || "").slice(0, 64)]
    );
  }

  insertDegradationWindow({ started_at, ended_at, loss_pct, jitter_ms, latency_avg_ms, notes }) {
    const start = Number(started_at) || Date.now() / 1000;
    const end = ended_at != null ? Number(ended_at) : null;
    const dur = end != null ? Math.max(0, Math.floor((end - start) * 1000)) : null;
    this._run(
      `INSERT INTO degradation_windows (started_at, ended_at, duration_ms, loss_pct, jitter_ms, latency_avg_ms, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        start,
        end,
        dur,
        loss_pct != null ? Number(loss_pct) : null,
        jitter_ms != null ? Number(jitter_ms) : null,
        latency_avg_ms != null ? Number(latency_avg_ms) : null,
        notes != null ? String(notes).slice(0, 2000) : null,
      ]
    );
    this._persistImmediate();
    return this._get("SELECT last_insert_rowid() AS id");
  }

  getOpenDegradationWindow() {
    return this._get(
      "SELECT * FROM degradation_windows WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
    );
  }

  closeDegradationWindow(id, ended_at, notes = null) {
    const row = this._get("SELECT started_at, notes FROM degradation_windows WHERE id=?", [id]);
    if (!row) return null;
    const end = Number(ended_at) || Date.now() / 1000;
    const dur = Math.max(0, Math.floor((end - row.started_at) * 1000));
    let merged = notes;
    if (notes && row.notes) merged = `${row.notes}; ${notes}`;
    else if (row.notes && !notes) merged = row.notes;
    this._run(
      "UPDATE degradation_windows SET ended_at=?, duration_ms=?, notes=? WHERE id=?",
      [end, dur, merged, id]
    );
    this._persistImmediate();
    return this._get("SELECT * FROM degradation_windows WHERE id=?", [id]);
  }

  listDegradationWindows({ fromTs = null, toTs = null, limit = 500 } = {}) {
    const clauses = [];
    const params = [];
    if (fromTs != null) {
      clauses.push("(ended_at IS NULL OR ended_at >= ?)");
      params.push(Number(fromTs));
    }
    if (toTs != null) {
      clauses.push("started_at <= ?");
      params.push(Number(toTs));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const lim = Math.max(1, Math.min(10000, Math.trunc(Number(limit)) || 500));
    params.push(lim);
    return this._all(
      `SELECT * FROM degradation_windows ${where} ORDER BY started_at DESC LIMIT ?`,
      params
    );
  }

  getSettingsPublic() {
    const s = this.getSettings();
    const out = { ...s };
    for (const key of SECRET_SETTINGS) {
      if (out[key] != null) out[key] = "";
    }
    return out;
  }

  getOpenOutages() {
    return this._all(
      "SELECT * FROM outages WHERE ended_at IS NULL ORDER BY started_at"
    );
  }

  getOpenOutage(outageType) {
    return this._get(
      `SELECT * FROM outages WHERE type=? AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
      [outageType]
    );
  }

  listOutages({
    fromTs = null,
    toTs = null,
    outageType = null,
    minMs = null,
    limit = 500,
    orderBy = "started_at",
    orderDir = "DESC",
  } = {}) {
    const clauses = [];
    const params = [];
    if (fromTs != null) {
      clauses.push("(ended_at IS NULL OR ended_at >= ?)");
      params.push(fromTs);
    }
    if (toTs != null) {
      clauses.push("started_at <= ?");
      params.push(toTs);
    }
    if (
      outageType &&
      String(outageType).toLowerCase() !== "all" &&
      outageType !== ""
    ) {
      clauses.push("type = ?");
      params.push(String(outageType).toLowerCase());
    }
    if (minMs != null) {
      clauses.push(
        "COALESCE(duration_ms, CAST((? - started_at) * 1000 AS INTEGER)) >= ?"
      );
      params.push(Date.now() / 1000, minMs);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const col =
      orderBy === "duration"
        ? "duration_ms"
        : orderBy === "type"
          ? "type"
          : "started_at";
    const direction =
      String(orderDir).toUpperCase() === "ASC" ? "ASC" : "DESC";
    const lim = Math.max(
      1,
      Math.min(LIST_OUTAGES_LIMIT_MAX, Math.trunc(Number(limit)) || 500)
    );
    params.push(lim);
    return this._all(
      `SELECT * FROM outages${where} ORDER BY ${col} ${direction} LIMIT ?`,
      params
    );
  }

  /**
   * Legacy helper retained for tests/callers. Does NOT close outages on a single
   * probe — Monitor adopts open IDs and closes via the normal 1-success path
   * after a post-resume grace tick (avoids flaky first-probe closes).
   */
  resumeOpenOutages(_resultOrLanOk, _wanOkArg = null) {
    return this.getOpenOutages();
  }

  insertProbe(lanOk, wanOk, latencyMs, ts = null, dnsOk = null, httpOk = null) {
    const t = ts != null ? ts : Date.now() / 1000;
    this._run(
      `INSERT INTO probes (timestamp, lan_ok, wan_ok, latency_ms, dns_ok, http_ok)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        t,
        lanOk ? 1 : 0,
        wanOk ? 1 : 0,
        latencyMs,
        dnsOk == null ? null : dnsOk ? 1 : 0,
        httpOk == null ? null : httpOk ? 1 : 0,
      ]
    );
    this._persist();
  }

  pruneProbes(retentionDays = null) {
    let days = retentionDays;
    if (days == null) {
      days = Number(this.getSettings().probe_retention_days ?? 14);
    }
    const cutoff = Date.now() / 1000 - days * 86400;
    this._run("DELETE FROM probes WHERE timestamp < ?", [cutoff]);
    this._run("DELETE FROM wifi_samples WHERE at < ?", [cutoff]);
    this._run("DELETE FROM wifi_events WHERE at < ?", [cutoff]);
    this._run("DELETE FROM router_health_samples WHERE at < ?", [cutoff]);
    this._run("DELETE FROM router_actions WHERE at < ?", [cutoff]);
    this._persistImmediate();
    return 0;
  }

  probesSince(sinceTs) {
    return this._all(
      "SELECT * FROM probes WHERE timestamp >= ? ORDER BY timestamp",
      [sinceTs]
    );
  }

  insertSpeedTest(row) {
    this._run(
      `INSERT INTO speed_tests (
        tested_at, download_mbps, upload_mbps, ping_ms, jitter_ms, packet_loss,
        server_name, server_id, server_location, isp, result_url, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.tested_at,
        row.download_mbps,
        row.upload_mbps,
        row.ping_ms,
        row.jitter_ms,
        row.packet_loss,
        row.server_name,
        row.server_id,
        row.server_location,
        row.isp,
        row.result_url,
        row.raw_json || null,
      ]
    );
    const idRow = this._get("SELECT last_insert_rowid() AS id");
    this._persistImmediate();
    return this.getSpeedTest(idRow.id);
  }

  getSpeedTest(id) {
    return this._get("SELECT * FROM speed_tests WHERE id=?", [id]);
  }

  latestSpeedTest() {
    return this._get("SELECT * FROM speed_tests ORDER BY tested_at DESC LIMIT 1");
  }

  listSpeedTests({ fromTs = null, toTs = null, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (fromTs != null) {
      clauses.push("tested_at >= ?");
      params.push(fromTs);
    }
    if (toTs != null) {
      clauses.push("tested_at <= ?");
      params.push(toTs);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const lim = Math.max(1, Math.min(1000, Math.trunc(Number(limit)) || 100));
    params.push(lim);
    return this._all(
      `SELECT * FROM speed_tests ${where} ORDER BY tested_at DESC LIMIT ?`,
      params
    );
  }

  upsertUsageApp({ app_key, display_name, exe_path, ignored = undefined }) {
    const key = String(app_key || "").trim();
    if (!key) return null;
    const name = display_name == null ? null : String(display_name).slice(0, 256);
    const exe = exe_path == null ? null : String(exe_path).slice(0, 1024);
    const existing = this._get("SELECT ignored FROM usage_apps WHERE app_key=?", [key]);
    const ign =
      ignored !== undefined ? (ignored ? 1 : 0) : existing ? existing.ignored : 0;
    this._run(
      `INSERT INTO usage_apps (app_key, display_name, exe_path, ignored)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(app_key) DO UPDATE SET
         display_name=excluded.display_name,
         exe_path=excluded.exe_path,
         ignored=excluded.ignored`,
      [key, name, exe, ign]
    );
    this._persist();
    return this._get("SELECT * FROM usage_apps WHERE app_key=?", [key]);
  }

  setUsageIgnored(app_key, ignored) {
    const key = String(app_key || "").trim();
    if (!key) return null;
    this._run("UPDATE usage_apps SET ignored=? WHERE app_key=?", [
      ignored ? 1 : 0,
      key,
    ]);
    this._persist();
    return this._get("SELECT * FROM usage_apps WHERE app_key=?", [key]);
  }

  listUsageApps({ includeIgnored = false } = {}) {
    if (includeIgnored) {
      return this._all(
        "SELECT * FROM usage_apps ORDER BY display_name, app_key"
      );
    }
    return this._all(
      "SELECT * FROM usage_apps WHERE ignored=0 ORDER BY display_name, app_key"
    );
  }

  addUsageBytes({ app_key, bytes_in = 0, bytes_out = 0, atMs = null } = {}) {
    const key = String(app_key || "").trim();
    if (!key) return;
    const bi = Math.max(0, Math.trunc(Number(bytes_in)) || 0);
    const bo = Math.max(0, Math.trunc(Number(bytes_out)) || 0);
    if (!bi && !bo) return;
    const ms = atMs != null ? Number(atMs) : Date.now();
    if (!Number.isFinite(ms)) return;
    const sec = Math.floor(ms / 1000);
    const hourTs = Math.floor(sec / 3600) * 3600;
    const dayTs = Math.floor(sec / 86400) * 86400;
    this._run(
      `INSERT INTO usage_hourly (app_key, bucket_ts, bytes_in, bytes_out)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(app_key, bucket_ts) DO UPDATE SET
         bytes_in=bytes_in+excluded.bytes_in,
         bytes_out=bytes_out+excluded.bytes_out`,
      [key, hourTs, bi, bo]
    );
    this._run(
      `INSERT INTO usage_daily (app_key, bucket_ts, bytes_in, bytes_out)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(app_key, bucket_ts) DO UPDATE SET
         bytes_in=bytes_in+excluded.bytes_in,
         bytes_out=bytes_out+excluded.bytes_out`,
      [key, dayTs, bi, bo]
    );
    this._persist();
  }

  listUsageHourly({ fromTs = null, toTs = null, app_key = null } = {}) {
    const clauses = [];
    const params = [];
    if (fromTs != null) {
      clauses.push("bucket_ts >= ?");
      params.push(Math.trunc(Number(fromTs)));
    }
    if (toTs != null) {
      clauses.push("bucket_ts <= ?");
      params.push(Math.trunc(Number(toTs)));
    }
    if (app_key != null && String(app_key).trim()) {
      clauses.push("app_key = ?");
      params.push(String(app_key).trim());
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this._all(
      `SELECT app_key, bucket_ts, bytes_in, bytes_out
       FROM usage_hourly ${where} ORDER BY bucket_ts, app_key`,
      params
    );
  }

  listUsageDaily({ fromTs = null, toTs = null, app_key = null } = {}) {
    const clauses = [];
    const params = [];
    if (fromTs != null) {
      clauses.push("bucket_ts >= ?");
      params.push(Math.trunc(Number(fromTs)));
    }
    if (toTs != null) {
      clauses.push("bucket_ts <= ?");
      params.push(Math.trunc(Number(toTs)));
    }
    if (app_key != null && String(app_key).trim()) {
      clauses.push("app_key = ?");
      params.push(String(app_key).trim());
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this._all(
      `SELECT app_key, bucket_ts, bytes_in, bytes_out
       FROM usage_daily ${where} ORDER BY bucket_ts, app_key`,
      params
    );
  }

  usageTotals({ fromTs = null, toTs = null, granularity = "hourly" } = {}) {
    const table = granularity === "daily" ? "usage_daily" : "usage_hourly";
    const clauses = [];
    const params = [];
    if (fromTs != null) {
      clauses.push("bucket_ts >= ?");
      params.push(Math.trunc(Number(fromTs)));
    }
    if (toTs != null) {
      clauses.push("bucket_ts <= ?");
      params.push(Math.trunc(Number(toTs)));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this._all(
      `SELECT app_key,
              SUM(bytes_in) AS bytes_in,
              SUM(bytes_out) AS bytes_out,
              SUM(bytes_in + bytes_out) AS bytes_total
       FROM ${table} ${where}
       GROUP BY app_key
       ORDER BY bytes_total DESC`,
      params
    );
  }

  pruneUsage({ hourlyDays = 14, dailyDays = 90 } = {}) {
    const nowSec = Math.floor(Date.now() / 1000);
    const hDays = Math.max(1, Math.trunc(Number(hourlyDays)) || 14);
    const dDays = Math.max(1, Math.trunc(Number(dailyDays)) || 90);
    const hourCutoff = nowSec - hDays * 86400;
    const dayCutoff = nowSec - dDays * 86400;
    this._run("DELETE FROM usage_hourly WHERE bucket_ts < ?", [hourCutoff]);
    this._run("DELETE FROM usage_daily WHERE bucket_ts < ?", [dayCutoff]);
    this._persistImmediate();
  }

  clearUsageHistory() {
    this._run("DELETE FROM usage_hourly");
    this._run("DELETE FROM usage_daily");
    this._run("DELETE FROM usage_apps");
    this._run("DELETE FROM usage_alert_state");
    this._persistImmediate();
  }

  getAlertLastFired(rule_key) {
    const key = String(rule_key || "").trim();
    if (!key) return null;
    const row = this._get(
      "SELECT last_fired_at FROM usage_alert_state WHERE rule_key=?",
      [key]
    );
    return row && row.last_fired_at != null ? row.last_fired_at : null;
  }

  setAlertLastFired(rule_key, atSec) {
    const key = String(rule_key || "").trim();
    if (!key) return;
    const ts = Number(atSec);
    if (!Number.isFinite(ts)) return;
    this._run(
      `INSERT INTO usage_alert_state (rule_key, last_fired_at) VALUES (?, ?)
       ON CONFLICT(rule_key) DO UPDATE SET last_fired_at=excluded.last_fired_at`,
      [key, ts]
    );
    this._persist();
  }

  summary(now = null, { observeSince = null } = {}) {
    const tNow = now != null ? now : Date.now() / 1000;
    const windows = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };

    const downtimeInWindow = (seconds, otype = null) => {
      const start = tNow - seconds;
      const outages = this.listOutages({
        fromTs: start,
        toTs: tNow,
        outageType: otype,
        limit: 10000,
      });
      let totalMs = 0;
      for (const o of outages) {
        const oStart = Math.max(o.started_at, start);
        let oEnd = o.ended_at != null ? o.ended_at : tNow;
        oEnd = Math.min(oEnd, tNow);
        if (oEnd > oStart) totalMs += Math.floor((oEnd - oStart) * 1000);
      }
      const windowMs = seconds * 1000;
      const pct = windowMs ? (totalMs / windowMs) * 100.0 : 0.0;
      return {
        downtime_ms: totalMs,
        downtime_pct: Math.round(pct * 1000) / 1000,
        count: outages.length,
      };
    };

    const lastClosed = this._get(
      `SELECT ended_at FROM outages WHERE ended_at IS NOT NULL
       ORDER BY ended_at DESC LIMIT 1`
    );
    const openAny = this._get(
      `SELECT started_at FROM outages WHERE ended_at IS NULL
       ORDER BY started_at ASC LIMIT 1`
    );
    const firstProbe = this._get("SELECT MIN(timestamp) AS t FROM probes");

    // Cap streak to the observation clock (MIN first probe / first outage).
    // Session `started_at` is not history — callers must not pass process start.
    const observeStart =
      observeSince != null
        ? observeSince
        : firstProbe && firstProbe.t != null
          ? firstProbe.t
          : null;

    let uptimeStreakS = 0.0;
    let inOutage = false;
    if (openAny) {
      uptimeStreakS = 0.0;
      inOutage = true;
    } else if (lastClosed && lastClosed.ended_at != null) {
      const baseline =
        observeStart != null
          ? Math.max(lastClosed.ended_at, observeStart)
          : lastClosed.ended_at;
      uptimeStreakS = Math.max(0, tNow - baseline);
      inOutage = false;
    } else if (observeStart != null) {
      uptimeStreakS = Math.max(0, tNow - observeStart);
      inOutage = false;
    }

    const monthStart = tNow - 30 * 86400;
    const recent = this.listOutages({
      fromTs: monthStart,
      toTs: tNow,
      limit: 10000,
    });
    const byHour = Array(24).fill(0);
    const byDow = Array(7).fill(0);
    for (const o of recent) {
      const d = new Date(o.started_at * 1000);
      byHour[d.getHours()] += 1;
      const js = d.getDay();
      byDow[js === 0 ? 6 : js - 1] += 1;
    }

    const longest = this.listOutages({
      fromTs: monthStart,
      toTs: tNow,
      limit: 10,
      orderBy: "duration",
      orderDir: "DESC",
    });
    for (const o of longest) {
      if (o.duration_ms == null) {
        o.duration_ms = Math.floor((tNow - o.started_at) * 1000);
      }
    }

    const sparkStart = tNow - 86400;
    const spark = Array(24).fill(0);
    const dayOutages = this.listOutages({
      fromTs: sparkStart,
      toTs: tNow,
      limit: 10000,
    });
    for (const o of dayOutages) {
      const oStart = Math.max(o.started_at, sparkStart);
      const oEnd = Math.min(o.ended_at != null ? o.ended_at : tNow, tNow);
      let t = oStart;
      while (t < oEnd) {
        let hourIdx = Math.floor((t - sparkStart) / 3600);
        hourIdx = Math.max(0, Math.min(23, hourIdx));
        const bucketEnd = sparkStart + (hourIdx + 1) * 3600;
        const segEnd = Math.min(oEnd, bucketEnd);
        spark[hourIdx] += segEnd - t;
        t = segEnd;
      }
    }

    const recentOutages = this.listOutages({
      fromTs: monthStart,
      toTs: tNow,
      limit: 8,
      orderBy: "started_at",
      orderDir: "DESC",
    });

    // Latency sparkline: downsample recent probe latencies (last 6h)
    const latStart = tNow - 6 * 3600;
    const probes = this.probesSince(latStart).filter(
      (p) => p.latency_ms != null && Number(p.lan_ok) === 1
    );
    const buckets = 48;
    const latencySpark = Array(buckets).fill(null);
    if (probes.length) {
      const span = 6 * 3600;
      const sums = Array(buckets).fill(0);
      const counts = Array(buckets).fill(0);
      for (const p of probes) {
        let idx = Math.floor(((p.timestamp - latStart) / span) * buckets);
        idx = Math.max(0, Math.min(buckets - 1, idx));
        sums[idx] += p.latency_ms;
        counts[idx] += 1;
      }
      for (let i = 0; i < buckets; i++) {
        if (counts[i]) latencySpark[i] = Math.round((sums[i] / counts[i]) * 10) / 10;
      }
    }

    const latestSpeed = this.latestSpeedTest();
    const timelineStart = tNow - 86400;
    const timeline = this.listOutages({
      fromTs: timelineStart,
      toTs: tNow,
      limit: 10000,
      orderBy: "started_at",
      orderDir: "ASC",
    }).map((o) => ({
      id: o.id,
      type: o.type,
      started_at: o.started_at,
      ended_at: o.ended_at,
    }));

    const result = {
      uptime_streak_s: Math.round(uptimeStreakS * 10) / 10,
      in_outage: inOutage,
      windows: {},
      by_hour: byHour,
      by_dow: byDow,
      longest,
      recent_outages: recentOutages,
      sparkline_24h: spark.map((s) => Math.round(s * 10) / 10),
      latency_spark_6h: latencySpark,
      timeline_24h: timeline,
      provider: latestSpeed
        ? {
            isp: latestSpeed.isp || null,
            server_name: latestSpeed.server_name || null,
            server_location: latestSpeed.server_location || null,
            ping_ms: latestSpeed.ping_ms != null ? latestSpeed.ping_ms : null,
            tested_at: latestSpeed.tested_at,
            download_mbps:
              latestSpeed.download_mbps != null ? latestSpeed.download_mbps : null,
            upload_mbps: latestSpeed.upload_mbps != null ? latestSpeed.upload_mbps : null,
          }
        : null,
    };
    for (const [name, secs] of Object.entries(windows)) {
      result.windows[name] = {
        all: downtimeInWindow(secs),
        lan: downtimeInWindow(secs, "lan"),
        wan: downtimeInWindow(secs, "wan"),
        dns: downtimeInWindow(secs, "dns"),
        http: downtimeInWindow(secs, "http"),
      };
    }
    return result;
  }

  upsertLanDevice(row) {
    const mac = String(row.mac || "").toUpperCase();
    if (!mac) return null;
    const numOrNull = (v) => {
      if (v == null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    this._run(
      `INSERT INTO lan_devices (mac, ip, vendor, alias, notes, hostname, state, iface, first_seen, last_seen, online, source, gateway,
         wifi_rssi, wifi_signal_pct, wifi_band, wifi_tx_mbps, wifi_rx_mbps, wifi_node_mac, wifi_ssid, last_wifi_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mac) DO UPDATE SET
         ip=excluded.ip,
         vendor=COALESCE(excluded.vendor, lan_devices.vendor),
         alias=COALESCE(excluded.alias, lan_devices.alias),
         notes=COALESCE(excluded.notes, lan_devices.notes),
         hostname=COALESCE(excluded.hostname, lan_devices.hostname),
         state=COALESCE(excluded.state, lan_devices.state),
         iface=COALESCE(excluded.iface, lan_devices.iface),
         last_seen=excluded.last_seen,
         online=excluded.online,
         source=excluded.source,
         gateway=excluded.gateway,
         wifi_rssi=COALESCE(excluded.wifi_rssi, lan_devices.wifi_rssi),
         wifi_signal_pct=COALESCE(excluded.wifi_signal_pct, lan_devices.wifi_signal_pct),
         wifi_band=COALESCE(excluded.wifi_band, lan_devices.wifi_band),
         wifi_tx_mbps=COALESCE(excluded.wifi_tx_mbps, lan_devices.wifi_tx_mbps),
         wifi_rx_mbps=COALESCE(excluded.wifi_rx_mbps, lan_devices.wifi_rx_mbps),
         wifi_node_mac=COALESCE(excluded.wifi_node_mac, lan_devices.wifi_node_mac),
         wifi_ssid=COALESCE(excluded.wifi_ssid, lan_devices.wifi_ssid),
         last_wifi_at=COALESCE(excluded.last_wifi_at, lan_devices.last_wifi_at)`,
      [
        mac,
        row.ip != null ? String(row.ip).slice(0, 64) : null,
        row.vendor != null ? String(row.vendor).slice(0, 120) : null,
        row.alias != null ? String(row.alias).slice(0, 120) : null,
        row.notes != null ? String(row.notes).slice(0, 500) : null,
        row.hostname != null ? String(row.hostname).slice(0, 120) : null,
        row.state != null ? String(row.state).slice(0, 32) : null,
        row.iface != null ? String(row.iface).slice(0, 64) : null,
        row.first_seen != null ? Number(row.first_seen) : Date.now() / 1000,
        row.last_seen != null ? Number(row.last_seen) : Date.now() / 1000,
        row.online ? 1 : 0,
        row.source != null ? String(row.source).slice(0, 32) : "neighbor",
        row.gateway ? 1 : 0,
        numOrNull(row.wifi_rssi),
        numOrNull(row.wifi_signal_pct),
        row.wifi_band != null ? String(row.wifi_band).slice(0, 32) : null,
        numOrNull(row.wifi_tx_mbps),
        numOrNull(row.wifi_rx_mbps),
        row.wifi_node_mac != null ? String(row.wifi_node_mac).toUpperCase().slice(0, 32) : null,
        row.wifi_ssid != null ? String(row.wifi_ssid).slice(0, 64) : null,
        numOrNull(row.last_wifi_at),
      ]
    );
    return this.getLanDevice(mac);
  }

  getLanDevice(mac) {
    return this._get("SELECT * FROM lan_devices WHERE mac = ?", [String(mac || "").toUpperCase()]);
  }

  listLanDevices() {
    return this._all(
      "SELECT * FROM lan_devices ORDER BY gateway DESC, online DESC, last_seen DESC LIMIT 500"
    );
  }

  updateLanDeviceMeta(mac, { alias, notes } = {}) {
    const row = this.getLanDevice(mac);
    if (!row) return null;
    const nextAlias = alias !== undefined ? String(alias || "").slice(0, 120) : row.alias;
    const nextNotes = notes !== undefined ? String(notes || "").slice(0, 500) : row.notes;
    this._run("UPDATE lan_devices SET alias = ?, notes = ? WHERE mac = ?", [
      nextAlias,
      nextNotes,
      String(mac).toUpperCase(),
    ]);
    return this.getLanDevice(mac);
  }

  markLanDevicesOffline(beforeTs) {
    this._run("UPDATE lan_devices SET online = 0 WHERE last_seen < ? AND online = 1", [
      Number(beforeTs) || 0,
    ]);
  }

  insertLanScanResult(row) {
    this._run(
      `INSERT INTO lan_scan_results (target_ip, started_at, finished_at, ports_json, cve_json, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        String(row.target_ip || "").slice(0, 64),
        Number(row.started_at) || Date.now() / 1000,
        row.finished_at != null ? Number(row.finished_at) : null,
        row.ports_json != null ? String(row.ports_json).slice(0, 20000) : null,
        row.cve_json != null ? String(row.cve_json).slice(0, 20000) : null,
        row.status != null ? String(row.status).slice(0, 32) : "done",
      ]
    );
    return this._get("SELECT * FROM lan_scan_results ORDER BY id DESC LIMIT 1");
  }

  listLanScanResults({ limit = 20 } = {}) {
    const lim = Math.min(100, Math.max(1, Number(limit) || 20));
    return this._all(
      `SELECT * FROM lan_scan_results ORDER BY started_at DESC LIMIT ${lim}`
    );
  }

  getLatestScanForIp(ip) {
    const target = String(ip || "").trim().slice(0, 64);
    if (!target) return null;
    return this._get(
      "SELECT * FROM lan_scan_results WHERE target_ip = ? ORDER BY started_at DESC LIMIT 1",
      [target]
    );
  }

  insertWifiEvent(row = {}) {
    const kind = String(row.kind || "").trim();
    if (!kind) return null;
    const numOrNull = (v) => {
      if (v == null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const at = numOrNull(row.at) != null ? numOrNull(row.at) : Date.now() / 1000;
    const source = row.source != null && String(row.source).trim() !== "" ? String(row.source).slice(0, 32) : null;
    const eventId = numOrNull(row.event_id) != null ? Math.trunc(numOrNull(row.event_id)) : null;
    const dup = this._get(
      `SELECT id FROM wifi_events
       WHERE kind = ? AND source IS ? AND event_id IS ?
         AND at >= ? AND at <= ?
       LIMIT 1`,
      [kind, source, eventId, at - 1, at + 1]
    );
    if (dup) return null;
    this._run(
      `INSERT INTO wifi_events (at, kind, ssid, bssid_from, bssid_to, reason_code, reason_text, event_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        at,
        kind.slice(0, 32),
        row.ssid != null ? String(row.ssid).slice(0, 64) : null,
        row.bssid_from != null ? String(row.bssid_from).toUpperCase().slice(0, 32) : null,
        row.bssid_to != null ? String(row.bssid_to).toUpperCase().slice(0, 32) : null,
        row.reason_code != null ? String(row.reason_code).slice(0, 64) : null,
        row.reason_text != null ? String(row.reason_text).slice(0, 800) : null,
        eventId,
        source,
      ]
    );
    this._persist();
    return this._get("SELECT * FROM wifi_events ORDER BY id DESC LIMIT 1");
  }

  listWifiEvents({ fromTs = null, toTs = null, limit = 500 } = {}) {
    const clauses = [];
    const params = [];
    if (fromTs != null) {
      clauses.push("at >= ?");
      params.push(Number(fromTs));
    }
    if (toTs != null) {
      clauses.push("at <= ?");
      params.push(Number(toTs));
    }
    const lim = Math.max(1, Math.min(5000, Math.trunc(Number(limit)) || 500));
    params.push(lim);
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this._all(
      `SELECT * FROM wifi_events${where} ORDER BY at ASC LIMIT ?`,
      params
    );
  }

  insertWifiSample(row) {
    const mac = String(row.mac || "").toUpperCase();
    if (!mac) return null;
    const numOrNull = (v) => {
      if (v == null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const at = numOrNull(row.at) != null ? numOrNull(row.at) : Date.now() / 1000;
    this._run(
      `INSERT INTO wifi_samples (mac, source, at, rssi, signal_pct, band, ssid, bssid, channel, tx_mbps, rx_mbps, node_mac)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mac,
        row.source != null ? String(row.source).slice(0, 32) : null,
        at,
        numOrNull(row.rssi),
        numOrNull(row.signal_pct),
        row.band != null ? String(row.band).slice(0, 32) : null,
        row.ssid != null ? String(row.ssid).slice(0, 64) : null,
        row.bssid != null ? String(row.bssid).toUpperCase().slice(0, 32) : null,
        numOrNull(row.channel) != null ? Math.trunc(numOrNull(row.channel)) : null,
        numOrNull(row.tx_mbps),
        numOrNull(row.rx_mbps),
        row.node_mac != null ? String(row.node_mac).toUpperCase().slice(0, 32) : null,
      ]
    );
    this._persist();
  }

  listWifiHistory({ mac, fromTs = null, toTs = null, limit = 5000 } = {}) {
    const m = String(mac || "").toUpperCase();
    if (!m) return [];
    const clauses = ["mac = ?"];
    const params = [m];
    if (fromTs != null) {
      clauses.push("at >= ?");
      params.push(Number(fromTs));
    }
    if (toTs != null) {
      clauses.push("at <= ?");
      params.push(Number(toTs));
    }
    const lim = Math.max(1, Math.min(10000, Math.trunc(Number(limit)) || 5000));
    params.push(lim);
    return this._all(
      `SELECT * FROM wifi_samples WHERE ${clauses.join(" AND ")} ORDER BY at ASC LIMIT ?`,
      params
    );
  }

  insertRouterHealthSample(row) {
    const numOrNull = (v) => {
      if (v == null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const at = numOrNull(row.at) != null ? numOrNull(row.at) : Date.now() / 1000;
    this._run(
      `INSERT INTO router_health_samples (at, cpu_pct, mem_used, mem_total, wan_ok, wan_ip, model, firmware, vendor, extra_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        at,
        numOrNull(row.cpu_pct),
        numOrNull(row.mem_used),
        numOrNull(row.mem_total),
        row.wan_ok == null ? null : row.wan_ok ? 1 : 0,
        row.wan_ip != null ? String(row.wan_ip).slice(0, 64) : null,
        row.model != null ? String(row.model).slice(0, 120) : null,
        row.firmware != null ? String(row.firmware).slice(0, 120) : null,
        row.vendor != null ? String(row.vendor).slice(0, 32) : null,
        row.extra_json != null ? String(row.extra_json).slice(0, 8000) : null,
      ]
    );
    this._persist();
  }

  getLatestRouterHealth() {
    return this._get(
      "SELECT * FROM router_health_samples ORDER BY at DESC LIMIT 1"
    );
  }

  insertRouterAction(row = {}) {
    const action = String(row.action || "").trim().slice(0, 64);
    if (!action) return null;
    const numOrNull = (v) => {
      if (v == null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const at = numOrNull(row.at) != null ? numOrNull(row.at) : Date.now() / 1000;
    let err = row.error == null || row.error === "" ? null : String(row.error).slice(0, 500);
    if (err) {
      err = err.replace(/(password|api[_-]?key|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]");
    }
    this._run(
      `INSERT INTO router_actions (at, target_id, action, mac, ok, error)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        at,
        row.target_id != null ? String(row.target_id).slice(0, 64) : null,
        action,
        row.mac != null && String(row.mac).trim() !== "" ? String(row.mac).slice(0, 32) : null,
        row.ok ? 1 : 0,
        err,
      ]
    );
    this._persist();
    return this._get("SELECT * FROM router_actions ORDER BY id DESC LIMIT 1");
  }

  listRouterActions({ limit = 50 } = {}) {
    const lim = Math.min(500, Math.max(1, Math.trunc(Number(limit)) || 50));
    return this._all(`SELECT * FROM router_actions ORDER BY at DESC LIMIT ${lim}`);
  }
}

module.exports = {
  APP_DIR_NAME,
  DEFAULT_SETTINGS,
  SETTINGS_BOUNDS,
  OUTAGE_TYPES,
  LIST_OUTAGES_LIMIT_MAX,
  BOOL_SETTINGS,
  JSON_SETTINGS,
  STRING_SETTINGS_MAX,
  SECRET_SETTINGS,
  ROUTER_TARGETS_CAP,
  parseRouterTargetsJson,
  parseRouterSecretsJson,
  parseWifiAlertsJson,
  resolveRouterTargets,
  normalizeSettingValue,
  normalizeSettingsObject,
  encodeSnapshotJson,
  coerceBoolSetting,
  dataDir,
  dbPath,
  TrackerDb,
  rowsFromExec,
};
