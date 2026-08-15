"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  parseTraceroute,
  tracerouteArgs,
  tracerouteHost,
  setRunTracerouteForTest,
  resetRunTracerouteForTest,
  MAX_HOPS,
} = require("../traceroute");

afterEach(() => {
  resetRunTracerouteForTest();
});

const SAMPLE = `
Tracing route to 192.168.1.1 over a maximum of 15 hops

  1    <1 ms    <1 ms    <1 ms  192.168.1.1
  2     *        *        *     Request timed out.
  3    12 ms    11 ms    13 ms  10.0.0.1

Trace complete.
`;

describe("traceroute.js (not netcheck)", () => {
  it("parses tracert hops and honors hop cap", async () => {
    const hops = parseTraceroute(SAMPLE);
    assert.equal(hops.length, 3);
    assert.equal(hops[0].hop, 1);
    assert.equal(hops[0].ip, "192.168.1.1");
    assert.equal(hops[0].rtt_ms, 1);
    assert.equal(hops[0].timeout, false);
    assert.equal(hops[1].timeout, true);
    assert.equal(hops[1].ip, null);
    assert.equal(hops[2].ip, "10.0.0.1");

    const { cmd, args } = tracerouteArgs("192.168.1.1", { maxHops: 15, hopTimeoutMs: 2000 });
    assert.ok(cmd === "tracert" || cmd === "traceroute");
    assert.ok(args.includes("15") || args.includes("-h") || args.includes("-m"));
    assert.equal(MAX_HOPS, 15);

    setRunTracerouteForTest(async (_cmd, a) => {
      assert.ok(a.includes("192.168.1.1"));
      return { stdout: SAMPLE };
    });
    const r = await tracerouteHost("192.168.1.1", { maxHops: 2 });
    assert.equal(r.ok, true);
    assert.equal(r.hop_limit, 2);
    assert.equal(r.hops.length, 2);

    setRunTracerouteForTest(async () => {
      throw new Error("must not spawn traceroute for public/v6");
    });
    const pub = await tracerouteHost("8.8.8.8");
    assert.equal(pub.ok, false);
    assert.match(pub.error, /private\/local/i);
    assert.deepEqual(pub.hops, []);
    const v6pub = await tracerouteHost("2001:4860:4860::8888");
    assert.equal(v6pub.ok, false);
    assert.match(v6pub.error, /private\/local/i);
    const v6ula = await tracerouteHost("fd12:3456:789a::1");
    assert.equal(v6ula.ok, false);

    const netcheck = fs.readFileSync(path.join(__dirname, "..", "netcheck.js"), "utf8");
    assert.doesNotMatch(netcheck, /tracerouteHost/);
    assert.doesNotMatch(netcheck, /tracert/);
    const exported = require("../netcheck");
    assert.equal(typeof exported.pingHost, "function");
    assert.equal(exported.tracerouteHost, undefined);
  });
});
