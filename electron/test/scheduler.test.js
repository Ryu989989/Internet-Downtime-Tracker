"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createSpeedtestScheduler } = require("../speedtest-scheduler");

describe("speedtest scheduler gating", () => {
  let timers = [];
  let intervals = [];
  let originalSetTimeout;
  let originalSetInterval;
  let originalClearInterval;

  beforeEach(() => {
    originalSetTimeout = global.setTimeout;
    originalSetInterval = global.setInterval;
    originalClearInterval = global.clearInterval;
    timers = [];
    intervals = [];
    global.setTimeout = (fn, ms) => {
      const t = { fn, ms, unref: () => t };
      timers.push(t);
      return t;
    };
    global.setInterval = (fn, ms) => {
      intervals.push({ fn, ms });
      return { id: intervals.length };
    };
    global.clearInterval = (handle) => {
      if (handle && intervals[handle.id - 1]) intervals[handle.id - 1].cleared = true;
    };
  });

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  });

  function makeDeps(opts = {}) {
    const runs = [];
    const suppressLog = [];
    return {
      runs,
      suppressLog,
      db: {
        getSettings: () => ({
          speedtest_interval_min: opts.interval ?? 60,
        }),
        insertSpeedTest: (row) => ({ ...row, id: 1 }),
      },
      monitor: {
        state: { paused: opts.paused ?? false, probe_suppressed: opts.probeSuppressed ?? false },
        _suppressProbes: opts.suppressProbes ?? false,
        setProbeSuppress: (active, opts2 = {}) => {
          const entry = { active };
          if (opts2.cooldownMs != null) entry.cooldownMs = opts2.cooldownMs;
          suppressLog.push(entry);
        },
      },
      speedtest: {
        runSpeedTest: async () => {
          runs.push("run");
          return { tested_at: Date.now() / 1000, download_mbps: 100, upload_mbps: 50, ping_ms: 10, jitter_ms: 1, packet_loss: 0, server_name: "x", server_id: "1", server_location: "here", isp: "test", result_url: "", raw_json: "{}" };
        },
      },
      usageBridge: {
        setSuppress: async (active) => { suppressLog.push({ suppress: active }); },
      },
      userDataPath: () => "/tmp/userdata",
    };
  }

  it("starts an interval when interval > 0", () => {
    const deps = makeDeps({ interval: 30 });
    const { startSpeedtestScheduler } = createSpeedtestScheduler(deps);
    startSpeedtestScheduler();
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].ms, 30 * 60_000);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 30_000);
  });

  it("does not schedule when interval is 0", () => {
    const deps = makeDeps({ interval: 0 });
    const { startSpeedtestScheduler } = createSpeedtestScheduler(deps);
    startSpeedtestScheduler();
    assert.equal(intervals.length, 0);
    assert.equal(timers.length, 0);
  });

  it("runs the test when interval ticks", async () => {
    const deps = makeDeps({ interval: 10 });
    const { startSpeedtestScheduler } = createSpeedtestScheduler(deps);
    startSpeedtestScheduler();
    assert.equal(intervals.length, 1);
    await intervals[0].fn();
    assert.equal(deps.runs.length, 1);
    assert.deepEqual(deps.suppressLog, [
      { active: true },
      { suppress: true },
      { active: false, cooldownMs: 8000 },
      { suppress: false },
    ]);
  });

  it("skips tick when monitor is paused", async () => {
    const deps = makeDeps({ interval: 10, paused: true });
    const { startSpeedtestScheduler } = createSpeedtestScheduler(deps);
    startSpeedtestScheduler();
    await intervals[0].fn();
    assert.equal(deps.runs.length, 0);
  });

  it("skips tick when probes are suppressed", async () => {
    const deps = makeDeps({ interval: 10, probeSuppressed: true });
    const { startSpeedtestScheduler } = createSpeedtestScheduler(deps);
    startSpeedtestScheduler();
    await intervals[0].fn();
    assert.equal(deps.runs.length, 0);
  });

  it("skips tick when already running a test", async () => {
    const deps = makeDeps({ interval: 10, suppressProbes: true });
    const { startSpeedtestScheduler } = createSpeedtestScheduler(deps);
    startSpeedtestScheduler();
    await intervals[0].fn();
    assert.equal(deps.runs.length, 0);
  });

  it("reschedules on restart and clears old interval", () => {
    const deps = makeDeps({ interval: 10 });
    const { startSpeedtestScheduler, stopSpeedtestScheduler } = createSpeedtestScheduler(deps);
    startSpeedtestScheduler();
    assert.equal(intervals.length, 1);
    stopSpeedtestScheduler();
    startSpeedtestScheduler();
    assert.equal(intervals.length, 2);
  });

  it("does not start a second test while one is still running", async () => {
    const deps = makeDeps({ interval: 10 });
    let release;
    deps.speedtest.runSpeedTest = () => new Promise((r) => { release = r; });
    const { startSpeedtestScheduler, runSpeedTestAndStore } = createSpeedtestScheduler(deps);
    startSpeedtestScheduler();
    const first = runSpeedTestAndStore();
    const second = runSpeedTestAndStore();
    const secondResult = await second;
    assert.equal(secondResult.ok, false);
    assert.equal(secondResult.cancelled, true);
    release({ tested_at: Date.now() / 1000, download_mbps: 1, upload_mbps: 1, ping_ms: 1, jitter_ms: 0, packet_loss: 0, server_name: "x", server_id: "1", server_location: "here", isp: "test", result_url: "", raw_json: "{}" });
    await first;
  });

  it("cancels scheduled first run", async () => {
    const deps = makeDeps({ interval: 10 });
    const { startSpeedtestScheduler } = createSpeedtestScheduler(deps);
    startSpeedtestScheduler();
    await timers[0].fn();
    assert.equal(deps.runs.length, 1);
  });
});
