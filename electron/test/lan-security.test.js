"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const metricsApi = require("../metrics-api");

const root = path.join(__dirname, "..");

describe("LAN IPC allowlist + isolation", () => {
  it("preload exposes lan methods only via idt", () => {
    const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
    assert.match(preload, /lanDevices:/);
    assert.match(preload, /lanDevicesPing:/);
    assert.match(preload, /lanDevicesTraceroute:/);
    assert.match(preload, /lanScan:/);
    assert.match(preload, /lanSnifferStart:/);
    assert.match(preload, /lanTopology:/);
    assert.doesNotMatch(preload, /require\("child_process"\)/);
  });

  it("main registers lan channels via safeHandle and no _tick coupling", () => {
    const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
    assert.match(main, /safeHandle\("api:lan:devices"/);
    assert.match(main, /safeHandle\("api:lan:devices:ping"/);
    assert.match(main, /safeHandle\("api:lan:devices:traceroute"/);
    assert.match(main, /safeHandle\("api:lan:scan"/);
    assert.match(main, /safeHandle\("api:lan:sniffer:start"/);
    assert.match(main, /safeHandle\("api:lan:topology"/);
    assert.match(main, /tracerouteDevice/);
    assert.doesNotMatch(main, /tracerouteHost/);
    const monitor = fs.readFileSync(path.join(root, "monitor.js"), "utf8");
    assert.doesNotMatch(monitor, /tracerouteHost/);
    assert.doesNotMatch(monitor, /pingDevice/);
    assert.doesNotMatch(monitor, /api:lan:devices:ping/);
    assert.doesNotMatch(monitor, /api:lan:devices:traceroute/);
    assert.doesNotMatch(monitor, /\bcheckHttp\b/);
    assert.doesNotMatch(monitor, /https\.request/);
    for (const mod of [
      "lan-devices",
      "lan-bridge",
      "traceroute",
      "usage-bridge",
      "connections",
      "snmp-topology",
      "packet-sniffer",
      "port-scan",
    ]) {
      assert.doesNotMatch(monitor, new RegExp(`require\\(["']\\./${mod}["']\\)`));
    }
    assert.doesNotMatch(monitor, /usage-bridge/);
    assert.doesNotMatch(monitor, /snmp-topology/);
    assert.doesNotMatch(monitor, /packet-sniffer/);
    assert.doesNotMatch(monitor, /port-scan/);
  });

  it("Prometheus listens on 127.0.0.1 only", async () => {
    metricsApi.setMetricsProvider(() => ({ devices_online: 1, outages_open: 0, outages_total: 0 }));
    const started = await metricsApi.startPrometheus(19108);
    assert.equal(started.host, "127.0.0.1");
    try {
      const body = await new Promise((resolve, reject) => {
        http
          .get("http://127.0.0.1:19108/metrics", (res) => {
            let d = "";
            res.on("data", (c) => (d += c));
            res.on("end", () => resolve(d));
          })
          .on("error", reject);
      });
      assert.match(body, /idt_devices_online/);
    } finally {
      metricsApi.stopPrometheus();
    }
  });

  it("HTTP API listens on 127.0.0.1 only and requires token", async () => {
    metricsApi.setApiProvider(() => ({ status: { ok: true }, devices: [], outages: [] }));
    const started = await metricsApi.startHttpApi(19109, "test-token");
    assert.equal(started.host, "127.0.0.1");
    try {
      const unauth = await new Promise((resolve, reject) => {
        http
          .get("http://127.0.0.1:19109/api/status", (res) => {
            resolve(res.statusCode);
          })
          .on("error", reject);
      });
      assert.equal(unauth, 401);
      const auth = await new Promise((resolve, reject) => {
        http
          .get(
            "http://127.0.0.1:19109/api/status",
            { headers: { Authorization: "Bearer test-token" } },
            (res) => {
              let d = "";
              res.on("data", (c) => (d += c));
              res.on("end", () => resolve({ code: res.statusCode, d }));
            }
          )
          .on("error", reject);
      });
      assert.equal(auth.code, 200);
      assert.match(auth.d, /"ok":true/);
    } finally {
      metricsApi.stopHttpApi();
    }
  });
});
