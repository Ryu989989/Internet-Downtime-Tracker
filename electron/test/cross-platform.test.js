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
  parseNetshWlanInterfaces,
  emptyAdapter,
  fillWifiGaps,
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
      if (cmd === "iwconfig") {
        return [
          'wlan0     IEEE 802.11  ESSID:"home"',
          "          Mode:Managed  Frequency:5.18 GHz  Access Point: AA:BB:CC:DD:EE:FF",
          "          Bit Rate=866.7 Mb/s   Tx-Power=22 dBm",
          "          Link Quality=70/70  Signal level=-30 dBm",
        ].join("\n");
      }
      if (cmd === "ip" && args[0] === "link") {
        return "wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP>\n    link/ether 11:22:33:44:55:66 brd ff:ff:ff:ff:ff:ff";
      }
      return "";
    });
    const adapter = await getActiveAdapter();
    assert.equal(adapter.name, "wlan0");
    assert.equal(adapter.type, "wifi");
    assert.equal(adapter.signal, 100);
    assert.equal(adapter.ssid, "home");
    assert.equal(adapter.bssid, "aa:bb:cc:dd:ee:ff");
    assert.equal(adapter.band, "5");
    assert.equal(adapter.channel, 36);
    assert.equal(adapter.rssi, -30);
    assert.equal(adapter.tx_mbps, 866.7);
    assert.equal(adapter.rx_mbps, 866.7);
    assert.equal(adapter.mac, "11:22:33:44:55:66");
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
    assert.equal(adapter.ssid, null);
    assert.equal(adapter.bssid, null);
    assert.equal(adapter.band, null);
    assert.equal(adapter.channel, null);
    assert.equal(adapter.rssi, null);
    assert.equal(adapter.signal, null);
    assert.equal(adapter.tx_mbps, null);
    assert.equal(adapter.rx_mbps, null);
    assert.equal(adapter.mac, null);
  });

  it("getActiveAdapter parses Linux iw link when iwconfig absent", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
    setRunCmdForTest((cmd, args) => {
      if (cmd === "ip" && args[0] === "route" && args[1] === "get") return "1.1.1.1 via 192.168.1.1 dev wlan0 src 192.168.1.2 uid 0";
      if (cmd === "iwconfig") throw new Error("not found");
      if (cmd === "iw" && args && args[0] === "dev" && args[2] === "link") {
        return [
          "Connected to aa:bb:cc:dd:ee:ff (on wlan0)",
          "	SSID: cafe",
          "	freq: 2412",
          "	signal: -50 dBm",
          "	rx bitrate: 72.2 MBit/s",
          "	tx bitrate: 72.2 MBit/s",
        ].join("\n");
      }
      if (cmd === "iw" && args && args[0] === "dev" && args[2] === "info") {
        return [
          "Interface wlan0",
          "	addr 11:22:33:44:55:66",
          "	ssid cafe",
          "	channel 1 (2412 MHz), width: 20 MHz",
        ].join("\n");
      }
      if (cmd === "ip" && args[0] === "link") {
        return "wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP>\n    link/ether 11:22:33:44:55:66 brd ff:ff:ff:ff:ff:ff";
      }
      return "";
    });
    const adapter = await getActiveAdapter();
    assert.equal(adapter.name, "wlan0");
    assert.equal(adapter.type, "wifi");
    assert.equal(adapter.ssid, "cafe");
    assert.equal(adapter.bssid, "aa:bb:cc:dd:ee:ff");
    assert.equal(adapter.band, "2.4");
    assert.equal(adapter.channel, 1);
    assert.equal(adapter.rssi, -50);
    assert.equal(adapter.tx_mbps, 72.2);
    assert.equal(adapter.rx_mbps, 72.2);
    assert.equal(adapter.mac, "11:22:33:44:55:66");
  });

  it("getActiveAdapter parses Windows netsh wlan interfaces", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true, configurable: true });
    const wlan = [
      "There is 1 interface on the system:",
      "",
      "    Name                   : Wi-Fi",
      "    Description            : Intel(R) Wi-Fi 6 AX201",
      "    Physical address       : 00:11:22:33:44:55",
      "    State                  : connected",
      "    SSID                   : home",
      "    BSSID                  : aa:bb:cc:dd:ee:ff",
      "    Radio type             : 802.11ax",
      "    Band                   : 5 GHz",
      "    Channel                : 44",
      "    Receive rate (Mbps)    : 1201",
      "    Transmit rate (Mbps)   : 1201",
      "    Signal                 : 85%",
      "    Authentication         : WPA2-Personal",
      "    Cipher                 : CCMP",
    ].join("\n");
    setRunCmdForTest((cmd) => {
      if (cmd === "powershell") {
        return JSON.stringify({
          name: "Wi-Fi",
          type: "Intel(R) Wi-Fi 6 AX201",
          media: "Native 802.11",
          mac: "00-11-22-33-44-55",
          wlan,
        });
      }
      return "";
    });
    const adapter = await getActiveAdapter();
    assert.equal(adapter.name, "Wi-Fi");
    assert.equal(adapter.type, "wifi");
    assert.equal(adapter.signal, 85);
    assert.equal(adapter.ssid, "home");
    assert.equal(adapter.bssid, "aa:bb:cc:dd:ee:ff");
    assert.equal(adapter.band, "5");
    assert.equal(adapter.channel, 44);
    assert.equal(adapter.rssi, null);
    assert.equal(adapter.tx_mbps, 1201);
    assert.equal(adapter.rx_mbps, 1201);
    assert.equal(adapter.mac, "00:11:22:33:44:55");
    assert.equal(adapter.radio_type, "802.11ax");
    assert.equal(adapter.state, "connected");
    assert.equal(adapter.auth, "WPA2-Personal");
    assert.equal(adapter.cipher, "CCMP");
  });

  it("parseNetshWlanInterfaces reads disconnected state", () => {
    const parsed = parseNetshWlanInterfaces(
      [
        "    Name                   : Wi-Fi",
        "    State                  : disconnected",
        "    Radio type             : 802.11ac",
        "    Authentication         : WPA2-Personal",
        "    Cipher                 : CCMP",
        "    Signal                 : 0%",
      ].join("\n")
    );
    assert.equal(parsed.state, "disconnected");
    assert.equal(parsed.radio_type, "802.11ac");
    assert.equal(parsed.auth, "WPA2-Personal");
    assert.equal(parsed.cipher, "CCMP");
    assert.equal(parsed.signal, 0);
    assert.equal(parsed.rssi, null);
  });

  it("parseNetshWlanInterfaces parses explicit RSSI dBm and not percent", () => {
    const fromRssiField = parseNetshWlanInterfaces(
      ["    Name : Wi-Fi", "    State : connected", "    RSSI : -55", "    Signal : 85%"].join("\n")
    );
    assert.equal(fromRssiField.signal, 85);
    assert.equal(fromRssiField.rssi, -55);

    const fromSignalDbm = parseNetshWlanInterfaces(
      ["    Name : Wi-Fi", "    State : connected", "    Signal : -55 dBm"].join("\n")
    );
    assert.equal(fromSignalDbm.rssi, -55);

    const fromSignalLevel = parseNetshWlanInterfaces(
      ["    Name : Wi-Fi", "    State : connected", "    Signal level=-55 dBm"].join("\n")
    );
    assert.equal(fromSignalLevel.rssi, -55);

    const percentOnly = parseNetshWlanInterfaces(
      ["    Name : Wi-Fi", "    State : connected", "    Signal : 85%"].join("\n")
    );
    assert.equal(percentOnly.signal, 85);
    assert.equal(percentOnly.rssi, null);
  });

  it("parseNetshWlanInterfaces prefers a connected interface block", () => {
    const parsed = parseNetshWlanInterfaces(
      [
        "    Name                   : Wi-Fi 2",
        "    State                  : disconnected",
        "    SSID                   : old",
        "    Radio type             : 802.11n",
        "",
        "    Name                   : Wi-Fi",
        "    State                  : connected",
        "    SSID                   : home",
        "    Radio type             : 802.11ax",
        "    Authentication         : WPA3-Personal",
        "    Cipher                 : GCMP",
        "    Signal                 : 85%",
      ].join("\n")
    );
    assert.equal(parsed.state, "connected");
    assert.equal(parsed.ssid, "home");
    assert.equal(parsed.radio_type, "802.11ax");
    assert.equal(parsed.auth, "WPA3-Personal");
    assert.equal(parsed.cipher, "GCMP");
    assert.equal(parsed.signal, 85);
    assert.equal(parsed.rssi, null);
  });

  it("emptyAdapter includes wifi state fields as null", () => {
    const a = emptyAdapter();
    assert.equal(a.state, null);
    assert.equal(a.radio_type, null);
    assert.equal(a.auth, null);
    assert.equal(a.cipher, null);
  });

  it("fillWifiGaps copies wifi state radio auth cipher", () => {
    const target = emptyAdapter();
    fillWifiGaps(target, {
      state: "connected",
      radio_type: "802.11ax",
      auth: "WPA2-Personal",
      cipher: "CCMP",
      ssid: "home",
    });
    assert.equal(target.state, "connected");
    assert.equal(target.radio_type, "802.11ax");
    assert.equal(target.auth, "WPA2-Personal");
    assert.equal(target.cipher, "CCMP");
    assert.equal(target.ssid, "home");
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
