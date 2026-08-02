"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { tcpConnect, summarizePingBurst, isMonitorStale } = require("../netcheck");

describe("netcheck", () => {
  it("tcpConnect times out on closed port", async () => {
    const [ok, lat] = await tcpConnect("127.0.0.1", 1, 500);
    assert.equal(ok, false);
    assert.equal(lat, null);
  });

  it("summarizePingBurst computes loss jitter avg last", () => {
    const q = summarizePingBurst(
      [
        { ok: true, latency_ms: 10 },
        { ok: true, latency_ms: 14 },
        { ok: false, latency_ms: null },
        { ok: true, latency_ms: 12 },
      ],
      { target: "1.1.1.1", at: 100 }
    );
    assert.equal(q.target, "1.1.1.1");
    assert.equal(q.samples, 4);
    assert.equal(q.lost, 1);
    assert.equal(q.loss_pct, 25);
    assert.equal(q.latency_ms, 12);
    assert.equal(q.latency_avg_ms, 12);
    assert.equal(q.jitter_ms, 3); // |14-10| + |12-14| / 2 = 3
    assert.equal(q.at, 100);
  });

  it("isMonitorStale when last probe older than 2× poll", () => {
    assert.equal(
      isMonitorStale({
        last_probe_at: 1000,
        poll_interval_s: 5,
        paused: false,
        now: 1011,
      }),
      true
    );
    assert.equal(
      isMonitorStale({
        last_probe_at: 1000,
        poll_interval_s: 5,
        paused: false,
        now: 1009,
      }),
      false
    );
    assert.equal(
      isMonitorStale({
        last_probe_at: 1000,
        poll_interval_s: 5,
        paused: true,
        now: 2000,
      }),
      false
    );
    assert.equal(
      isMonitorStale({
        last_probe_at: 1000,
        poll_interval_s: 5,
        probe_suppressed: true,
        now: 2000,
      }),
      false
    );
    assert.equal(isMonitorStale({ last_probe_at: null, now: 2000 }), false);
  });
});
