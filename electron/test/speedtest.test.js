"use strict";

const { describe, it, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { parseSpeedtestJson, bandwidthToMbps, runCli, cancelRun, getStatus, verifyOfficialZip, isTrustedCliPath } = require("../speedtest");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

describe("runCli cancel lifecycle", () => {
  it("blocks overlap until child closes and rejects with CANCELLED", async () => {
    const node = process.execPath;
    const script = "setInterval(()=>{}, 1000)";
    const run = runCli(node, ["-e", script], 60_000);
    await new Promise((r) => setImmediate(r));
    const status = await getStatus(os.tmpdir());
    assert.equal(status.running, true);
    assert.equal(cancelRun().cancelled, true);
    await assert.rejects(
      () => runCli(node, ["-e", "process.exit(0)"], 5000),
      /already running/
    );
    await assert.rejects(run, (err) => err.code === "CANCELLED");
    const done = await runCli(node, ["-e", "process.exit(0)"], 5000);
    assert.equal(done.code, 0);
  });
});

describe("verifyOfficialZip happy path", () => {
  it("accepts file matching injected pin", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-zip-ok-"));
    const file = path.join(dir, "ok.zip");
    const payload = Buffer.from("fixture-zip-bytes");
    fs.writeFileSync(file, payload);
    const pin = crypto.createHash("sha256").update(payload).digest("hex");
    assert.equal(verifyOfficialZip(file, pin), pin);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("isTrustedCliPath cross-platform", () => {
  let originalPlatform;
  const homedir = require("os").homedir();

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true, configurable: true });
  });

  it("accepts system PATH roots on macOS and Linux", () => {
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", writable: true, configurable: true });
    assert.equal(isTrustedCliPath("/usr/local/bin/speedtest", "/tmp/idt"), true);
    Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
    assert.equal(isTrustedCliPath("/opt/local/bin/speedtest", "/tmp/idt"), true);
    assert.equal(isTrustedCliPath("/home/bad/../bin/speedtest", "/tmp/idt"), false);
    assert.equal(isTrustedCliPath("/usr/local/bin/notspeedtest", "/tmp/idt"), false);
  });

  it("rejects path traversal on Windows", () => {
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true, configurable: true });
    assert.equal(isTrustedCliPath("C:\\Program Files\\Speedtest CLI\\..\\..\\Windows\\speedtest.exe", "C:\\idt"), false);
    assert.equal(isTrustedCliPath("C:\\Program Files\\Speedtest CLI\\speedtest.exe", "C:\\idt"), true);
  });
});
