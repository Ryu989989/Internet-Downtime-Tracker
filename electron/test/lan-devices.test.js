"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseSnapshot,
  shapeNeighbor,
  buildNeighborScript,
  formatPowerShellFailure,
  setRunPowerShellForTest,
  resetRunPowerShellForTest,
} = require("../lan-devices");
const { lookupOui, formatMac, normalizeMac } = require("../oui");
const { buildMagicPacket } = require("../wol");
const { isPrivateOrLocalIp, matchCves, loadCveDb } = require("../port-scan");
const { prefixHosts, MIN_INTERVAL_MIN } = require("../subnet-discovery");
const {
  normalizeWebhookUrl,
  parseQuietHours,
  inQuietHours,
  clearDigestForTest,
} = require("../notify-webhooks");
const { renderPrometheus, BIND_HOST } = require("../metrics-api");
const { buildPayload, renderTemplate } = require("../router-webhooks");
const packetSniffer = require("../packet-sniffer");
const { isPrivateIpv4 } = require("../snmp-topology");
const { lanDevicesToCsv, lanDevicesToJson } = require("../export");

afterEach(() => {
  resetRunPowerShellForTest();
  clearDigestForTest();
  packetSniffer.clear();
  packetSniffer.stop({ force: true });
});

describe("OUI / MAC", () => {
  it("normalizes and looks up vendors", () => {
    assert.equal(formatMac("b8-27-eb-11-22-33"), "B8:27:EB:11:22:33");
    assert.equal(lookupOui("B8:27:EB:00:00:01"), "Raspberry Pi");
    assert.equal(normalizeMac("aa:bb:cc"), "AABBCC");
  });
});

describe("LAN devices snapshot", () => {
  it("builds neighbor script without ConvertFrom-Json roundtrip", () => {
    const script = buildNeighborScript();
    assert.match(script, /Get-NetNeighbor/);
    assert.match(script, /ConvertTo-Json/);
    assert.doesNotMatch(script, /ConvertFrom-Json/);
    assert.match(script, /\[Console\]::Error\.WriteLine/);
  });

  it("shapes rows and skips multicast", () => {
    const row = shapeNeighbor(
      { ip: "192.168.1.10", mac: "B8-27-EB-01-02-03", state: "Reachable" },
      "192.168.1.1",
      1000
    );
    assert.equal(row.ip, "192.168.1.10");
    assert.equal(row.gateway, false);
    assert.equal(row.vendor, "Raspberry Pi");
    assert.equal(
      shapeNeighbor({ ip: "224.0.0.251", mac: "01-00-5E-00-00-FB", state: "Permanent" }, null, 1),
      null
    );
  });

  it("parses gateway + neighbors JSON", () => {
    const snap = parseSnapshot(
      JSON.stringify({
        gateway: "192.168.1.1",
        neighbors: [
          { ip: "192.168.1.1", mac: "001122334455", state: "Reachable" },
          { ip: "192.168.1.20", mac: "AABBCCDDEEFF", state: "Stale" },
        ],
      })
    );
    assert.equal(snap.gateway, "192.168.1.1");
    assert.equal(snap.devices.length, 2);
    assert.ok(snap.devices.some((d) => d.gateway));
  });

  it("unwraps PowerShell value/Count array wrapper", () => {
    const snap = parseSnapshot(
      JSON.stringify({
        gateway: "192.168.1.1",
        neighbors: {
          value: [{ ip: "192.168.1.2", mac: "AABBCCDDEEFF", state: "Reachable" }],
          Count: 1,
        },
      })
    );
    assert.equal(snap.devices.length, 1);
    assert.equal(snap.devices[0].ip, "192.168.1.2");
  });

  it("surfaces stderr in PowerShell failure message", () => {
    assert.match(
      formatPowerShellFailure(1, "Cannot convert 'System.Object[]'", ""),
      /code 1: Cannot convert/
    );
    assert.equal(formatPowerShellFailure(1, "", ""), "PowerShell exited with code 1");
  });

  it("snapshot merges mocked PowerShell JSON", async () => {
    setRunPowerShellForTest(async () => ({
      stdout: JSON.stringify({
        gateway: "10.0.0.1",
        neighbors: [{ ip: "10.0.0.2", mac: "B8-27-EB-00-00-01", state: "Reachable" }],
      }),
      stderr: "",
      code: 0,
    }));
    const { snapshot } = require("../lan-devices");
    const snap = await snapshot();
    assert.equal(snap.gateway, "10.0.0.1");
    assert.equal(snap.devices.length, 1);
  });
});

describe("Topology neighbor fallback", () => {
  it("builds star map from devices when SNMP would be off", () => {
    const { neighborTopologyFromDevices } = require("../lan-devices");
    const topo = neighborTopologyFromDevices([
      { ip: "192.168.1.1", mac: "AA", gateway: 1, online: 1, vendor: "Router" },
      { ip: "192.168.1.10", mac: "BB", gateway: 0, online: 1, alias: "Pi" },
    ]);
    assert.equal(topo.ok, true);
    assert.equal(topo.mode, "neighbor");
    assert.equal(topo.nodes.length, 2);
    assert.equal(topo.edges.length, 1);
    assert.equal(topo.edges[0].from, "192.168.1.1");
  });
});

describe("WOL", () => {
  it("builds magic packet", () => {
    const pkt = buildMagicPacket("AA:BB:CC:DD:EE:FF");
    assert.equal(pkt.length, 102);
    assert.equal(pkt.subarray(0, 6).equals(Buffer.alloc(6, 0xff)), true);
  });
});

describe("Port/CVE allowlist", () => {
  it("allows private only and matches advisories", () => {
    assert.equal(isPrivateOrLocalIp("192.168.1.5"), true);
    assert.equal(isPrivateOrLocalIp("8.8.8.8"), false);
    const cves = matchCves([{ port: 23, open: true, banner: null }]);
    assert.ok(cves.some((c) => c.stale && c.advisory));
    assert.ok(loadCveDb().length > 0);
  });
});

describe("Subnet discovery bounds", () => {
  it("caps /24 hosts and enforces min interval", () => {
    assert.equal(MIN_INTERVAL_MIN, 5);
    const hosts = prefixHosts("192.168.1.0/24");
    assert.ok(hosts.length <= 256);
    assert.ok(hosts.includes("192.168.1.1"));
    assert.deepEqual(prefixHosts("8.8.8.0/24"), []);
  });
});

describe("Notify / quiet hours", () => {
  it("blocks metadata hosts and detects quiet window", () => {
    assert.equal(normalizeWebhookUrl("https://169.254.169.254/x"), null);
    assert.equal(normalizeWebhookUrl("http://[::1]:8080/admin"), null);
    assert.equal(normalizeWebhookUrl("http://0.0.0.0/"), null);
    assert.equal(normalizeWebhookUrl("http://169.254.1.1/"), null);
    assert.ok(normalizeWebhookUrl("https://example.com/hook"));
    const qh = parseQuietHours({ enabled: true, start_hour: 22, end_hour: 7 });
    assert.equal(inQuietHours(qh, new Date("2026-01-01T23:00:00")), true);
    assert.equal(inQuietHours(qh, new Date("2026-01-01T12:00:00")), false);
  });
});

describe("Metrics bind + export", () => {
  it("prometheus text and localhost bind constant", () => {
    assert.equal(BIND_HOST, "127.0.0.1");
    const body = renderPrometheus({ devices_online: 2, outages_open: 1, outages_total: 9 });
    assert.match(body, /idt_devices_online 2/);
  });

  it("exports inventory csv/json", () => {
    const rows = [{ mac: "AA:BB:CC:DD:EE:FF", ip: "192.168.1.2", online: 1 }];
    assert.match(lanDevicesToCsv(rows), /mac,ip/);
    assert.match(lanDevicesToJson(rows), /disclaimer/);
  });
});

describe("Router webhook template", () => {
  it("renders MAC/IP placeholders", () => {
    assert.equal(renderTemplate("{{mac}}={{ip}}", { mac: "A", ip: "1" }), "A=1");
    const p = buildPayload({ mac: "M", ip: "I", alias: "X" }, "manual", null);
    assert.equal(p.mac, "M");
    assert.match(p.note, /OPNsense/);
  });
});

describe("Sniffer ring + SNMP private check", () => {
  it("buffers events and rejects public SNMP seeds", () => {
    packetSniffer.pushEvent({
      ts: 1,
      proto: "TCP",
      src: "1",
      dst: "2",
      sport: 1,
      dport: 80,
      event: "open",
    });
    assert.equal(packetSniffer.events({ limit: 10 }).length, 1);
    assert.equal(isPrivateIpv4("192.168.0.1"), true);
    assert.equal(isPrivateIpv4("1.1.1.1"), false);
  });
});
