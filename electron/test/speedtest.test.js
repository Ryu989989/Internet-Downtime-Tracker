"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseSpeedtestJson, bandwidthToMbps } = require("../speedtest");

describe("bandwidthToMbps", () => {
  it("converts bytes/sec to Mbps", () => {
    assert.equal(bandwidthToMbps(12_500_000), 100);
    assert.equal(bandwidthToMbps(null), null);
  });
});

describe("parseSpeedtestJson", () => {
  it("extracts metrics from Ookla CLI JSON", () => {
    const sample = {
      timestamp: "2026-07-31T15:00:00Z",
      ping: { jitter: 1.25, latency: 12.5 },
      download: { bandwidth: 25_000_000, bytes: 1, elapsed: 1 },
      upload: { bandwidth: 5_000_000, bytes: 1, elapsed: 1 },
      packetLoss: 0.1,
      isp: "Example ISP",
      server: { id: 1234, name: "City Fiber", location: "Austin, TX" },
      result: { url: "https://www.speedtest.net/result/c/abc" },
    };
    const row = parseSpeedtestJson(sample);
    assert.equal(row.download_mbps, 200);
    assert.equal(row.upload_mbps, 40);
    assert.equal(row.ping_ms, 12.5);
    assert.equal(row.jitter_ms, 1.25);
    assert.equal(row.packet_loss, 0.1);
    assert.equal(row.server_name, "City Fiber");
    assert.equal(row.server_id, "1234");
    assert.equal(row.isp, "Example ISP");
    assert.ok(row.result_url.includes("speedtest.net"));
    assert.ok(row.tested_at > 0);
  });

  it("tolerates missing packet loss", () => {
    const row = parseSpeedtestJson({
      download: { bandwidth: 1_000_000 },
      upload: { bandwidth: 500_000 },
      ping: { latency: 5, jitter: 0.5 },
      packetLoss: "Not available",
      server: {},
    });
    assert.equal(row.packet_loss, null);
    assert.equal(row.download_mbps, 8);
  });
});
