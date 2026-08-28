"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  parseNetshWlanNetworks,
  parseIwScan,
} = require("../wifi-nearby");

const NETSH = `
Interface name : Wi-Fi
There are 2 networks currently visible.

SSID 1 : Home
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : aa:bb:cc:dd:ee:ff
         Signal             : 80%
         Radio type         : 802.11ax
         Channel            : 44
    BSSID 2                 : 11:22:33:44:55:66
         Signal             : 40%
         Radio type         : 802.11n
         Channel            : 6

SSID 2 : Cafe
    Network type            : Infrastructure
    Authentication          : Open
    Encryption              : None
    BSSID 1                 : 01:02:03:04:05:06
         Signal             : 12%
         Radio type         : 802.11g
         Channel            : 1
`.trim();

const IW = `
BSS aa:bb:cc:dd:ee:ff(on wlan0)
        freq: 5180
        signal: -55.00 dBm
        SSID: Home
        RSN:     * Version: 1
BSS 11:22:33:44:55:66(on wlan0)
        freq: 2412
        signal: -70.00 dBm
        SSID: Cafe
`.trim();

describe("parseNetshWlanNetworks", () => {
  it("parses SSID/BSSID/channel/signal/security and does not invent dBm", () => {
    const rows = parseNetshWlanNetworks(NETSH);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].ssid, "Home");
    assert.equal(rows[0].bssid, "aa:bb:cc:dd:ee:ff");
    assert.equal(rows[0].channel, 44);
    assert.equal(rows[0].signal, 80);
    assert.equal(rows[0].rssi, null);
    assert.match(String(rows[0].security), /WPA2/i);
    assert.equal(rows[0].band, "5");
    assert.equal(rows[1].bssid, "11:22:33:44:55:66");
    assert.equal(rows[1].channel, 6);
    assert.equal(rows[1].band, "2.4");
    assert.equal(rows[2].ssid, "Cafe");
  });
});

describe("parseIwScan", () => {
  it("parses BSS blocks with dBm from iw, not from percent", () => {
    const rows = parseIwScan(IW);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ssid, "Home");
    assert.equal(rows[0].bssid, "aa:bb:cc:dd:ee:ff");
    assert.equal(rows[0].rssi, -55);
    assert.equal(rows[0].band, "5");
    assert.equal(rows[0].channel, 36);
    assert.equal(rows[1].ssid, "Cafe");
    assert.equal(rows[1].rssi, -70);
    assert.equal(rows[1].band, "2.4");
  });
});

describe("isolation", () => {
  it("monitor tick does not call nearby scan", () => {
    const monitor = fs.readFileSync(path.join(__dirname, "..", "monitor.js"), "utf8");
    assert.doesNotMatch(monitor, /wifi-nearby/);
    assert.doesNotMatch(monitor, /iw scan/);
    assert.doesNotMatch(monitor, /show networks/);
  });

  it("preload and main expose on-demand nearby IPC", () => {
    const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
    const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    assert.match(preload, /lanWifiNearby:/);
    assert.match(main, /safeHandle\("api:lan:wifi:nearby"/);
  });
});
