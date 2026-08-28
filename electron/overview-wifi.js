"use strict";

/**
 * Overview Wi-Fi: host NIC when this PC is on Wi-Fi; else last router-poll cache.
 * Never invents dBm from %.
 */

function finiteOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function macKey(mac) {
  if (mac == null || mac === "") return "";
  return String(mac)
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "");
}

function parseExtra(extra) {
  if (!extra) return null;
  if (typeof extra === "string") {
    try {
      extra = JSON.parse(extra);
    } catch {
      return null;
    }
  }
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return null;
  return extra;
}

function ssidFromExtra(extra) {
  const obj = parseExtra(extra);
  if (!obj) return null;
  for (const k of ["ssid", "wifi_ssid", "wlan_ssid", "wl_ssid"]) {
    const v = obj[k];
    if (v != null && String(v).trim()) return String(v).trim().slice(0, 64);
  }
  return null;
}

function normDevice(d) {
  if (!d || typeof d !== "object") return null;
  return {
    mac: d.mac,
    online: d.online !== false,
    ssid: (d.wifi_ssid || d.ssid || null) && String(d.wifi_ssid || d.ssid).trim()
      ? String(d.wifi_ssid || d.ssid).trim()
      : null,
    rssi: finiteOrNull(d.wifi_rssi != null ? d.wifi_rssi : d.rssi),
    signal_pct: finiteOrNull(d.wifi_signal_pct != null ? d.wifi_signal_pct : d.signal_pct),
    band: d.wifi_band || d.band || null,
  };
}

function isWiredBand(band) {
  return String(band || "")
    .trim()
    .toLowerCase() === "wired";
}

function onlineWifiClients(devices) {
  const out = [];
  for (const raw of devices || []) {
    const d = normDevice(raw);
    if (!d || !d.online || isWiredBand(d.band)) continue;
    const hasBand = !!(d.band && String(d.band).trim());
    if (!hasBand && !d.ssid && d.rssi == null && d.signal_pct == null) continue;
    out.push({ ...d, hasBand });
  }
  return out;
}

function mostCommonSsid(clients) {
  const counts = new Map();
  for (const c of clients) {
    if (!c.ssid) continue;
    counts.set(c.ssid, (counts.get(c.ssid) || 0) + 1);
  }
  let best = null;
  let n = 0;
  for (const [s, c] of counts) {
    if (c > n || (c === n && (best == null || s < best))) {
      best = s;
      n = c;
    }
  }
  return best;
}

function medianRssi(rssis) {
  if (!rssis.length) return null;
  const a = rssis.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  if (a.length % 2) return a[mid];
  return Math.round((a[mid - 1] + a[mid]) / 2);
}

function rssiStats(clients) {
  const rssis = [];
  for (const c of clients) {
    if (c.rssi != null) rssis.push(c.rssi);
  }
  return {
    weakest_rssi: rssis.length ? Math.min(...rssis) : null,
    median_rssi: medianRssi(rssis),
  };
}

function matchHostDevice(host_adapter, devices, clients) {
  const key = macKey(host_adapter && host_adapter.mac);
  if (!key) return null;
  for (const c of clients) {
    if (macKey(c.mac) === key) return c;
  }
  for (const raw of devices || []) {
    if (macKey(raw && raw.mac) !== key) continue;
    const d = normDevice(raw);
    if (!d || isWiredBand(d.band)) return null;
    if (d.rssi != null || d.signal_pct != null || d.ssid || d.band) return d;
    return null;
  }
  return null;
}

function result({ ssid, rssi, signal_pct, band, source, this_pc_on_wifi, client_count, weakest_rssi, median_rssi }) {
  return {
    ssid: ssid || null,
    rssi: rssi != null ? rssi : null,
    signal_pct: signal_pct != null ? signal_pct : null,
    band: band || null,
    source: source || null,
    this_pc_on_wifi: !!this_pc_on_wifi,
    client_count: client_count || 0,
    weakest_rssi: weakest_rssi != null ? weakest_rssi : null,
    median_rssi: median_rssi != null ? median_rssi : null,
  };
}

/**
 * @param {{ adapter?: object, devices?: object[], host_adapter?: object, pollEnabled?: boolean, extra?: object|string, source?: string }} input
 */
function pickOverviewWifi(input = {}) {
  const adapter = input.adapter;
  const devices = input.devices;
  const host_adapter = input.host_adapter;
  const pollEnabled = !!input.pollEnabled;
  const clients = onlineWifiClients(devices);
  const bandClients = clients.filter((c) => c.hasBand);
  const stats = rssiStats(bandClients);

  if (adapter && adapter.type === "wifi") {
    return result({
      ssid: adapter.ssid || null,
      rssi: finiteOrNull(adapter.rssi),
      signal_pct: finiteOrNull(adapter.signal != null ? adapter.signal : adapter.signal_pct),
      band: adapter.band || null,
      source: "host_nic",
      this_pc_on_wifi: true,
      client_count: bandClients.length,
      weakest_rssi: stats.weakest_rssi,
      median_rssi: stats.median_rssi,
    });
  }

  if (!pollEnabled) return null;

  const thisPc = matchHostDevice(host_adapter, devices, clients);
  const this_pc_on_wifi = !!(
    thisPc &&
    (thisPc.rssi != null || thisPc.signal_pct != null || thisPc.ssid || thisPc.band)
  );
  const ssid =
    mostCommonSsid(clients) ||
    (host_adapter && host_adapter.ssid) ||
    ssidFromExtra(input.extra) ||
    null;
  const src = input.source && input.source !== "host_nic" ? input.source : null;

  if (!ssid && !bandClients.length && !(this_pc_on_wifi && thisPc && thisPc.rssi != null)) {
    return null;
  }

  return result({
    ssid,
    rssi: this_pc_on_wifi && thisPc ? thisPc.rssi : null,
    signal_pct: this_pc_on_wifi && thisPc ? thisPc.signal_pct : null,
    band: this_pc_on_wifi && thisPc ? thisPc.band : null,
    source: src,
    this_pc_on_wifi,
    client_count: bandClients.length,
    weakest_rssi: stats.weakest_rssi,
    median_rssi: stats.median_rssi,
  });
}

module.exports = { pickOverviewWifi, ssidFromExtra };
