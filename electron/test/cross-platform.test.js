"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  setRunCmdForTest,
  resetRunCmdForTest,
  getDefaultGateway,
  getActiveAdapter,
} = require("../netcheck");
const { tracerouteArgs, parseTraceroute } = require("../traceroute");
const { dataDir } = require("../db");
const { parseUnixConnectionOutput, parseUnixAdapters, normalizeEndpoint } = require("../connections");
const { parseUnixNeighbors, runUnixGateway } = require("../lan-devices");

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

  it("dataDir uses platform-appropriate paths", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "idt-datadir-"));
    const originalHome = process.env.HOME;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const originalXdg = process.env.XDG_CONFIG_HOME;
    try {
      delete process.env.LOCALAPPDATA;
      delete process.env.XDG_CONFIG_HOME;
      process.env.HOME = tmpBase;

      Object.defineProperty(process, "platform", { value: "darwin", writable: true, configurable: true });
      assert.ok(dataDir().includes(path.join("Library", "Application Support")));

      Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
      assert.ok(dataDir().includes(path.join(".config")));

      process.env.XDG_CONFIG_HOME = path.join(tmpBase, "xdg");
      const linuxXdg = dataDir();
      assert.ok(linuxXdg.startsWith(process.env.XDG_CONFIG_HOME));

      Object.defineProperty(process, "platform", { value: "win32", writable: true, configurable: true });
      process.env.LOCALAPPDATA = path.join(tmpBase, "AppData", "Local");
      assert.ok(dataDir().startsWith(process.env.LOCALAPPDATA));
    } finally {
      process.env.HOME = originalHome;
      if (originalLocalAppData != null) process.env.LOCALAPPDATA = originalLocalAppData;
      else delete process.env.LOCALAPPDATA;
      if (originalXdg != null) process.env.XDG_CONFIG_HOME = originalXdg;
      else delete process.env.XDG_CONFIG_HOME;
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("parses ss -tunap output", () => {
    const sample = `Netid  State   Recv-Q  Send-Q  Local Address:Port  Peer Address:Port Process\n` +
      `tcp    ESTAB   0       0       192.168.1.2:54321   1.2.3.4:443    users:(["firefox",pid=1234])\n` +
      `udp    UNCONN  0       0       0.0.0.0:68         0.0.0.0:0\n`;
    const rows = parseUnixConnectionOutput(sample);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].proto, "TCP");
    assert.equal(rows[0].state, "Established");
    assert.equal(rows[0].process, "firefox");
    assert.equal(rows[0].pid, 1234);
  });

  it("parses lsof -i output", () => {
    const sample = `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n` +
      `sshd  123 root 4u IPv4 0x0 0t0 TCP 192.168.1.2:22->1.2.3.4:54321 (ESTABLISHED)\n`;
    const rows = parseUnixConnectionOutput(sample);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].proto, "TCP");
    assert.equal(rows[0].process, "sshd");
    assert.equal(rows[0].state, "ESTABLISHED");
  });

  it("normalizes endpoint wildcards", () => {
    assert.equal(normalizeEndpoint("*.*"), "0.0.0.0:*");
    assert.equal(normalizeEndpoint("0.0.0.0:22"), "0.0.0.0:22");
  });

  it("parses ip -s link adapter output", () => {
    const sample = `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536\n` +
      `    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n` +
      `    RX: bytes packets errors dropped 1 2 3 4\n` +
      `    1000 10 0 0 0 0 0 0\n` +
      `    TX: bytes packets errors dropped 1 2 3 4\n` +
      `    2000 20 0 0 0 0 0 0\n`;
    const adapters = parseUnixAdapters(sample);
    assert.equal(adapters.length, 1);
    assert.equal(adapters[0].name, "lo");
    assert.equal(adapters[0].rx_bytes, 1000);
    assert.equal(adapters[0].tx_bytes, 2000);
  });

  it("parses ip neigh / arp -an neighbor output", () => {
    const sample = `192.168.1.1 dev eth0 lladdr 00:11:22:33:44:55 REACHABLE\n` +
      `? (192.168.1.2) at 66:77:88:99:aa:bb on en0 [ethernet]\n`;
    const rows = parseUnixNeighbors(sample);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ip, "192.168.1.1");
    assert.equal(rows[0].mac, "00:11:22:33:44:55");
    assert.equal(rows[1].mac, "66:77:88:99:aa:bb");
  });
});
