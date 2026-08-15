"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Monitor } = require("../monitor");
const { TrackerDb } = require("../db");

describe("degradation detection", async () => {
  let dir;
  let db;
  let monitor;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-degradation-"));
    db = await TrackerDb.open(path.join(dir, "tracker.db"));
  });

  after(() => {
    if (monitor) monitor.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    if (monitor) monitor.stop();
    monitor = new Monitor(db, { probeFn: async () => ({ lan_ok: true, wan_ok: true, dns_ok: true, http_ok: true, gateway: "192.168.1.1", latency_ms: 5 }) });
  });

  it("ignores degradation when thresholds are off", () => {
    db.updateSettings({ degradation_loss_pct: 0, degradation_latency_ms: 0, degradation_jitter_ms: 0 });
    monitor._evaluateDegradation({ loss_pct: 100, latency_avg_ms: 1000, jitter_ms: 1000 });
    assert.equal(monitor.state.degraded, false);
  });

  it("requires three consecutive breaching bursts to flag degraded", () => {
    db.updateSettings({ degradation_loss_pct: 5, degradation_latency_ms: 0, degradation_jitter_ms: 0 });
    const bad = { loss_pct: 10, latency_avg_ms: 5, jitter_ms: 1 };
    monitor._evaluateDegradation(bad);
    assert.equal(monitor.state.degraded, false);
    monitor._evaluateDegradation(bad);
    assert.equal(monitor.state.degraded, false);
    monitor._evaluateDegradation(bad);
    assert.equal(monitor.state.degraded, true);
  });

  it("clears degraded after three good bursts", () => {
    db.updateSettings({ degradation_loss_pct: 5 });
    const bad = { loss_pct: 10 };
    const good = { loss_pct: 0 };
    for (let i = 0; i < 3; i++) monitor._evaluateDegradation(bad);
    assert.equal(monitor.state.degraded, true);
    for (let i = 0; i < 3; i++) monitor._evaluateDegradation(good);
    assert.equal(monitor.state.degraded, false);
  });

  it("does not open an outage on degradation", () => {
    db.updateSettings({ degradation_loss_pct: 1 });
    const bad = { loss_pct: 50 };
    for (let i = 0; i < 3; i++) monitor._evaluateDegradation(bad);
    assert.equal(monitor.state.degraded, true);
    assert.equal(db.getOpenOutages().length, 0);
  });

  it("persists degradation window", () => {
    db.updateSettings({ degradation_loss_pct: 1 });
    const bad = { loss_pct: 50, latency_avg_ms: 20, jitter_ms: 5 };
    for (let i = 0; i < 3; i++) monitor._evaluateDegradation(bad);
    const open = db.getOpenDegradationWindow();
    assert.ok(open);
    assert.equal(open.loss_pct, 50);
  });

  it("checks latency and jitter thresholds", () => {
    db.updateSettings({ degradation_loss_pct: 0, degradation_latency_ms: 100, degradation_jitter_ms: 0 });
    const over = { loss_pct: 0, latency_avg_ms: 120, jitter_ms: 0 };
    for (let i = 0; i < 3; i++) monitor._evaluateDegradation(over);
    assert.equal(monitor.state.degraded, true);
  });
});
