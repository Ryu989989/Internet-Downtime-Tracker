"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyWlanEvent,
  detectHostNicRoam,
  eventsToChronicle,
  correlateVerdict,
} = require("../wifi-chronicle");

describe("classifyWlanEvent", () => {
  it("maps 8003 EventData Reason to disconnect reason_text/code", () => {
    const ev = classifyWlanEvent({
      id: 8003,
      eventData: {
        Reason: "3",
        ReasonCode: "3",
        SSID: "HomeNet",
        BSSID: "aa:bb:cc:dd:ee:01",
      },
      message: "WLAN disconnected because the network went away",
      time: 1_700_000_100,
      source: "WLAN",
    });
    assert.equal(ev.kind, "disconnect");
    assert.equal(ev.reason_code, "3");
    assert.equal(ev.reason_text, "3");
    assert.equal(ev.ssid, "HomeNet");
    assert.equal(ev.bssid, "aa:bb:cc:dd:ee:01");
    assert.equal(ev.event_id, 8003);
    assert.equal(ev.at, 1_700_000_100);
    assert.equal(ev.source, "WLAN");
  });

  it("maps Kernel-Power 42 to sleep", () => {
    const ev = classifyWlanEvent({
      id: 42,
      eventData: {},
      message: "The system is entering sleep",
      time: 1_700_000_200,
      source: "Kernel-Power",
    });
    assert.equal(ev.kind, "sleep");
    assert.equal(ev.event_id, 42);
    assert.equal(ev.source, "Kernel-Power");
  });
});

describe("detectHostNicRoam", () => {
  it("returns roam when BSSID changes on the same SSID", () => {
    const roam = detectHostNicRoam(
      { at: 100, ssid: "HomeNet", bssid: "AA-BB-CC-DD-EE-01" },
      { at: 130, ssid: "HomeNet", bssid: "AA-BB-CC-DD-EE-02" }
    );
    assert.ok(roam);
    assert.equal(roam.kind, "roam");
    assert.equal(roam.source, "host_nic");
    assert.equal(roam.at, 130);
    assert.equal(roam.ssid, "HomeNet");
    assert.equal(roam.bssid_from, "AA-BB-CC-DD-EE-01");
    assert.equal(roam.bssid_to, "AA-BB-CC-DD-EE-02");
  });

  it("returns null when BSSID is unchanged", () => {
    const roam = detectHostNicRoam(
      { at: 100, ssid: "HomeNet", bssid: "aa:bb:cc:dd:ee:01" },
      { at: 130, ssid: "HomeNet", bssid: "AA-BB-CC-DD-EE-01" }
    );
    assert.equal(roam, null);
  });
});

describe("eventsToChronicle", () => {
  it("coalesces 8003 then 8001 with different BSSID within 15s into one roam not two disconnects", () => {
    const rows = eventsToChronicle([
      {
        id: 8003,
        eventData: { SSID: "HomeNet", BSSID: "aa:bb:cc:dd:ee:01" },
        message: "disconnected",
        time: 1000,
        source: "WLAN",
      },
      {
        id: 8001,
        eventData: { SSID: "HomeNet", BSSID: "aa:bb:cc:dd:ee:02" },
        message: "connected",
        time: 1008,
        source: "WLAN",
      },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "roam");
    assert.notEqual(rows[0].kind, "disconnect");
    assert.equal(rows[0].bssid_from, "aa:bb:cc:dd:ee:01");
    assert.equal(rows[0].bssid_to, "aa:bb:cc:dd:ee:02");
    assert.ok(!rows.some((r) => r.kind === "disconnect"));
  });
});

describe("correlateVerdict", () => {
  it("lan outage plus 8003 with routerWanOk true is this PC Wi-Fi", () => {
    const v = correlateVerdict({
      lanOutage: { type: "lan", started_at: 100, ended_at: 200 },
      wanOutage: null,
      wlanEvents: [{ kind: "disconnect", at: 120, event_id: 8003, source: "WLAN" }],
      routerWanOk: true,
      peersOnlineDuring: null,
    });
    assert.equal(v.code, "this_pc_wifi");
    assert.equal(v.label, "This PC Wi-Fi");
    assert.ok(Array.isArray(v.evidence));
  });

  it("wanOutage with no lan outage and routerWanOk false is ISP", () => {
    const v = correlateVerdict({
      lanOutage: null,
      wanOutage: { type: "wan", started_at: 100, ended_at: 200 },
      wlanEvents: [],
      routerWanOk: false,
      peersOnlineDuring: null,
    });
    assert.equal(v.code, "isp");
    assert.equal(v.label, "ISP / WAN");
  });

  it("sleep overlapping the outage wins", () => {
    const v = correlateVerdict({
      lanOutage: { type: "lan", started_at: 100, ended_at: 200 },
      wanOutage: null,
      wlanEvents: [{ kind: "sleep", at: 150, event_id: 42, source: "Kernel-Power" }],
      routerWanOk: true,
      peersOnlineDuring: true,
    });
    assert.equal(v.code, "sleep");
    assert.equal(v.label, "Sleep / resume");
  });

  it("unknown evidence mentions unproven ISP", () => {
    const v = correlateVerdict({
      lanOutage: { type: "lan", started_at: 100, ended_at: 200 },
      wanOutage: null,
      wlanEvents: [],
      routerWanOk: null,
      peersOnlineDuring: null,
    });
    assert.equal(v.code, "unknown");
    assert.equal(v.label, "Unknown");
    const blob = (v.evidence || []).join(" ");
    assert.match(blob, /unproven/i);
    assert.match(blob, /router poll|other devices/i);
  });
});
