"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  honestUptimeBar,
  formatHttpCertDays,
  lastFailReason,
  layerPillTips,
} = require("../uptime-bar");

describe("honestUptimeBar", () => {
  it("uses 30d outage % and never labels 14d probe spark as 30d", () => {
    const bar = honestUptimeBar(
      {
        windows: { "30d": { all: { downtime_pct: 1.5, downtime_ms: 1000, count: 2 } } },
        sparkline_24h: [0, 1, 0],
      },
      {
        probeRetentionDays: 14,
        nowSec: 1_000_000,
        observeSince: 1_000_000 - 40 * 86400,
      }
    );
    assert.equal(bar.uptime_pct, 98.5);
    assert.equal(bar.downtime_pct, 1.5);
    assert.equal(bar.pct_label, "30d");
    assert.equal(bar.probe_spark_label, "14d");
    assert.equal(bar.sparkline_24h_label, "24h");
    assert.notEqual(bar.probe_spark_label, "30d");
    assert.notEqual(bar.sparkline_24h_label, "30d");
    assert.deepEqual(bar.sparkline_24h, [0, 1, 0]);
  });

  it("labels pct with actual observed days when under 30d", () => {
    const now = 1_000_000;
    const bar = honestUptimeBar(
      { windows: { "30d": { all: { downtime_pct: 0, downtime_ms: 0, count: 0 } } } },
      { nowSec: now, observeSince: now - 10.2 * 86400, probeRetentionDays: 14 }
    );
    assert.equal(bar.pct_label, "10d");
    assert.equal(bar.uptime_pct, 100);
    assert.equal(bar.probe_spark_label, "14d");
  });

  it("uses outage/probe history not session start; null/<1d/30.0d edges", () => {
    const now = 2_000_000;
    const win = { windows: { "30d": { all: { downtime_pct: 2, downtime_ms: 1, count: 1 } } } };
    const restarted = honestUptimeBar(win, {
      nowSec: now,
      observeSince: now - 3600,
      firstOutageAt: now - 40 * 86400,
      probeRetentionDays: 14,
    });
    assert.equal(restarted.pct_label, "30d");
    assert.equal(restarted.probe_spark_label, "14d");
    assert.notEqual(restarted.probe_spark_label, "30d");

    assert.equal(
      honestUptimeBar({}, { nowSec: now, firstProbeAt: now - 10 * 86400 }).pct_label,
      "10d"
    );
    assert.equal(honestUptimeBar({}, { nowSec: now }).pct_label, null);
    assert.notEqual(honestUptimeBar({}, { nowSec: now }).pct_label, "30d");
    assert.equal(
      honestUptimeBar({}, { nowSec: now, firstProbeAt: now - 3600 }).pct_label,
      "<1d"
    );
    assert.equal(
      honestUptimeBar({}, { nowSec: now, firstProbeAt: now - 30 * 86400 }).pct_label,
      "30d"
    );
  });
});

describe("layer pills", () => {
  it("uses snapshot fields; fail_reason is not stored", () => {
    assert.equal(lastFailReason({ lan_ok: false }), null);
    assert.equal(formatHttpCertDays(null, "http://connectivitycheck.gstatic.com/generate_204"), "N/A (HTTP URL)");
    assert.equal(formatHttpCertDays(0, "http://example.com/"), "N/A (HTTP URL)");
    assert.equal(formatHttpCertDays(12, "https://example.com/"), "12");
    const tips = layerPillTips({
      lan_ok: true,
      wan_ok: false,
      dns_ok: null,
      http_ok: null,
      latency_ms: 12.4,
      failure_domain: "wan",
      last_probe_at: 1_700_000_000,
      http_cert_days: null,
      http_url: "http://example.com/generate_204",
      quality: { target: "1.1.1.1", loss_pct: 0, jitter_ms: 3 },
    });
    assert.match(tips.wan, /down/);
    assert.match(tips.wan, /Combined latency 12 ms \(not per-layer\)/);
    assert.match(tips.wan, /Failure domain: wan/);
    assert.match(tips.http, /N\/A \(HTTP URL\)/);
    assert.match(tips.lan, /Quality burst/);
    assert.doesNotMatch(JSON.stringify(tips), /fail_reason/);
  });
});
