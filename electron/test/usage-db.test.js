"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { TrackerDb, normalizeSettingValue } = require("../db");

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
