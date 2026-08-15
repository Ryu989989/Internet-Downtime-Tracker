"use strict";

const { describe, it, beforeEach, afterEach, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  startCustomMonitors,
  stopCustomMonitors,
  resetForTest,
  parseMonitors,
  probeMonitor,
  setProbeFunctionsForTest,
  setNotifyFn,
  getActiveForTest,
} = require("../custom-monitors");
const { TrackerDb } = require("../db");

describe("custom monitors", () => {
  let dir;
  let db;
  let notifications = [];
  let originalSetTimeout;
  let originalSetInterval;
  let originalClearInterval;
  let timeouts = [];
  let intervals = [];

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-monitors-"));
    db = await TrackerDb.open(path.join(dir, "tracker.db"));
  });

  after(() => {
    resetForTest();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    notifications = [];
    resetForTest();
    setNotifyFn((opts) => notifications.push(opts));
    originalSetTimeout = global.setTimeout;
    originalSetInterval = global.setInterval;
    originalClearInterval = global.clearInterval;
    timeouts = [];
    intervals = [];
    global.setTimeout = (fn, ms) => {
      const t = { fn, ms, unref: () => t };
      timeouts.push(t);
      return t;
    };
    global.setInterval = (fn, ms) => {
      const t = { id: intervals.length + 1, fn, ms };
      intervals.push(t);
      return t;
    };
    global.clearInterval = (handle) => {
      if (handle && intervals[handle.id - 1]) intervals[handle.id - 1].cleared = true;
    };
  });

  afterEach(() => {
    stopCustomMonitors();
    setProbeFunctionsForTest(null);
    setNotifyFn(null);
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  });

  it("parses valid monitors and rejects bad hosts", () => {
    const settings = {
      monitors_json: JSON.stringify([
        { id: "pub", name: "Public ping", type: "ping", host: "1.1.1.1", interval_s: 30 },
        { id: "bad", type: "ping", host: "127.0.0.1", interval_s: 30 },
        { id: "web", name: "Site", type: "http", url: "https://example.com", interval_s: 60 },
      ]),
    };
    const ms = parseMonitors(settings);
    assert.equal(ms.length, 2);
    assert.equal(ms[0].id, "pub");
    assert.equal(ms[1].id, "web");
  });

  it("probes TCP monitor using injected function", async () => {
    setProbeFunctionsForTest({
      tcp: async (host, port) => [true, 12.3],
    });
    const r = await probeMonitor({ id: "t", type: "tcp", host: "1.1.1.1", port: 443 });
    assert.equal(r.ok, true);
    assert.equal(r.latency_ms, 12.3);
  });

  it("probes HTTP monitor using injected function", async () => {
    setProbeFunctionsForTest({
      http: async ({ url }) => [true, 45],
    });
    const r = await probeMonitor({ id: "h", type: "http", url: "https://example.com" });
    assert.equal(r.ok, true);
    assert.equal(r.latency_ms, 45);
  });

  it("probes ping monitor using injected function", async () => {
    setProbeFunctionsForTest({
      ping: async (host) => [true, 8],
    });
    const r = await probeMonitor({ id: "p", type: "ping", host: "1.1.1.1" });
    assert.equal(r.ok, true);
    assert.equal(r.latency_ms, 8);
  });

  it("rejects blocked probe hosts", async () => {
    setProbeFunctionsForTest({
      ping: async () => [true, 1],
    });
    const r = await probeMonitor({ id: "p", type: "ping", host: "169.254.169.254" });
    assert.equal(r.ok, false);
  });

  it("notifies on up/down transitions", async () => {
    db.updateSettings({ monitors_json: JSON.stringify([{ id: "pub", name: "Public host", type: "ping", host: "1.1.1.1", interval_s: 5 }]) });

    let up = true;
    setProbeFunctionsForTest({
      ping: async () => [up, 10],
    });

    startCustomMonitors({ db, monitor: { state: { paused: false, probe_suppressed: false } } });
    assert.equal(timeouts.length, 1);
    assert.equal(intervals.length, 1);

    // first tick: null -> up, no notification
    await timeouts[0].fn();
    assert.equal(notifications.length, 0);

    // second tick: up -> down
    up = false;
    await intervals[0].fn();
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].event, "monitor_down");

    // third tick: down -> up
    up = true;
    await intervals[0].fn();
    assert.equal(notifications.length, 2);
    assert.equal(notifications[1].event, "monitor_up");
  });

  it("writes results to monitor_checks", async () => {
    db.updateSettings({ monitors_json: JSON.stringify([{ id: "chk", type: "ping", host: "1.1.1.1", interval_s: 5 }]) });
    setProbeFunctionsForTest({ ping: async () => [true, 7] });
    startCustomMonitors({ db, monitor: { state: { paused: false, probe_suppressed: false } } });
    assert.equal(timeouts.length, 1);
    await timeouts[0].fn();
    const latest = db.getLatestMonitorCheck("chk");
    assert.ok(latest);
    assert.equal(latest.ok, 1);
    assert.equal(latest.latency_ms, 7);
  });

  it("defaults omitted TCP port to 80 in probeMonitor", async () => {
    setProbeFunctionsForTest({ tcp: async (host, port) => [host === "1.1.1.1" && port === 80, 12] });
    const result = await probeMonitor({ id: "t", type: "tcp", host: "1.1.1.1" });
    assert.equal(result.ok, true);
    assert.equal(result.latency_ms, 12);
  });

  it("prevents overlapping ticks", async () => {
    let release;
    setProbeFunctionsForTest({ ping: () => new Promise((r) => { release = r; }) });
    db.updateSettings({ monitors_json: JSON.stringify([{ id: "p", name: "x", type: "ping", host: "1.1.1.1", interval_s: 10 }]) });
    startCustomMonitors({ db, monitor: { state: { paused: false, probe_suppressed: false } } });
    const entry = getActiveForTest().get("p");
    assert.ok(entry);
    const first = entry.timer.fn();
    const second = entry.timer.fn();
    await second;
    assert.equal(entry.isRunning, true);
    release([true, 10]);
    await first;
    assert.equal(entry.isRunning, false);
  });
});
