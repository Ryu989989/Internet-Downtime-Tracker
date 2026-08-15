"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  setRunCmdForTest,
  resetRunCmdForTest,
  getDefaultGateway,
  getActiveAdapter,
} = require("../netcheck");
const { tracerouteArgs, parseTraceroute } = require("../traceroute");

describe("cross-platform parser and command builders", () => {
  let originalPlatform;

  beforeEach(() => {
    originalPlatform = process.platform;
    resetRunCmdForTest();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true, configurable: true });
    resetRunCmdForTest();
  });

  it("tracerouteArgs builds tracert on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true, configurable: true });
    const { cmd, args } = tracerouteArgs("1.1.1.1", { maxHops: 10, hopTimeoutMs: 1500 });
    assert.equal(cmd, "tracert");
    assert.ok(args.includes("-d"));
    assert.ok(args.includes("10"));
    assert.ok(args.includes("1500"));
  });

  it("tracerouteArgs builds traceroute on Linux", () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
    const { cmd, args } = tracerouteArgs("1.1.1.1", { maxHops: 10, hopTimeoutMs: 1500 });
    assert.equal(cmd, "traceroute");
    assert.ok(args.includes("-n"));
    assert.ok(args.includes("-m"));
    assert.ok(args.includes("10"));
  });

  it("parses Linux traceroute output", () => {
    const sample = `
      traceroute to 1.1.1.1 (1.1.1.1), 15 hops max, 60 byte packets
       1  192.168.1.1 (192.168.1.1)  1.234 ms  1.123 ms  1.045 ms
       2  10.0.0.1 (10.0.0.1)  12.345 ms  11.987 ms  13.210 ms
       3  * * *
    `;
    const hops = parseTraceroute(sample);
    assert.equal(hops.length, 3);
    assert.equal(hops[0].ip, "192.168.1.1");
    assert.equal(hops[1].ip, "10.0.0.1");
    assert.equal(hops[2].timeout, true);
  });

  it("getDefaultGateway parses Linux 'ip route' output", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
    setRunCmdForTest((cmd, args) => {
      if (cmd === "ip" && args[0] === "route" && args[1] === "show") {
        return "default via 192.168.1.1 dev eth0 proto dhcp metric 100";
      }
      return "";
    });
    const gw = await getDefaultGateway();
    assert.equal(gw, "192.168.1.1");
  });

  it("getDefaultGateway falls back to macOS route output", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true, configurable: true });
    setRunCmdForTest((cmd) => {
      if (cmd === "route") return "route to: default\n  gateway: 10.0.0.1";
      return "";
    });
    const gw = await getDefaultGateway();
    assert.equal(gw, "10.0.0.1");
  });

  it("getActiveAdapter parses Linux ip route + iwconfig", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
    setRunCmdForTest((cmd, args) => {
      if (cmd === "ip" && args[0] === "route" && args[1] === "get") return "1.1.1.1 via 192.168.1.1 dev wlan0 src 192.168.1.2 uid 0";
      if (cmd === "iwconfig") return "wlan0  IEEE 802.11  ESSID:\"home\"  \n          Link Quality=70/70  Signal level=-30 dBm";
      if (cmd === "ip" && args[0] === "link") return "wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP>";
      return "";
    });
    const adapter = await getActiveAdapter();
    assert.equal(adapter.name, "wlan0");
    assert.equal(adapter.type, "wifi");
    assert.equal(adapter.signal, 100);
  });

  it("getActiveAdapter falls back to ip link when iwconfig absent", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
    setRunCmdForTest((cmd, args) => {
      if (cmd === "ip" && args[0] === "route" && args[1] === "get") return "1.1.1.1 via 192.168.1.1 dev eth0 src 192.168.1.2 uid 0";
      if (cmd === "iwconfig") throw new Error("not found");
      if (cmd === "ip" && args[0] === "link" && args[1] === "show") return "eth0: <BROADCAST,MULTICAST,UP,LOWER_UP>";
      return "";
    });
    const adapter = await getActiveAdapter();
    assert.equal(adapter.name, "eth0");
    assert.equal(adapter.type, "ethernet");
  });
});
