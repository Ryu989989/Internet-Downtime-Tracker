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
    db.updateSettings({ email_smtp_pass: "secret-pass" });
    db.updateSettings({ email_smtp_host: "smtp.example.com", email_smtp_pass: "" });
    const s = db.getSettings();
    assert.equal(s.email_smtp_pass, "secret-pass");
    assert.equal(s.email_smtp_host, "smtp.example.com");
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
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key), `missing default for ${key}`);
    }
  });
});
