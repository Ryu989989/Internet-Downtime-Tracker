"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { TrackerDb, normalizeSettingValue, DEFAULT_SETTINGS } = require("../db");

describe("usage db rollup", () => {
  let dir;
  let db;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-usage-db-"));
    db = await TrackerDb.open(path.join(dir, "tracker.db"));
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rolls bytes into hourly and daily buckets", () => {
    const atMs = 1_700_000_000_000;
    db.upsertUsageApp({ app_key: "chrome.exe", display_name: "Chrome" });
    db.addUsageBytes({
      app_key: "chrome.exe",
      bytes_in: 100,
      bytes_out: 50,
      atMs,
    });
    db.addUsageBytes({
      app_key: "chrome.exe",
      bytes_in: 20,
      bytes_out: 10,
      atMs: atMs + 1000,
    });
    const hourTs = Math.floor(atMs / 1000 / 3600) * 3600;
    const dayTs = Math.floor(atMs / 1000 / 86400) * 86400;
    const hourly = db._get(
      "SELECT bytes_in, bytes_out FROM usage_hourly WHERE app_key=? AND bucket_ts=?",
      ["chrome.exe", hourTs]
    );
    const daily = db._get(
      "SELECT bytes_in, bytes_out FROM usage_daily WHERE app_key=? AND bucket_ts=?",
      ["chrome.exe", dayTs]
    );
    assert.equal(hourly.bytes_in, 120);
    assert.equal(hourly.bytes_out, 60);
    assert.equal(daily.bytes_in, 120);
    assert.equal(daily.bytes_out, 60);
  });

  it("pruneUsage drops old buckets", () => {
    const oldSec = Math.floor(Date.now() / 1000) - 40 * 86400;
    const oldHour = Math.floor(oldSec / 3600) * 3600;
    const oldDay = Math.floor(oldSec / 86400) * 86400;
    db._run(
      "INSERT INTO usage_hourly (app_key, bucket_ts, bytes_in, bytes_out) VALUES (?, ?, ?, ?)",
      ["old.exe", oldHour, 1, 1]
    );
    db._run(
      "INSERT INTO usage_daily (app_key, bucket_ts, bytes_in, bytes_out) VALUES (?, ?, ?, ?)",
      ["old.exe", oldDay, 1, 1]
    );
    db.pruneUsage({ hourlyDays: 14, dailyDays: 30 });
    const hourly = db._get(
      "SELECT 1 AS ok FROM usage_hourly WHERE app_key=? AND bucket_ts=?",
      ["old.exe", oldHour]
    );
    const daily = db._get(
      "SELECT 1 AS ok FROM usage_daily WHERE app_key=? AND bucket_ts=?",
      ["old.exe", oldDay]
    );
    assert.equal(hourly, null);
    assert.equal(daily, null);
  });

  it("locks probe_retention_days at 14 and pruneProbes cannot delete outages", () => {
    assert.equal(DEFAULT_SETTINGS.probe_retention_days, 14);
    assert.equal(db.getSettings().probe_retention_days, 14);
    const oldTs = Date.now() / 1000 - 20 * 86400;
    const outageId = db.openOutage("wan", oldTs);
    db.insertProbe(false, false, 1, oldTs);
    db.insertProbe(true, true, 1, Date.now() / 1000);
    const oldAt = Date.now() / 1000 - 20 * 86400;
    const freshAt = Date.now() / 1000;
    db.insertWifiSample({ mac: "aa:bb:cc:dd:ee:ff", source: "host_nic", at: oldAt, rssi: -70 });
    db.insertWifiSample({ mac: "aa:bb:cc:dd:ee:ff", source: "asus", at: freshAt, rssi: -50 });
    db.insertWifiEvent({ at: oldAt, kind: "roam", source: "host_nic", ssid: "Home" });
    db.insertWifiEvent({ at: freshAt, kind: "disconnect", source: "wlan", ssid: "Home" });
    db.insertRouterHealthSample({ at: oldAt, cpu_pct: 10, vendor: "asuswrt" });
    db.insertRouterHealthSample({ at: freshAt, cpu_pct: 20, vendor: "asuswrt" });
    db.pruneProbes();
    assert.equal(
      db._get("SELECT COUNT(*) AS c FROM probes WHERE timestamp < ?", [
        Date.now() / 1000 - 14 * 86400,
      ]).c,
      0
    );
    assert.ok(db._get("SELECT * FROM outages WHERE id=?", [outageId]));
    assert.equal(db._get("SELECT COUNT(*) AS c FROM probes").c, 1);
    assert.equal(db._get("SELECT COUNT(*) AS c FROM wifi_samples").c, 1);
    assert.equal(db._get("SELECT COUNT(*) AS c FROM wifi_events").c, 1);
    assert.equal(db._get("SELECT kind FROM wifi_events").kind, "disconnect");
    assert.equal(db._get("SELECT COUNT(*) AS c FROM router_health_samples").c, 1);
    assert.equal(db.getLatestRouterHealth().cpu_pct, 20);
    assert.equal(db.listWifiHistory({ mac: "aa:bb:cc:dd:ee:ff" }).length, 1);
    const src = fs.readFileSync(path.join(__dirname, "..", "db.js"), "utf8");
    const fn = src.match(/pruneProbes\([\s\S]*?\n  \}/)[0];
    assert.match(fn, /DELETE FROM probes/);
    assert.match(fn, /DELETE FROM wifi_samples/);
    assert.match(fn, /DELETE FROM wifi_events/);
    assert.match(fn, /DELETE FROM router_health_samples/);
    assert.doesNotMatch(fn, /DELETE FROM outages/);
  });

  it("clearUsageHistory removes rollup rows", () => {
    db.addUsageBytes({ app_key: "temp.exe", bytes_in: 5, bytes_out: 5 });
    db.clearUsageHistory();
    assert.equal(db._get("SELECT COUNT(*) AS c FROM usage_hourly").c, 0);
    assert.equal(db._get("SELECT COUNT(*) AS c FROM usage_daily").c, 0);
  });
});

describe("usage settings bools", () => {
  let dir;
  let db;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-usage-set-"));
    db = await TrackerDb.open(path.join(dir, "tracker.db"));
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("defaults usage toggles safely", () => {
    const s = db.getSettings();
    assert.equal(s.connections_enabled, true);
    assert.equal(s.connections_resolve_dns, false);
    assert.equal(s.usage_monitoring, false);
    assert.equal(s.network_control_enabled, false);
  });

  it("coerces bool settings and persists", () => {
    assert.equal(normalizeSettingValue("connections_enabled", "off"), false);
    assert.equal(normalizeSettingValue("usage_monitoring", "yes"), true);
    assert.equal(normalizeSettingValue("network_control_enabled", 0), false);
    const updated = db.updateSettings({
      connections_enabled: false,
      usage_monitoring: true,
      network_control_enabled: true,
    });
    assert.equal(updated.connections_enabled, false);
    assert.equal(updated.usage_monitoring, true);
    assert.equal(updated.network_control_enabled, true);
    const reloaded = db.getSettings();
    assert.equal(reloaded.usage_monitoring, true);
  });
});

describe("wifi_events", () => {
  let dir;
  let db;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-wifi-events-"));
    db = await TrackerDb.open(path.join(dir, "tracker.db"));
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("insertWifiEvent skips empty kind and dedups same at/kind/source/event_id within 1s", () => {
    const at = 1_700_000_100;
    assert.equal(db.insertWifiEvent({ at, kind: "", source: "wlan" }), null);
    assert.equal(db.insertWifiEvent({ at, kind: null, source: "wlan" }), null);
    const first = db.insertWifiEvent({
      at,
      kind: "disconnect",
      source: "wlan",
      event_id: 8003,
      ssid: "Home",
    });
    assert.ok(first);
    assert.equal(first.kind, "disconnect");
    const dup = db.insertWifiEvent({
      at: at + 0.4,
      kind: "disconnect",
      source: "wlan",
      event_id: 8003,
    });
    assert.equal(dup, null);
    const other = db.insertWifiEvent({
      at: at + 0.4,
      kind: "connect",
      source: "wlan",
      event_id: 8001,
    });
    assert.ok(other);
    const listed = db.listWifiEvents({ fromTs: at - 1, toTs: at + 2, limit: 500 });
    assert.equal(listed.length, 2);
    assert.ok(listed.every((r) => r.kind === "disconnect" || r.kind === "connect"));
  });
});
