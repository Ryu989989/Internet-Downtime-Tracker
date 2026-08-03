"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  outagesToCsv,
  buildEvidenceCsv,
  buildHtmlReport,
  uptimePct,
} = require("../export");
const { classifyDomain, parseWanTargets, checkDns, checkHttp } = require("../netcheck");

describe("classifyDomain / parseWanTargets", () => {
  it("classifies hierarchical failure domains", () => {
    assert.equal(classifyDomain({ lan_ok: false, wan_ok: false }), "lan");
    assert.equal(classifyDomain({ lan_ok: true, wan_ok: false }), "wan");
    assert.equal(
      classifyDomain({ lan_ok: true, wan_ok: true, dns_ok: false }),
      "dns"
    );
    assert.equal(
      classifyDomain({ lan_ok: true, wan_ok: true, dns_ok: true, http_ok: false }),
      "http"
    );
    assert.equal(
      classifyDomain({ lan_ok: true, wan_ok: true, dns_ok: true, http_ok: true }),
      null
    );
  });

  it("parses WAN target strings", () => {
    assert.deepEqual(parseWanTargets("1.1.1.1:443,8.8.8.8:53"), [
      ["1.1.1.1", 443],
      ["8.8.8.8", 53],
    ]);
  });
});

describe("DNS/HTTP helpers", () => {
  it("checkDns times out against unreachable resolver", async () => {
    const [ok, lat] = await checkDns({
      resolver: "240.0.0.1",
      name: "example.com",
      timeoutMs: 400,
    });
    assert.equal(ok, false);
    assert.equal(lat, null);
  });

  it("checkHttp times out against closed local port", async () => {
    const [ok, lat] = await checkHttp({
      url: "http://127.0.0.1:1/",
      timeoutMs: 400,
    });
    assert.equal(ok, false);
    assert.equal(lat, null);
  });
});

describe("export CSV / HTML", () => {
  it("emits CSV rows for outages and speed tests", () => {
    const csv = buildEvidenceCsv({
      now: 1_700_000_100,
      outages: [
        {
          id: 1,
          type: "wan",
          started_at: 1_700_000_000,
          ended_at: 1_700_000_060,
          duration_ms: 60000,
          notes: 'said "down"',
        },
      ],
      speedTests: [
        {
          id: 9,
          tested_at: 1_700_000_090,
          download_mbps: 100,
          upload_mbps: 20,
          ping_ms: 12,
          jitter_ms: 1,
          packet_loss: 0,
          isp: "Example ISP",
          server_name: "City",
          server_location: "TX",
          result_url: null,
        },
      ],
    });
    assert.match(csv, /# outages/);
    assert.match(csv, /wan/);
    assert.match(csv, /said ""down""/);
    assert.match(csv, /# speed_tests/);
    assert.match(csv, /Example ISP/);
    assert.equal(uptimePct(2.5), 97.5);
  });

  it("HTML report includes domain windows and provider", () => {
    const html = buildHtmlReport({
      now: 1_700_000_100,
      summary: {
        windows: {
          "24h": {
            all: { downtime_ms: 60000, downtime_pct: 0.069, count: 1 },
            lan: { downtime_ms: 0, count: 0 },
            wan: { downtime_ms: 60000, count: 1 },
            dns: { downtime_ms: 0, count: 0 },
            http: { downtime_ms: 0, count: 0 },
          },
          "7d": { all: { downtime_ms: 0, downtime_pct: 0, count: 0 } },
          "30d": { all: { downtime_ms: 0, downtime_pct: 0, count: 0 } },
        },
        longest: [],
        provider: { isp: "Example ISP", server_name: "City", ping_ms: 12 },
      },
      outages: [
        {
          id: 1,
          type: "dns",
          started_at: 1_700_000_000,
          ended_at: 1_700_000_030,
          duration_ms: 30000,
          notes: "resolver blip",
        },
      ],
    });
    assert.match(html, /Example ISP/);
    assert.match(html, /DNS/);
    assert.match(html, /resolver blip/);
    assert.match(html, /Uptime summary/);
  });

  it("outagesToCsv marks open rows", () => {
    const csv = outagesToCsv(
      [{ id: 2, type: "lan", started_at: 1_700_000_000, ended_at: null, notes: null }],
      { now: 1_700_000_010 }
    );
    assert.match(csv, /,1\r?\n$/);
  });

  it("escapes notes with commas, quotes, and newlines", () => {
    const csv = outagesToCsv([
      {
        id: 3,
        type: "http",
        started_at: 1_700_000_000,
        ended_at: 1_700_000_030,
        duration_ms: 30000,
        notes: 'line1, "quoted"\nline2',
      },
    ]);
    assert.match(csv, /"line1, ""quoted""\nline2"/);
  });
});
