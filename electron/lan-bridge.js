"use strict";

/**
 * Orchestrates LAN Devices phases A–H outside monitor._tick.
 */

const fs = require("fs");
const path = require("path");
let Notification = null;
try {
  ({ Notification } = require("electron"));
} catch {
  Notification = null;
}

const lanDevices = require("./lan-devices");
const snmpTopology = require("./snmp-topology");
const packetSniffer = require("./packet-sniffer");
const portScan = require("./port-scan");
const notify = require("./notify-webhooks");
const wol = require("./wol");
const metricsApi = require("./metrics-api");
const subnetDiscovery = require("./subnet-discovery");
const routerWebhooks = require("./router-webhooks");
const connections = require("./connections");
const netcheck = require("./netcheck");
const { createAdapter, wifiSampleSource, vendorWriteSupport } = require("./router-adapter");
const chanimSsh = require("./chanim-ssh");
const { resolveRouterTargets, parseWifiAlertsJson } = require("./db");
const { formatMac } = require("./oui");
const { lanDevicesToCsv, lanDevicesToJson } = require("./export");
const { pickOverviewWifi } = require("./overview-wifi");

/** @type {import("./db").TrackerDb | null} */
let db = null;
/** @type {import("./monitor").Monitor | null} */
let monitor = null;
let metricsTimer = null;
let onRecentEvent = null;
let routerPollTimer = null;
let routerPollInFlight = false;
/** @type {string | null} */
let lastPollError = null;
/** @type {object[]} */
let lastPollTargets = [];
/** @type {object | null} */
let lastHostAdapter = null;
/** @type {object[]} */
let lastPollWifiClients = [];
/** @type {string | null} */
let lastPollWifiSource = null;
/** @type {object | null} */
let lastPollExtra = null;
/** @type {Map<string, object>} */
let lastWifiByMac = new Map();
/** @type {object[]} */
let lastWifiMetrics = [];
/** @type {Map<string, number>} */
let wifiAlertStreaks = new Map();
/** @type {Map<string, number>} */
let wifiAlertFiredAt = new Map();
/** @type {Set<string>} */
let wifiAlertingMacs = new Set();
const WIFI_ALERT_COOLDOWN_S = 900;
const WIFI_PROM_MAX = 50;
let routerPollHooks = {
  createAdapter: null,
  getActiveAdapter: null,
  getDefaultGateway: null,
};

function init(deps) {
  db = deps.db;
  monitor = deps.monitor || null;
  onRecentEvent = typeof deps.onRecentEvent === "function" ? deps.onRecentEvent : null;
  lanDevices.setSettingsGetter(() => settings());
  packetSniffer.setFetchFlowsForTest(async () => {
    const snap = await connections.snapshot({
      establishedOnly: true,
      trackDelta: false,
      trackAdapters: false,
    });
    const flows = (snap.connections || []).map((c) => ({
      proto: c.proto,
      local: c.local,
      remote: c.remote,
      pid: c.pid,
      process: c.process,
    }));
    return { flows };
  });
  metricsApi.setMetricsProvider(() => {
    if (!db) {
      return {
        devices_online: 0,
        outages_open: 0,
        outages_total: 0,
        router_targets: [],
        wifi: [],
      };
    }
    const devices = db.listLanDevices();
    const open = db.listOutages({ limit: 50 }).filter((o) => o.ended_at == null);
    return {
      devices_online: devices.filter((d) => d.online).length,
      outages_open: open.length,
      outages_total: db.listOutages({ limit: 500 }).length,
      router_targets: lastPollTargets.map((t) => ({
        vendor: t.vendor || "",
        host: t.host || "",
        cpu_pct: t.cpu_pct,
        mem_used: t.mem_used,
        mem_total: t.mem_total,
        wan_ok: t.wan_ok,
        chanim: t.chanim,
      })),
      wifi: lastWifiMetrics.slice(0, WIFI_PROM_MAX),
    };
  });
  metricsApi.setApiProvider(() => {
    if (!db) return { devices: [], status: {}, outages: [] };
    return {
      devices: db.listLanDevices(),
      status: monitor ? monitor.snapshot() : {},
      outages: db.listOutages({ limit: 50 }),
    };
  });
}

function settings() {
  return db ? db.getSettings() : {};
}

async function refreshDevices() {
  const s = settings();
  if (s.lan_devices_enabled === false) {
    return attachRouterPayload(lanDevices.devicesDisabledPayload());
  }
  const snap = await lanDevices.snapshot();
  const merged = lanDevices.mergeIntoDb(db, snap);
  const resolved = await lanDevices.resolveEmptyHostnames(merged.devices);
  for (const d of resolved.devices) {
    if (d.mac && d.hostname) {
      db.upsertLanDevice({
        mac: d.mac,
        ip: d.ip,
        vendor: d.vendor,
        alias: d.alias,
        notes: d.notes,
        hostname: d.hostname,
        state: d.state,
        iface: d.iface,
        first_seen: d.first_seen,
        last_seen: d.last_seen,
        online: d.online,
        source: d.source,
        gateway: d.gateway,
      });
    }
  }
  if (s.lan_new_device_toast && merged.newDevices.length) {
    for (const d of merged.newDevices.slice(0, 3)) {
      try {
        const detail = `${d.ip || "?"} (${d.mac})${d.vendor ? " — " + d.vendor : ""}`;
        if (Notification && Notification.isSupported()) {
          new Notification({
            title: "New LAN device",
            body: detail,
          }).show();
        }
        if (onRecentEvent) {
          try {
            onRecentEvent({ kind: "lan", title: "New LAN device", detail });
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
      if (s.router_webhook_auto_new && s.router_webhook_url) {
        routerWebhooks
          .notifyRouter({
            url: s.router_webhook_url,
            template: s.router_webhook_template,
            device: d,
            event: "new_device",
          })
          .catch(() => {});
      }
      notify
        .notify({
          urls: s.notify_webhooks_json,
          quietHours: s.notify_quiet_hours_json,
          settings: s,
          event: "new_device",
          title: "New LAN device",
          body: { mac: d.mac, ip: d.ip, vendor: d.vendor },
        })
        .catch(() => {});
    }
  }
  const devices = lanDevices.enrichListedDevices(
    db.listLanDevices(),
    (ip) => db.getLatestScanForIp(ip)
  );
  return attachRouterPayload({
    ok: true,
    gateway: merged.gateway,
    devices,
    new_count: merged.newDevices.length,
    disclaimer: lanDevices.devicesDisclaimer({
      hostnamesQueried: lanDevices.hadActiveHostnameLookups(),
    }),
    lan_devices_enabled: true,
    meta: {
      lan_devices_enabled: true,
      warning: null,
      hostname_lookups: resolved.lookups,
    },
  });
}

function listDevices() {
  const s = settings();
  if (s.lan_devices_enabled === false) {
    return attachRouterPayload(lanDevices.devicesDisabledPayload());
  }
  const raw = db ? db.listLanDevices() : [];
  const devices = lanDevices.enrichListedDevices(raw, (ip) =>
    db ? db.getLatestScanForIp(ip) : null
  );
  return attachRouterPayload({
    ok: true,
    devices,
    lan_devices_enabled: true,
    disclaimer: lanDevices.devicesDisclaimer({
      hostnamesQueried: lanDevices.hadActiveHostnameLookups(),
    }),
    meta: { lan_devices_enabled: true, warning: null },
  });
}

function updateDevice(body = {}) {
  const row = db.updateLanDeviceMeta(body.mac, { alias: body.alias, notes: body.notes });
  return { ok: !!row, device: row };
}

async function exportDevices(format, destDir) {
  const devices = db.listLanDevices();
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "json") {
    const dest = path.join(destDir, `idt-lan-devices-${stamp}.json`);
    fs.writeFileSync(dest, lanDevicesToJson(devices), "utf8");
    return { path: dest, count: devices.length, format: "json" };
  }
  const dest = path.join(destDir, `idt-lan-devices-${stamp}.csv`);
  fs.writeFileSync(dest, lanDevicesToCsv(devices), "utf8");
  return { path: dest, count: devices.length, format: "csv" };
}

async function wakeDevice(body = {}) {
  const mac = body.mac;
  const row = db.getLanDevice(mac);
  if (!row) return { ok: false, error: "Unknown device MAC" };
  return wol.wake({ mac: row.mac });
}

/** Inventory map when SNMP is off — Topology still works after Devices refresh. */
function neighborTopologyFromDevices(devices) {
  return lanDevices.neighborTopologyFromDevices(devices);
}

async function topology() {
  const s = settings();
  const devices = db ? db.listLanDevices() : [];
  let result;
  if (!s.snmp_enabled) {
    result = neighborTopologyFromDevices(devices);
  } else {
    const seeds = [];
    if (s.snmp_targets) {
      for (const part of String(s.snmp_targets).split(/[,\s]+/)) {
        if (part) seeds.push(part);
      }
    }
    for (const d of devices) {
      if (d.ip) seeds.push(d.ip);
    }
    if (!seeds.length && devices.length) {
      const fallback = neighborTopologyFromDevices(devices);
      result = { ...fallback, warning: "No SNMP seeds yet — showing Devices inventory radial map." };
    } else {
      result = await snmpTopology.discoverTopology({
        seeds,
        community: s.snmp_community || "public",
      });
      result = lanDevices.enrichTopologyWithDevices(result, devices);
    }
  }

  // Cheap live Connections cross-ref (best-effort; never blocks Topology).
  if (s.connections_enabled !== false) {
    try {
      const snap = await connections.snapshot({
        establishedOnly: true,
        trackDelta: false,
        trackAdapters: false,
      });
      if (snap && snap.ok !== false && Array.isArray(snap.connections)) {
        result = lanDevices.attachConnectionCounts(result, snap.connections);
      }
    } catch {
      /* ignore */
    }
  }
  return result;
}

function stopTopology() {
  snmpTopology.stop();
  return { ok: true };
}

function snifferStatus() {
  return packetSniffer.status();
}

function snifferStart(opts = {}) {
  const s = settings();
  if (!s.sniffer_enabled) {
    return { ok: false, error: "Sniffer disabled in Settings" };
  }
  return packetSniffer.start({ always: !!(opts.always || s.sniffer_always_on) });
}

function snifferStop(opts = {}) {
  return packetSniffer.stop({ force: !!opts.force });
}

function snifferEvents(params) {
  return { ok: true, events: packetSniffer.events(params || {}), ...packetSniffer.status() };
}

async function scanDevice(body = {}) {
  const host = String(body.host || body.ip || "").trim();
  const known = db.listLanDevices().some((d) => d.ip === host);
  if (!portScan.isPrivateOrLocalIp(host)) {
    return { ok: false, error: "Target must be private/local IP" };
  }
  if (body.requireKnown !== false && !known) {
    return { ok: false, error: "Target IP must be a known Devices inventory host" };
  }
  const started = Date.now() / 1000;
  if (monitor) monitor.setProbeSuppress(true);
  try {
    const result = await portScan.scanHost({ host });
    db.insertLanScanResult({
      target_ip: host,
      started_at: started,
      finished_at: Date.now() / 1000,
      ports_json: JSON.stringify(result.ports || []),
      cve_json: JSON.stringify(result.cves || []),
      status: result.ok ? "done" : "error",
    });
    const s = settings();
    notify
      .notify({
        urls: s.notify_webhooks_json,
        quietHours: s.notify_quiet_hours_json,
        settings: s,
        event: "scan_complete",
        title: `Port scan ${host}`,
        body: { host, open_ports: result.open_ports, cve_count: (result.cves || []).length },
      })
      .catch(() => {});
    return result;
  } finally {
    if (monitor) monitor.setProbeSuppress(false, { cooldownMs: 5000 });
  }
}

async function runSubnetDiscovery() {
  const s = settings();
  if (!s.lan_active_discovery) {
    return { ok: false, error: "Active discovery disabled in Settings" };
  }
  const result = await subnetDiscovery.runDiscovery({
    setProbeSuppress: (on, opts) => {
      if (monitor) monitor.setProbeSuppress(on, opts);
    },
    onFound: (ip) => {
      db.upsertLanDevice({
        mac: syntheticMac(ip),
        ip,
        vendor: null,
        online: 1,
        source: "active_scan",
        last_seen: Date.now() / 1000,
        first_seen: Date.now() / 1000,
      });
    },
  });
  return result;
}

/** Locally-administered synthetic MAC for active-scan hits without ARP. */
function syntheticMac(ip) {
  const n = String(ip)
    .split(".")
    .map((x) => Number(x) & 255);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return "02:00:00:00:00:00";
  return `02:00:${n.map((x) => x.toString(16).padStart(2, "0")).join(":")}`.toUpperCase();
}

async function notifyRouter(body = {}) {
  const s = settings();
  const row = body.mac ? db.getLanDevice(body.mac) : null;
  return routerWebhooks.notifyRouter({
    url: s.router_webhook_url,
    template: s.router_webhook_template,
    device: row || { mac: body.mac, ip: body.ip, alias: body.alias },
    event: body.event || "manual",
  });
}

function extraJson(v) {
  if (v == null || v === "") return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function pollIntervalMs(s) {
  const n = Number(s && s.router_interval_s);
  const sec = Number.isFinite(n) ? Math.min(300, Math.max(15, n)) : 30;
  return sec * 1000;
}

function adapterOptsFromTarget(target, secret, host) {
  const port =
    target && target.port != null && String(target.port).trim() !== "" ? target.port : undefined;
  return {
    host,
    user: (target && target.user) || "admin",
    password: (secret && secret.password) || "",
    https: !!(target && target.https),
    port,
    api_key: (secret && secret.api_key) || "",
  };
}

async function resolveTargetHost(target) {
  const explicit = String((target && target.host) || "").trim();
  if (explicit) return explicit;
  const gwFn = routerPollHooks.getDefaultGateway || netcheck.getDefaultGateway;
  try {
    const gw = await gwFn();
    return gw ? String(gw).trim() : "";
  } catch {
    return "";
  }
}

function pickAdapter(vendor) {
  const factory = routerPollHooks.createAdapter || createAdapter;
  return factory(vendor);
}

function routerHealthPayload() {
  const s = settings();
  if (lastPollTargets.length) {
    const primary =
      [...lastPollTargets].reverse().find((t) => !t.error) || lastPollTargets[lastPollTargets.length - 1];
    return {
      ...primary,
      vendor: primary.vendor,
      error: lastPollError,
      targets: lastPollTargets,
    };
  }
  const sample = db ? db.getLatestRouterHealth() : null;
  const vendor = (sample && sample.vendor) || (s && s.router_vendor) || null;
  if (!sample) return { vendor, error: lastPollError, targets: [] };
  return { ...sample, vendor, error: lastPollError, targets: [] };
}

function attachRouterPayload(payload) {
  const devices = Array.isArray(payload.devices)
    ? payload.devices.map((d) => {
        const mac = formatMac(d && d.mac);
        return { ...d, wifi_alerting: !!(mac && wifiAlertingMacs.has(mac)) };
      })
    : payload.devices;
  return {
    ...payload,
    devices,
    router_health: routerHealthPayload(),
    host_adapter: lastHostAdapter,
    router_writes: routerWritesPayload(),
  };
}

function routerWritesPayload() {
  const s = settings();
  const enabled = !!(s && s.router_writes_enabled);
  let targets = [];
  try {
    targets = resolveRouterTargets(s).targets || [];
  } catch {
    targets = [];
  }
  const rows = targets
    .filter((t) => t && t.enabled !== false)
    .map((t) => ({
      id: t.id,
      vendor: t.vendor,
      ...vendorWriteSupport(t.vendor),
    }));
  return {
    enabled,
    setClientBlocked: enabled && rows.some((r) => r.setClientBlocked),
    setGuestWifi: enabled && rows.some((r) => r.setGuestWifi),
    targets: rows,
  };
}

function canonicalBand(band) {
  const b = String(band || "").trim();
  if (b === "2.4" || b === "2" || b === "24" || b === "2g") return "2.4";
  if (b === "5" || b === "5g") return "5";
  if (b === "6" || b === "6g" || b === "6e") return "6";
  return null;
}

function confirmMatches(body, { action, mac, band, blocked }) {
  const raw = String(body && body.confirm != null ? body.confirm : "").trim();
  if (!raw) return false;
  if (action === "setClientBlocked") {
    const cMac = formatMac(raw);
    if (mac && cMac && cMac === mac) return true;
    const low = raw.toLowerCase();
    if (low === "block") return true;
    if (low === "allow" && blocked === false) return true;
    return false;
  }
  if (action === "setGuestWifi") return raw === band;
  return false;
}

function auditAction({ target_id, action, mac, ok, error }) {
  if (!db || typeof db.insertRouterAction !== "function") return;
  db.insertRouterAction({
    at: Date.now() / 1000,
    target_id: target_id || null,
    action,
    mac: mac || null,
    ok: !!ok,
    error: error || null,
  });
}

async function routerAction(body = {}) {
  const action = String(body.action || "").trim();
  const mac = formatMac(body.mac);
  const band = canonicalBand(body.band);
  const blocked = !!body.blocked;
  const enabled = !!body.enabled;
  const auditMac = action === "setGuestWifi" ? band : mac;
  const fail = (error, extra = {}) => {
    auditAction({
      target_id: extra.target_id || body.target_id || null,
      action: action || "unknown",
      mac: auditMac,
      ok: false,
      error,
    });
    return { ok: false, error, action: action || null, ...extra };
  };
  try {
    const s = settings();
    if (!s || !s.router_writes_enabled) return fail("router writes disabled");
    if (action !== "setClientBlocked" && action !== "setGuestWifi") {
      return fail("unknown action");
    }
    if (action === "setClientBlocked" && !mac) return fail("invalid mac");
    if (action === "setGuestWifi" && !band) return fail("invalid band");
    if (!confirmMatches(body, { action, mac, band, blocked })) {
      return fail("confirm required");
    }
    const { targets, secrets } = resolveRouterTargets(s);
    const wantId = body.target_id != null ? String(body.target_id).trim() : "";
    const method = action;
    let t = wantId ? (targets || []).find((x) => x.id === wantId) : null;
    if (!t) {
      t = (targets || []).find((x) => {
        if (x.enabled === false) return false;
        const caps = vendorWriteSupport(x.vendor);
        return caps[method];
      });
    }
    if (!t) return fail("unknown target");
    const adapterMod = pickAdapter(t.vendor);
    if (!adapterMod || typeof adapterMod[method] !== "function") {
      return fail("not supported", { target_id: t.id });
    }
    const host = await resolveTargetHost(t);
    if (!host || !portScan.isPrivateOrLocalIp(host)) {
      return fail(!host ? "no router host" : "host must be a private or local IP", { target_id: t.id });
    }
    const opts = {
      ...adapterOptsFromTarget(t, (secrets && secrets[t.id]) || {}, host),
      mac,
      blocked,
      band,
      enabled,
    };
    const res = await adapterMod[method](opts);
    const ok = !!(res && res.ok);
    const error = ok ? null : (res && res.error) || "action failed";
    auditAction({ target_id: t.id, action, mac: auditMac, ok, error });
    return {
      ok,
      error: error || undefined,
      action,
      target_id: t.id,
      mac: action === "setClientBlocked" ? mac : undefined,
      band: action === "setGuestWifi" ? band : undefined,
    };
  } catch (err) {
    return fail((err && err.message) || "action failed");
  }
}

function recordWifiMetric(mac, source, band, rssi, signal_pct, online) {
  if (!mac || online === false) return;
  if (String(band || "").toLowerCase() === "wired") return;
  const rssiN = rssi != null && rssi !== "" && Number.isFinite(Number(rssi)) ? Number(rssi) : null;
  const pctN =
    signal_pct != null && signal_pct !== "" && Number.isFinite(Number(signal_pct))
      ? Number(signal_pct)
      : null;
  lastWifiByMac.set(mac, {
    mac,
    source: source || "",
    band: band != null ? String(band) : "",
    rssi: rssiN,
    signal_pct: pctN,
  });
}

function sampleIsWeaker(sample, cfg) {
  if (!sample || !cfg) return false;
  if (sample.rssi != null && Number.isFinite(Number(sample.rssi)) && cfg.rssi_dbm != null) {
    return Number(sample.rssi) < cfg.rssi_dbm;
  }
  if (
    sample.signal_pct != null &&
    Number.isFinite(Number(sample.signal_pct)) &&
    cfg.signal_pct != null
  ) {
    return Number(sample.signal_pct) < cfg.signal_pct;
  }
  return false;
}

function evaluateWifiAlerts({
  cfg,
  samples,
  streaks,
  lastFired,
  nowSec,
  cooldownS = WIFI_ALERT_COOLDOWN_S,
} = {}) {
  const nextStreaks = new Map();
  const alerting = new Set();
  const fires = [];
  if (!cfg || !cfg.enabled) return { fires, streaks: nextStreaks, alerting };
  if (cfg.rssi_dbm == null && cfg.signal_pct == null) return { fires, streaks: nextStreaks, alerting };
  const n = Math.min(20, Math.max(1, Number(cfg.debounce_n) || 3));
  const allow = Array.isArray(cfg.macs) ? cfg.macs : [];
  const allowSet = new Set(allow.map((m) => formatMac(m)).filter(Boolean));
  const seen = new Set();
  for (const sample of samples || []) {
    const mac = formatMac(sample && sample.mac);
    if (!mac || seen.has(mac)) continue;
    seen.add(mac);
    if (allowSet.size && !allowSet.has(mac)) continue;
    const weaker = sampleIsWeaker(sample, cfg);
    const prev = (streaks && Number(streaks.get(mac))) || 0;
    const streak = weaker ? prev + 1 : 0;
    nextStreaks.set(mac, streak);
    if (streak < n) continue;
    alerting.add(mac);
    const last = lastFired ? Number(lastFired.get(mac) || 0) : 0;
    if (last && nowSec - last < cooldownS) continue;
    fires.push({
      mac,
      rssi: sample.rssi,
      signal_pct: sample.signal_pct,
      source: sample.source || null,
      streak,
    });
  }
  return { fires, streaks: nextStreaks, alerting };
}

async function checkWifiAlerts(nowSec) {
  const s = settings();
  const cfg = parseWifiAlertsJson(s.wifi_alerts_json);
  const result = evaluateWifiAlerts({
    cfg,
    samples: Array.from(lastWifiByMac.values()),
    streaks: wifiAlertStreaks,
    lastFired: wifiAlertFiredAt,
    nowSec,
  });
  wifiAlertStreaks = result.streaks;
  wifiAlertingMacs = result.alerting;
  const qh = notify.parseQuietHours(s.notify_quiet_hours_json);
  const quiet = notify.inQuietHours(qh);
  for (const fire of result.fires) {
    wifiAlertFiredAt.set(fire.mac, nowSec);
    const detail =
      `${fire.mac}` +
      (fire.rssi != null
        ? ` ${Math.round(Number(fire.rssi))} dBm`
        : fire.signal_pct != null
          ? ` ${Math.round(Number(fire.signal_pct))}%`
          : "");
    if (!quiet && s.toast_alerts && Notification && Notification.isSupported()) {
      try {
        new Notification({ title: "Weak Wi-Fi signal", body: detail }).show();
      } catch {
        /* ignore */
      }
    }
    if (onRecentEvent) {
      try {
        onRecentEvent({ kind: "lan", title: "Weak Wi-Fi signal", detail });
      } catch {
        /* ignore */
      }
    }
    try {
      await notify.notify({
        urls: s.notify_webhooks_json,
        quietHours: s.notify_quiet_hours_json,
        settings: s,
        event: "wifi_weak",
        title: "Weak Wi-Fi signal",
        body: {
          mac: fire.mac,
          rssi: fire.rssi,
          signal_pct: fire.signal_pct,
          source: fire.source,
          streak: fire.streak,
        },
      });
    } catch {
      /* ignore */
    }
  }
  return result;
}

function mergeRouterClients(clients, source, now) {
  if (!db || !Array.isArray(clients)) return;
  for (const c of clients) {
    const mac = formatMac(c && c.mac);
    if (!mac) continue;
    const prior = db.getLanDevice(mac);
    db.upsertLanDevice({
      mac,
      ip: (c && c.ip) || (prior && prior.ip) || null,
      hostname: (c && c.name) || (prior && prior.hostname) || null,
      online: c && c.online !== false,
      last_seen: now,
      source: (prior && prior.source) || source || "neighbor",
      gateway: prior && prior.gateway ? 1 : 0,
      wifi_rssi: c && c.rssi,
      wifi_signal_pct: c && c.signal_pct,
      wifi_band: c && c.band,
      wifi_tx_mbps: c && c.tx_mbps,
      wifi_rx_mbps: c && c.rx_mbps,
      wifi_node_mac: c && c.node_mac,
      wifi_ssid: c && c.ssid,
      last_wifi_at: now,
    });
    const wired = c && String(c.band || "").toLowerCase() === "wired";
    if (!wired) {
      lastPollWifiClients.push({
        mac,
        online: c && c.online !== false,
        wifi_ssid: c && c.ssid ? String(c.ssid).slice(0, 64) : null,
        wifi_rssi: c && c.rssi,
        wifi_signal_pct: c && c.signal_pct,
        wifi_band: c && c.band,
      });
    }
    if (wired) continue;
    if (!source) continue;
    recordWifiMetric(mac, source, c.band, c.rssi, c.signal_pct, c && c.online !== false);
    db.insertWifiSample({
      mac,
      source,
      at: now,
      rssi: c.rssi,
      signal_pct: c.signal_pct,
      band: c.band,
      ssid: c.ssid,
      tx_mbps: c.tx_mbps,
      rx_mbps: c.rx_mbps,
      node_mac: c.node_mac,
    });
  }
}

function insertHealth(health, vendor, now, target, host) {
  if (!db || !health) return;
  let extra = health.extra_json;
  if (typeof extra === "string") {
    try {
      extra = JSON.parse(extra);
    } catch {
      extra = {};
    }
  }
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) extra = {};
  extra = { ...extra, target_id: target && target.id, host: host || (target && target.host) || "" };
  lastPollExtra = extra;
  db.insertRouterHealthSample({
    at: now,
    cpu_pct: health.cpu_pct,
    mem_used: health.mem_used,
    mem_total: health.mem_total,
    wan_ok: health.wan_ok,
    wan_ip: health.wan_ip,
    model: health.model,
    firmware: health.firmware,
    vendor,
    extra_json: extraJson(extra),
  });
}

function cacheHostAdapter(adapter) {
  if (!adapter) {
    lastHostAdapter = null;
    return;
  }
  lastHostAdapter = {
    mac: adapter.mac || null,
    ssid: adapter.ssid || null,
    bssid: adapter.bssid || null,
    band: adapter.band || null,
    channel: adapter.channel != null ? adapter.channel : null,
    rssi: adapter.rssi != null ? adapter.rssi : null,
    signal: adapter.signal != null ? adapter.signal : null,
    tx_mbps: adapter.tx_mbps != null ? adapter.tx_mbps : null,
    rx_mbps: adapter.rx_mbps != null ? adapter.rx_mbps : null,
    type: adapter.type || null,
  };
}

async function persistHostNic(now) {
  const getAdapter = routerPollHooks.getActiveAdapter || netcheck.getActiveAdapter;
  let adapter;
  try {
    adapter = await getAdapter();
  } catch {
    adapter = null;
  }
  cacheHostAdapter(adapter);
  const mac = formatMac(adapter && adapter.mac);
  if (!mac || !db) return;
  const prior = db.getLanDevice(mac);
  db.upsertLanDevice({
    mac,
    ip: prior && prior.ip,
    hostname: prior && prior.hostname,
    online: true,
    last_seen: now,
    source: (prior && prior.source) || "host_nic",
    gateway: prior && prior.gateway ? 1 : 0,
    wifi_rssi: adapter.rssi,
    wifi_signal_pct: adapter.signal,
    wifi_band: adapter.band,
    wifi_tx_mbps: adapter.tx_mbps,
    wifi_rx_mbps: adapter.rx_mbps,
    wifi_ssid: adapter.ssid,
    last_wifi_at: now,
  });
  recordWifiMetric(mac, "host_nic", adapter.band, adapter.rssi, adapter.signal, true);
  db.insertWifiSample({
    mac,
    source: "host_nic",
    at: now,
    rssi: adapter.rssi,
    signal_pct: adapter.signal,
    band: adapter.band,
    ssid: adapter.ssid,
    bssid: adapter.bssid,
    channel: adapter.channel,
    tx_mbps: adapter.tx_mbps,
    rx_mbps: adapter.rx_mbps,
  });
}

async function pollOneTarget(target, secret, now) {
  const vendor = target.vendor;
  const source = wifiSampleSource(vendor);
  const row = { id: target.id, vendor, host: target.host || "", error: null };
  try {
    const host = await resolveTargetHost(target);
    row.host = host;
    if (!host || !portScan.isPrivateOrLocalIp(host)) {
      row.error = !host ? "no router host" : "host must be a private or local IP";
      return row;
    }
    const adapterMod = pickAdapter(vendor);
    if (!adapterMod) {
      row.error = "unknown vendor";
      return row;
    }
    const opts = adapterOptsFromTarget(target, secret, host);
    const [clientsRes, healthRes] = await Promise.all([
      Promise.resolve()
        .then(() => adapterMod.getClients(opts))
        .catch((err) => ({
          ok: false,
          error: (err && err.message) || "getClients failed",
          clients: [],
        })),
      Promise.resolve()
        .then(() => adapterMod.getRouterHealth(opts))
        .catch((err) => ({
          ok: false,
          error: (err && err.message) || "getRouterHealth failed",
        })),
    ]);
    const errors = [];
    if (!clientsRes || !clientsRes.ok) {
      errors.push((clientsRes && clientsRes.error) || "getClients failed");
    } else {
      lastPollWifiSource = source;
      mergeRouterClients(clientsRes.clients || [], source, now);
    }
    if (!healthRes || !healthRes.ok) {
      errors.push((healthRes && healthRes.error) || "getRouterHealth failed");
    } else {
      if (String(vendor).toLowerCase() === "asuswrt" && target && target.ssh_key_path) {
        try {
          const ch = await chanimSsh.collectChanim({
            vendor,
            host,
            user: target.user,
            ssh_user: target.ssh_user,
            ssh_key_path: target.ssh_key_path,
            ssh_ifaces: target.ssh_ifaces,
          });
          if (ch && ch.chanim && ch.chanim.length) {
            healthRes.extra_json = chanimSsh.mergeChanimExtra(healthRes.extra_json, ch.chanim);
            row.chanim = ch.chanim;
          }
        } catch {
          /* fail closed: health still stored */
        }
      }
      insertHealth(healthRes, vendor, now, target, host);
      lastPollWifiSource = source;
      row.cpu_pct = healthRes.cpu_pct;
      row.mem_used = healthRes.mem_used;
      row.mem_total = healthRes.mem_total;
      row.wan_ok = healthRes.wan_ok;
      row.wan_ip = healthRes.wan_ip;
      row.model = healthRes.model;
      row.firmware = healthRes.firmware;
    }
    row.error = errors[0] || null;
    return row;
  } catch (err) {
    row.error = (err && err.message) || "router poll failed";
    return row;
  }
}

async function pollRouterOnce() {
  if (!db) return { ok: false, error: "no db" };
  const s = settings();
  const { targets, secrets } = resolveRouterTargets(s);
  const enabled = targets.filter((t) => t.enabled !== false).slice(0, 4);
  const now = Date.now() / 1000;
  lastPollTargets = [];
  lastWifiByMac = new Map();
  lastPollWifiClients = [];
  const errors = [];
  try {
    for (const t of enabled) {
      const row = await pollOneTarget(t, secrets[t.id] || {}, now);
      lastPollTargets.push(row);
      if (row.error) errors.push(row.error);
    }
    lastPollError = errors[0] || null;
  } catch (err) {
    lastPollError = (err && err.message) || "router poll failed";
  }
  try {
    await persistHostNic(now);
  } catch {
    /* fail closed */
  }
  lastWifiMetrics = Array.from(lastWifiByMac.values())
    .filter((w) => w.rssi != null || w.signal_pct != null)
    .slice(0, WIFI_PROM_MAX);
  try {
    await checkWifiAlerts(now);
  } catch {
    /* fail closed */
  }
  return { ok: !lastPollError, error: lastPollError };
}

function stopRouterPoll() {
  if (routerPollTimer) {
    clearInterval(routerPollTimer);
    routerPollTimer = null;
  }
}

function startRouterPoll() {
  stopRouterPoll();
  const s = settings();
  if (!s.router_poll_enabled) return { ok: true, running: false };
  const ms = pollIntervalMs(s);
  const tick = () => {
    if (routerPollInFlight) return;
    routerPollInFlight = true;
    pollRouterOnce()
      .catch(() => {})
      .finally(() => {
        routerPollInFlight = false;
      });
  };
  tick();
  routerPollTimer = setInterval(tick, ms);
  if (routerPollTimer.unref) routerPollTimer.unref();
  return { ok: true, running: true, interval_ms: ms };
}

function syncRouterPoll(s) {
  if (s && s.router_poll_enabled) startRouterPoll();
  else {
    stopRouterPoll();
    lastPollWifiClients = [];
    lastPollWifiSource = null;
    lastPollExtra = null;
  }
}

function getHostAdapter() {
  return lastHostAdapter;
}

function overviewWifiPayload(adapter) {
  const s = settings();
  return pickOverviewWifi({
    adapter: adapter || null,
    devices: lastPollWifiClients,
    host_adapter: lastHostAdapter,
    pollEnabled: !!(s && s.router_poll_enabled),
    extra: lastPollExtra,
    source: lastPollWifiSource,
  });
}

function getRouterPollStatus() {
  return {
    running: !!routerPollTimer,
    in_flight: routerPollInFlight,
    error: lastPollError,
  };
}

async function testRouterConnection(targetId) {
  try {
    const s = settings();
    const { targets, secrets } = resolveRouterTargets(s);
    const id = targetId != null && String(targetId).trim() !== "" ? String(targetId).trim() : "";
    const t = id
      ? targets.find((x) => x.id === id)
      : targets.find((x) => x.enabled !== false) || targets[0];
    if (!t) return { ok: false, error: "unknown target" };
    const adapterMod = pickAdapter(t.vendor);
    if (!adapterMod) return { ok: false, error: "unknown vendor" };
    const host = await resolveTargetHost(t);
    if (!host || !portScan.isPrivateOrLocalIp(host)) {
      return { ok: false, error: !host ? "no router host" : "host must be a private or local IP" };
    }
    const res = await adapterMod.testConnection(adapterOptsFromTarget(t, secrets[t.id] || {}, host));
    return res && typeof res === "object" ? res : { ok: false, error: "test failed" };
  } catch (err) {
    return { ok: false, error: (err && err.message) || "test failed" };
  }
}

function listWifiHistory(body = {}) {
  try {
    if (!db) return [];
    return db.listWifiHistory({
      mac: body.mac,
      fromTs: body.fromTs,
      toTs: body.toTs,
      limit: body.limit,
    });
  } catch {
    return [];
  }
}

function getRouterHealth() {
  try {
    return routerHealthPayload();
  } catch {
    return { vendor: null, error: "unavailable" };
  }
}

function setRouterPollForTest(hooks = {}) {
  routerPollHooks = {
    createAdapter: hooks.createAdapter || null,
    getActiveAdapter: hooks.getActiveAdapter || null,
    getDefaultGateway: hooks.getDefaultGateway || null,
  };
}

function resetRouterPollForTest() {
  stopRouterPoll();
  routerPollInFlight = false;
  lastPollError = null;
  lastPollTargets = [];
  lastHostAdapter = null;
  lastPollWifiClients = [];
  lastPollWifiSource = null;
  lastPollExtra = null;
  lastWifiByMac = new Map();
  lastWifiMetrics = [];
  wifiAlertStreaks = new Map();
  wifiAlertFiredAt = new Map();
  wifiAlertingMacs = new Set();
  routerPollHooks = {
    createAdapter: null,
    getActiveAdapter: null,
    getDefaultGateway: null,
  };
}

async function applyIntegrationSettings(prev, next) {
  // Prometheus
  if (next.prom_metrics_enabled) {
    if (!metricsApi.status().prometheus) {
      try {
        await metricsApi.startPrometheus(9108);
      } catch (err) {
        console.error("prometheus start failed", err);
      }
    }
  } else {
    metricsApi.stopPrometheus();
  }
  // HTTP API
  if (next.http_api_enabled) {
    if (!next.http_api_token) {
      db.updateSettings({ http_api_enabled: false });
      next.http_api_enabled = false;
      metricsApi.stopHttpApi();
    } else {
      const tokenChanged =
        prev &&
        (String(prev.http_api_token || "") !== String(next.http_api_token || "") ||
          !prev.http_api_enabled);
      if (tokenChanged || !metricsApi.status().http_api) {
        metricsApi.stopHttpApi();
        try {
          await metricsApi.startHttpApi(9109, next.http_api_token);
        } catch (err) {
          console.error("http api start failed", err);
        }
      }
    }
  } else {
    metricsApi.stopHttpApi();
  }
  // Sniffer always-on
  if (next.sniffer_always_on && next.sniffer_enabled) {
    packetSniffer.setAlwaysOn(true);
  } else if (!next.sniffer_always_on) {
    packetSniffer.setAlwaysOn(false);
  }
  // Subnet discovery schedule
  if (next.lan_active_discovery) {
    subnetDiscovery.schedule(next.lan_discovery_interval_min || 15, {
      setProbeSuppress: (on, opts) => {
        if (monitor) monitor.setProbeSuppress(on, opts);
      },
      onFound: (ip) => {
        db.upsertLanDevice({
          mac: syntheticMac(ip),
          ip,
          online: 1,
          source: "active_scan",
          last_seen: Date.now() / 1000,
          first_seen: Date.now() / 1000,
        });
      },
    });
  } else {
    subnetDiscovery.stopSchedule();
  }
  // Quiet-hours digest flush when leaving quiet
  try {
    const qh = notify.parseQuietHours(next.notify_quiet_hours_json);
    if (!notify.inQuietHours(qh) && notify.pendingDigestCount()) {
      await notify.flushDigest({ urls: next.notify_webhooks_json, settings: next });
    }
  } catch {
    /* ignore */
  }
  // Periodic influx push
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
  if (next.influx_enabled || next.es_enabled) {
    metricsTimer = setInterval(() => {
      pushMetrics().catch(() => {});
    }, 60_000);
    if (metricsTimer.unref) metricsTimer.unref();
  }
  syncRouterPoll(next);
}

async function pushMetrics() {
  const s = settings();
  const m = metricsApi.status() && metricsApi;
  const fields = {
    devices_online: db.listLanDevices().filter((d) => d.online).length,
    outages_open: db.listOutages({ limit: 50 }).filter((o) => o.ended_at == null).length,
  };
  if (s.influx_enabled) await metricsApi.pushInflux(s, fields);
  if (s.es_enabled) {
    await metricsApi.pushElastic(s, [
      { _index: "idt-devices", body: { ts: Date.now() / 1000, ...fields } },
    ]);
  }
  return fields;
}

async function onOutageEvent(kind, outage) {
  const s = settings();
  const body = {
    type: outage && outage.type,
    id: outage && outage.id,
  };
  if (outage && outage.status_title != null) body.status_title = outage.status_title;
  if (outage && Object.prototype.hasOwnProperty.call(outage, "lan_ok")) {
    body.lan_ok = outage.lan_ok;
    body.wan_ok = outage.wan_ok;
    body.dns_ok = outage.dns_ok;
    body.http_ok = outage.http_ok;
  }
  if (outage && outage.latency_ms != null) body.latency_ms = outage.latency_ms;
  await notify.notify({
    urls: s.notify_webhooks_json,
    quietHours: s.notify_quiet_hours_json,
    settings: s,
    event: kind,
    title: `Outage ${kind}: ${outage && outage.type}`,
    body,
  });
}

function shutdown() {
  stopRouterPoll();
  snmpTopology.stop();
  packetSniffer.stop({ force: true });
  subnetDiscovery.stopSchedule();
  metricsApi.stopAll();
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
}

module.exports = {
  init,
  refreshDevices,
  listDevices,
  neighborTopologyFromDevices,
  updateDevice,
  exportDevices,
  wakeDevice,
  topology,
  stopTopology,
  snifferStatus,
  snifferStart,
  snifferStop,
  snifferEvents,
  scanDevice,
  runSubnetDiscovery,
  notifyRouter,
  applyIntegrationSettings,
  startRouterPoll,
  stopRouterPoll,
  pollRouterOnce,
  evaluateWifiAlerts,
  sampleIsWeaker,
  checkWifiAlerts,
  WIFI_ALERT_COOLDOWN_S,
  testRouterConnection,
  routerAction,
  listWifiHistory,
  getRouterHealth,
  getHostAdapter,
  overviewWifiPayload,
  pickOverviewWifi,
  getRouterPollStatus,
  setRouterPollForTest,
  resetRouterPollForTest,
  pushMetrics,
  onOutageEvent,
  shutdown,
  lanDevices,
  snmpTopology,
  packetSniffer,
  portScan,
  notify,
  wol,
  metricsApi,
  subnetDiscovery,
  routerWebhooks,
};
