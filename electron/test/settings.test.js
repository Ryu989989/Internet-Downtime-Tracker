"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { TrackerDb, normalizeSettingValue, DEFAULT_SETTINGS, SECRET_SETTINGS } = require("../db");

describe("new settings clamp and round-trip", async () => {
  let dir;
  let db;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-settings-"));
    db = await TrackerDb.open(path.join(dir, "tracker.db"));
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts 0 for speedtest_interval_min", () => {
    assert.equal(normalizeSettingValue("speedtest_interval_min", 0), 0);
    assert.equal(normalizeSettingValue("speedtest_interval_min", -5), 0);
    assert.equal(normalizeSettingValue("speedtest_interval_min", 60), 60);
    assert.equal(normalizeSettingValue("speedtest_interval_min", 20000), 10080);
  });

  it("clamps degradation thresholds", () => {
    for (const key of ["degradation_loss_pct", "degradation_latency_ms", "degradation_jitter_ms"]) {
      assert.equal(normalizeSettingValue(key, ""), 0);
      assert.equal(normalizeSettingValue(key, 0), 0);
      assert.equal(normalizeSettingValue(key, 50), 50);
      assert.equal(normalizeSettingValue(key, -1), 0);
    }
    assert.equal(normalizeSettingValue("degradation_loss_pct", 150), 100);
    assert.equal(normalizeSettingValue("degradation_latency_ms", 999999), 30000);
  });

  it("defaults TCP monitor port to 80 when omitted", () => {
    const normalized = normalizeSettingValue("monitors_json", JSON.stringify([{ id: "t", type: "tcp", host: "1.1.1.1", interval_s: 30 }]));
    const parsed = JSON.parse(normalized);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].port, 80);
  });

  it("rejects invalid monitors_json", () => {
    assert.equal(normalizeSettingValue("monitors_json", "not-json"), null);
    assert.equal(normalizeSettingValue("monitors_json", "{}"), null);
    assert.equal(normalizeSettingValue("monitors_json", "[{\"id\":\"x\"}]"), "[]");
    assert.equal(normalizeSettingValue("monitors_json", "[{\"id\":\"x\",\"type\":\"tcp\",\"host\":\"127.0.0.1\",\"port\":80,\"interval_s\":30}]"), "[]");
  });

  it("preserves secrets when the form sends redacted empty values", () => {
    db.updateSettings({ email_smtp_pass: "secret-pass", router_password: "router-secret" });
    db.updateSettings({
      email_smtp_host: "smtp.example.com",
      email_smtp_pass: "",
      router_password: "",
      router_host: "192.168.1.1",
    });
    const s = db.getSettings();
    assert.equal(s.email_smtp_pass, "secret-pass");
    assert.equal(s.router_password, "router-secret");
    assert.equal(s.email_smtp_host, "smtp.example.com");
    assert.equal(s.router_host, "192.168.1.1");
  });

  it("round-trips new settings and redacts secrets in public view", () => {
    const updates = {
      speedtest_interval_min: 30,
      auto_traceroute_on_outage: true,
      degradation_loss_pct: 5,
      degradation_latency_ms: 100,
      degradation_jitter_ms: 20,
      telegram_bot_token: "secret-token",
      telegram_chat_id: "12345",
      ntfy_host: "ntfy.example.com",
      ntfy_topic: "alerts",
      email_smtp_host: "smtp.example.com",
      email_smtp_port: "587",
      email_smtp_user: "user@example.com",
      email_smtp_pass: "secret-pass",
      email_from: "from@example.com",
      email_to: "to@example.com",
      monitors_json: '[{"id":"gw","name":"Gateway","type":"ping","host":"1.1.1.1","interval_s":30}]',
    };
    db.updateSettings(updates);
    const s = db.getSettings();
    assert.equal(s.speedtest_interval_min, 30);
    assert.equal(s.auto_traceroute_on_outage, true);
    assert.equal(s.degradation_loss_pct, 5);
    assert.equal(s.degradation_latency_ms, 100);
    assert.equal(s.degradation_jitter_ms, 20);
    assert.ok(s.monitors_json.includes("gw"));

    const pub = db.getSettingsPublic();
    for (const key of SECRET_SETTINGS) {
      assert.equal(pub[key], "");
    }
    assert.equal(pub.telegram_chat_id, "12345");
    assert.equal(pub.email_smtp_host, "smtp.example.com");
  });

  it("validates custom monitor hosts against SSRF guards", () => {
    db.updateSettings({ monitors_json: '[{"id":"bad","name":"Bad","type":"ping","host":"169.254.169.254","interval_s":30}]' });
    const s = db.getSettings();
    assert.equal(s.monitors_json, "[]");
  });

  it("has default values for all new settings", () => {
    for (const key of [
      "speedtest_interval_min",
      "auto_traceroute_on_outage",
      "degradation_loss_pct",
      "degradation_latency_ms",
      "degradation_jitter_ms",
      "monitors_json",
      "telegram_bot_token",
      "telegram_chat_id",
      "ntfy_host",
      "ntfy_topic",
      "email_smtp_host",
      "email_smtp_port",
      "email_smtp_user",
      "email_smtp_pass",
      "email_from",
      "email_to",
      "widget_enabled",
      "widget_always_on_top",
      "widget_width",
      "widget_height",
      "widget_x",
      "widget_y",
      "widget_fill_pct",
      "widget_modules_json",
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key), `missing default for ${key}`);
    }
    const s = db.getSettings();
    assert.equal(s.widget_enabled, false);
    assert.equal(s.widget_always_on_top, true);
    assert.equal(s.widget_width, 360);
    assert.equal(s.widget_height, 220);
    assert.equal(s.widget_x, null);
    assert.equal(s.widget_y, null);
    assert.equal(s.widget_fill_pct, 72);
    assert.equal(s.widget_modules_json, DEFAULT_SETTINGS.widget_modules_json);
  });

  it("clamps widget fill, width, and height", () => {
    assert.equal(normalizeSettingValue("widget_fill_pct", 10), 20);
    assert.equal(normalizeSettingValue("widget_fill_pct", 99), 92);
    assert.equal(normalizeSettingValue("widget_fill_pct", 72), 72);
    assert.equal(normalizeSettingValue("widget_width", 100), 220);
    assert.equal(normalizeSettingValue("widget_width", 800), 720);
    assert.equal(normalizeSettingValue("widget_height", 10), 88);
    assert.equal(normalizeSettingValue("widget_height", 999), 480);
    assert.equal(normalizeSettingValue("widget_x", null), null);
    assert.equal(normalizeSettingValue("widget_x", ""), null);
    assert.equal(normalizeSettingValue("widget_x", -40), -40);
    assert.equal(normalizeSettingValue("widget_y", "12.9"), 12);
  });

  it("resets bad widget_modules_json to default", () => {
    assert.equal(normalizeSettingValue("widget_modules_json", "not-json"), DEFAULT_SETTINGS.widget_modules_json);
    assert.equal(normalizeSettingValue("widget_modules_json", "[]"), DEFAULT_SETTINGS.widget_modules_json);
    const merged = JSON.parse(normalizeSettingValue("widget_modules_json", '{"headline":false,"unknown":true}'));
    assert.equal(merged.headline, false);
    assert.equal(merged.layers, true);
    assert.equal(merged.speed, true);
    assert.equal(merged.unknown, undefined);
    const speedOff = JSON.parse(normalizeSettingValue("widget_modules_json", '{"speed":false}'));
    assert.equal(speedOff.speed, false);
    db.updateSettings({ widget_modules_json: "nope" });
    assert.equal(db.getSettings().widget_modules_json, DEFAULT_SETTINGS.widget_modules_json);
  });

  it("round-trips router poll settings and redacts router_password", () => {
    assert.equal(DEFAULT_SETTINGS.router_poll_enabled, false);
    assert.equal(DEFAULT_SETTINGS.router_vendor, "asuswrt");
    assert.equal(DEFAULT_SETTINGS.router_user, "admin");
    assert.equal(DEFAULT_SETTINGS.router_interval_s, 30);
    assert.equal(DEFAULT_SETTINGS.router_port, "");
    assert.equal(normalizeSettingValue("router_interval_s", 10), 15);
    assert.equal(normalizeSettingValue("router_interval_s", 400), 300);
    assert.equal(normalizeSettingValue("router_vendor", "NOPE"), null);
    assert.equal(normalizeSettingValue("router_user", ""), "admin");
    assert.equal(normalizeSettingValue("router_port", ""), "");
    db.updateSettings({
      router_poll_enabled: true,
      router_vendor: "nighthawk",
      router_host: "192.168.1.1",
      router_https: true,
      router_user: "admin",
      router_password: "wifi-secret",
      router_interval_s: 10,
      router_port: "5000",
    });
    const s = db.getSettings();
    assert.equal(s.router_poll_enabled, true);
    assert.equal(s.router_vendor, "nighthawk");
    assert.equal(s.router_host, "192.168.1.1");
    assert.equal(s.router_https, true);
    assert.equal(s.router_password, "wifi-secret");
    assert.equal(s.router_interval_s, 15);
    assert.equal(s.router_port, "5000");
    assert.equal(db.getSettingsPublic().router_password, "");
    db.updateSettings({ router_vendor: "nope", router_password: "", router_port: "" });
    const s2 = db.getSettings();
    assert.equal(s2.router_vendor, "nighthawk");
    assert.equal(s2.router_password, "wifi-secret");
    assert.equal(s2.router_port, "");
  });

  it("upsertLanDevice persists wifi fields without wiping alias", () => {
    db.upsertLanDevice({
      mac: "aa:bb:cc:dd:ee:ff",
      ip: "192.168.1.10",
      alias: "TV",
      notes: "den",
      online: true,
    });
    db.upsertLanDevice({
      mac: "aa:bb:cc:dd:ee:ff",
      ip: "192.168.1.10",
      online: true,
      wifi_rssi: -62,
      wifi_signal_pct: 70,
      wifi_band: "5g",
      wifi_tx_mbps: 866,
      wifi_rx_mbps: 400,
      wifi_node_mac: "11:22:33:44:55:66",
      wifi_ssid: "Home",
      last_wifi_at: 1700000000,
    });
    const row = db.getLanDevice("AA:BB:CC:DD:EE:FF");
    assert.equal(row.alias, "TV");
    assert.equal(row.notes, "den");
    assert.equal(row.wifi_rssi, -62);
    assert.equal(row.wifi_signal_pct, 70);
    assert.equal(row.wifi_band, "5g");
    assert.equal(row.wifi_ssid, "Home");
    db.upsertLanDevice({ mac: "aa:bb:cc:dd:ee:ff", ip: "192.168.1.11", online: true });
    const row2 = db.getLanDevice("AA:BB:CC:DD:EE:FF");
    assert.equal(row2.alias, "TV");
    assert.equal(row2.ip, "192.168.1.11");
    assert.equal(row2.wifi_rssi, -62);
    assert.equal(row2.wifi_ssid, "Home");
  });

  it("migrates empty router_targets_json from legacy fields into id=default", () => {
    db.updateSettings({
      router_targets_json: "[]",
      router_vendor: "nighthawk",
      router_host: "192.168.1.1",
      router_user: "admin",
      router_https: true,
      router_port: "5000",
      router_password: "legacy-secret",
    });
    const s = db.getSettings();
    const targets = JSON.parse(s.router_targets_json);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].id, "default");
    assert.equal(targets[0].vendor, "nighthawk");
    assert.equal(targets[0].host, "192.168.1.1");
    assert.equal(targets[0].https, true);
    assert.equal(targets[0].port, "5000");
    assert.equal(targets[0].enabled, true);
    assert.equal(JSON.parse(s.router_secrets_json).default.password, "legacy-secret");
    assert.equal(s.router_vendor, "nighthawk");
    const pub = db.getSettingsPublic();
    assert.equal(pub.router_secrets_json, "");
    assert.equal(pub.router_password, "");
  });

  it("does not wipe router_secrets_json when the form sends empty passwords", () => {
    db.updateSettings({
      router_targets_json: JSON.stringify([
        { id: "a", vendor: "asuswrt", host: "192.168.1.1", user: "admin", port: "", https: false, enabled: true },
      ]),
      router_secrets_json: JSON.stringify({ a: { password: "keep-me", api_key: "key-1" } }),
    });
    db.updateSettings({
      router_targets_json: JSON.stringify([
        { id: "a", vendor: "asuswrt", host: "192.168.1.3", user: "admin", port: "", https: false, enabled: true },
      ]),
      router_secrets_json: JSON.stringify({ a: { password: "", api_key: "" } }),
    });
    let secrets = JSON.parse(db.getSettings().router_secrets_json);
    assert.equal(secrets.a.password, "keep-me");
    assert.equal(secrets.a.api_key, "key-1");
    assert.equal(JSON.parse(db.getSettings().router_targets_json)[0].host, "192.168.1.3");
    db.updateSettings({ router_secrets_json: "{}" });
    secrets = JSON.parse(db.getSettings().router_secrets_json);
    assert.equal(secrets.a.password, "keep-me");
    db.updateSettings({ router_secrets_json: "" });
    secrets = JSON.parse(db.getSettings().router_secrets_json);
    assert.equal(secrets.a.password, "keep-me");
    assert.equal(db.getSettingsPublic().router_secrets_json, "");
  });
});
