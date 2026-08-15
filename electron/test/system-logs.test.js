"use strict";

const { describe, it, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  mergeGaps,
  eventsToGaps,
  normalizeRawEvents,
  classifyEvent,
  scanWindowsLogs,
  setRunPowerShellForTest,
  resetRunPowerShellForTest,
} = require("../system-logs");

describe("classifyEvent", () => {
  it("maps known disconnect/connect ids", () => {
    assert.equal(classifyEvent(10001), "disconnect");
    assert.equal(classifyEvent(8003), "disconnect");
    assert.equal(classifyEvent(10000), "connect");
    assert.equal(classifyEvent(8001), "connect");
    assert.equal(classifyEvent(9999), null);
  });
});

describe("mergeGaps", () => {
  it("merges overlapping and adjacent intervals", () => {
    const merged = mergeGaps(
      [
        { started_at: 100, ended_at: 200, source: "A", reason: "down" },
        { started_at: 180, ended_at: 250, source: "B", reason: "wifi" },
        { started_at: 250 + 30, ended_at: 400, source: "A", reason: "again" }, // within 60s adjacency
      ],
      { adjacencyMs: 60_000 }
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].started_at, 100);
    assert.equal(merged[0].ended_at, 400);
    assert.equal(merged[0].duration_ms, 300_000);
  });

  it("keeps separate gaps beyond adjacency", () => {
    const merged = mergeGaps(
      [
        { started_at: 100, ended_at: 200 },
        { started_at: 400, ended_at: 500 },
      ],
      { adjacencyMs: 60_000 }
    );
    assert.equal(merged.length, 2);
  });
});

describe("eventsToGaps", () => {
  it("pairs disconnect→connect into intervals", () => {
    const gaps = eventsToGaps(
      [
        { time: 1000, kind: "disconnect", source: "WLAN", reason: "left AP" },
        { time: 1300, kind: "connect", source: "WLAN", reason: "joined" },
        { time: 2000, kind: "disconnect", source: "NetworkProfile", reason: "disc" },
        { time: 2100, kind: "connect", source: "NetworkProfile", reason: "up" },
      ],
      { nowSec: 3000 }
    );
    assert.equal(gaps.length, 2);
    assert.equal(gaps[0].started_at, 1000);
    assert.equal(gaps[0].ended_at, 1300);
    assert.equal(gaps[0].duration_ms, 300_000);
  });

  it("ignores extra disconnects while already open", () => {
    const gaps = eventsToGaps(
      [
        { time: 10, kind: "disconnect", source: "A", reason: "a" },
        { time: 20, kind: "disconnect", source: "B", reason: "b" },
        { time: 50, kind: "connect", source: "A", reason: "up" },
      ],
      { nowSec: 100 }
    );
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].started_at, 10);
    assert.equal(gaps[0].ended_at, 50);
  });
});

describe("normalizeRawEvents", () => {
  it("parses PowerShell-style event objects", () => {
    const events = normalizeRawEvents([
      {
        TimeCreated: "2026-07-31T15:00:00.000Z",
        Id: 10001,
        ProviderName: "Microsoft-Windows-NetworkProfile",
        Message: "Network disconnected",
        _sourceLabel: "NetworkProfile",
      },
      {
        TimeCreated: "/Date(1722438060000)/",
        Id: 10000,
        ProviderName: "Microsoft-Windows-NetworkProfile",
        Message: "Network connected",
        _sourceLabel: "NetworkProfile",
      },
    ]);
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, "disconnect");
    assert.equal(events[1].kind, "connect");
    assert.ok(events[0].time > 0);
  });
});

describe("scanWindowsLogs soft-fail", () => {
  after(() => {
    resetRunPowerShellForTest();
  });

  it("returns empty gaps with warning when PowerShell fails", async () => {
    setRunPowerShellForTest(() => Promise.reject(new Error("PS unavailable")));
    const result = await scanWindowsLogs({ days: 1 });
    assert.deepEqual(result.gaps, []);
    assert.equal(result.count, 0);
    assert.ok(result.warnings.some((w) => /PS unavailable/i.test(w)));
  });
});

describe("scanWindowsLogs non-Windows gate", () => {
  let originalPlatform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true, configurable: true });
  });

  it("returns a graceful Windows-only warning on non-Windows platforms", async () => {
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
    const result = await scanWindowsLogs({ days: 1 });
    assert.equal(result.count, 0);
    assert.equal(result.event_count, 0);
    assert.ok(result.warnings.some((w) => /Windows/i.test(w)));
  });
});
