"use strict";

/**
 * Orchestrates LAN Devices phases A–H outside monitor._tick.
 */

const fs = require("fs");
const path = require("path");
const { Notification } = require("electron");

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
const { lanDevicesToCsv, lanDevicesToJson } = require("./export");

/** @type {import("./db").TrackerDb | null} */
let db = null;
/** @type {import("./monitor").Monitor | null} */
let monitor = null;
let metricsTimer = null;

function init(deps) {
  db = deps.db;
  monitor = deps.monitor || null;
  packetSniffer.setFetchFlowsForTest(async () => {
    const snap = await connections.snapshot({ establishedOnly: true });
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
    if (!db) return { devices_online: 0, outages_open: 0, outages_total: 0 };
    const devices = db.listLanDevices();
    const open = db.listOutages({ limit: 50 }).filter((o) => o.ended_at == null);
    return {
      devices_online: devices.filter((d) => d.online).length,
      outages_open: open.length,
      outages_total: db.listOutages({ limit: 500 }).length,
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
    return { ok: false, devices: [], warning: "LAN Devices disabled in Settings" };
  }
  const snap = await lanDevices.snapshot();
  const merged = lanDevices.mergeIntoDb(db, snap);
  if (s.lan_new_device_toast && merged.newDevices.length) {
    for (const d of merged.newDevices.slice(0, 3)) {
      try {
        if (Notification.isSupported()) {
          new Notification({
            title: "New LAN device",
            body: `${d.ip || "?"} (${d.mac})${d.vendor ? " — " + d.vendor : ""}`,
          }).show();
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
          event: "new_device",
          title: "New LAN device",
          body: { mac: d.mac, ip: d.ip, vendor: d.vendor },
        })
        .catch(() => {});
    }
  }
  return {
    ok: true,
    gateway: merged.gateway,
    devices: merged.devices,
    new_count: merged.newDevices.length,
    disclaimer: snap.disclaimer,
  };
}

function listDevices() {
  const s = settings();
  if (s.lan_devices_enabled === false) {
    return { ok: false, devices: [], warning: "LAN Devices disabled in Settings" };
  }
  return { ok: true, devices: db ? db.listLanDevices() : [], disclaimer: "Passive neighbor cache — not a complete network map." };
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

/**
 * Star map from Devices inventory when SNMP is off — Topology still usable after Devices refresh.
 */
function neighborTopologyFromDevices(devices) {
  return lanDevices.neighborTopologyFromDevices(devices);
}

async function topology() {
  const s = settings();
  const devices = db ? db.listLanDevices() : [];
  if (!s.snmp_enabled) {
    return neighborTopologyFromDevices(devices);
  }
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
    return { ...fallback, warning: "No SNMP seeds yet — showing Devices inventory star map." };
  }
  return snmpTopology.discoverTopology({
    seeds,
    community: s.snmp_community || "public",
  });
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
      await notify.flushDigest({ urls: next.notify_webhooks_json });
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
  await notify.notify({
    urls: s.notify_webhooks_json,
    quietHours: s.notify_quiet_hours_json,
    event: kind,
    title: `Outage ${kind}: ${outage && outage.type}`,
    body: { type: outage && outage.type, id: outage && outage.id },
  });
}

function shutdown() {
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
