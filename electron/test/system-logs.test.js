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
  QUERY_SPECS,
  clearCache,
  getCached,
  MAX_EVENTS,
} = require("../system-logs");

describe("classifyEvent", () => {
  it("maps known disconnect/connect ids", () => {
    assert.equal(classifyEvent(10001), "disconnect");
    assert.equal(classifyEvent(8003), "disconnect");
    assert.equal(classifyEvent(10000), "connect");
    assert.equal(classifyEvent(8001), "connect");
    assert.equal(classifyEvent(9999), null);
  });

  it("maps expanded WLAN, fail, sleep, and Kernel-Power ids", () => {
    assert.equal(classifyEvent(8000), "connect");
    assert.equal(classifyEvent(8002), "connect");
    assert.equal(classifyEvent(11000), "connect");
    assert.equal(classifyEvent(11001), "connect");
    assert.equal(classifyEvent(11005), "connect");
    assert.equal(classifyEvent(107), "connect");
    assert.equal(classifyEvent(11004), "disconnect");
    assert.equal(classifyEvent(11002), "fail");
    assert.equal(classifyEvent(11006), "fail");
    assert.equal(classifyEvent(42), "sleep");
  });
});

describe("QUERY_SPECS", () => {
  it("includes expanded WLAN ids and Kernel-Power 42/107", () => {
    const wlan = QUERY_SPECS.find((s) => s.label === "WLAN");
    assert.ok(wlan);
    for (const id of [8000, 8001, 8002, 8003, 11000, 11001, 11002, 11004, 11005, 11006, 12013]) {
      assert.ok(wlan.ids.includes(id), `missing WLAN id ${id}`);
    }
    const kp = QUERY_SPECS.find((s) => s.label === "Kernel-Power");
    assert.ok(kp);
    assert.equal(kp.log, "System");
    assert.deepEqual(kp.ids, [42, 107]);
    assert.ok(kp.providers.includes("Microsoft-Windows-Kernel-Power"));
    assert.ok(QUERY_SPECS.some((s) => s.label === "NetworkProfile"));
    assert.ok(QUERY_SPECS.some((s) => s.label === "System/NIC"));
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

  it("ignores fail events so they do not open or close gaps", () => {
    const gaps = eventsToGaps(
      [
        { time: 10, kind: "fail", source: "WLAN", reason: "auth failed" },
        { time: 20, kind: "connect", source: "WLAN", reason: "up" },
      ],
      { nowSec: 100 }
    );
    assert.equal(gaps.length, 0);
  });

  it("does not treat Kernel-Power sleep as a Wi-Fi disconnect gap", () => {
    const gaps = eventsToGaps(
      [
        { time: 10, kind: "sleep", source: "Kernel-Power", reason: "sleep" },
        { time: 50, kind: "connect", source: "Kernel-Power", reason: "resume" },
      ],
      { nowSec: 100 }
    );
    assert.equal(gaps.length, 0);
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

  it("keeps EventData through normalizeRawEvents", () => {
    const eventData = { Reason: "3", SSID: "HomeNet", BSSId: "aa:bb:cc:dd:ee:ff" };
    const events = normalizeRawEvents([
      {
        TimeCreated: "2026-07-31T15:00:00.000Z",
        Id: 8003,
        ProviderName: "Microsoft-Windows-WLAN-AutoConfig",
        Message: "disconnected",
        _sourceLabel: "WLAN",
        EventData: eventData,
      },
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "disconnect");
    assert.deepEqual(events[0].eventData, eventData);
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

describe("scanWindowsLogs EventData script and events array", () => {
  afterEach(() => {
    resetRunPowerShellForTest();
  });

  it("clips messages at 800 not 200", async () => {
    let captured = "";
    setRunPowerShellForTest(async (script) => {
      captured = script;
      return { stdout: "[]", stderr: "" };
    });
    await scanWindowsLogs({ from: 1, to: 2 });
    assert.match(captured, /\$msg\.Length -gt 800/);
    assert.doesNotMatch(captured, /\$msg\.Length -gt 200/);
    assert.match(captured, /EventData/);
  });

  it("returns a normalized events array", async () => {
    setRunPowerShellForTest(async () => ({
      stdout: JSON.stringify([
        {
          TimeCreated: "2026-07-31T15:00:00.000Z",
          Id: 8003,
          ProviderName: "Microsoft-Windows-WLAN-AutoConfig",
          Message: "disconnected",
          _sourceLabel: "WLAN",
          EventData: { Reason: "3", SSID: "HomeNet" },
        },
      ]),
      stderr: "",
    }));
    const result = await scanWindowsLogs({ from: 1, to: 1_800_000_000 });
    assert.ok(Array.isArray(result.events));
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].kind, "disconnect");
    assert.deepEqual(result.events[0].eventData, { Reason: "3", SSID: "HomeNet" });
  });

  it("skipCache leaves the UI cache in place; events are capped", async () => {
    assert.equal(MAX_EVENTS, 500);
    clearCache();
    let n = 0;
    setRunPowerShellForTest(async () => {
      n += 1;
      return {
        stdout: JSON.stringify([
          {
            TimeCreated: "2026-07-31T15:00:00.000Z",
            Id: 8003,
            ProviderName: "Microsoft-Windows-WLAN-AutoConfig",
            Message: n === 1 ? "first-scan" : "second-scan",
            _sourceLabel: "WLAN",
            EventData: { Reason: "3" },
          },
        ]),
        stderr: "",
      };
    });
    await scanWindowsLogs({ from: 1, to: 1_800_000_000 });
    await scanWindowsLogs({ from: 100, to: 200, skipCache: true });
    const hit = getCached({ from: 1, to: 1_800_000_000 });
    assert.ok(hit);
    assert.ok(hit.cached);
    assert.match(String(hit.events[0].reason), /first-scan/);
    clearCache();
  });
});
