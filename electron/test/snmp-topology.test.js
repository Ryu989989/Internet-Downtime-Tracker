"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  isPrivateIpv4,
  graphNodeKey,
  buildSysNameToIp,
  buildIpToNode,
  resolveLldpTo,
  lldpTopologyFromHosts,
  discoverTopology,
} = require("../snmp-topology");

/** Same keying as web/app.js topologyGraphHtml byId (ip || label || index). */
function layoutById(nodes) {
  const byId = new Map();
  (nodes || []).forEach((node, index) => {
    byId.set(String(node.ip || node.label || index), node);
  });
  return byId;
}

function edgesHitLayout(nodes, edges) {
  const byId = layoutById(nodes);
  return (edges || []).every((e) => byId.has(String(e.from)) && byId.has(String(e.to)));
}

describe("snmp-topology LLDP mapping", () => {
  it("maps sysName and IP neighbors onto IP-keyed layout", () => {
    assert.equal(isPrivateIpv4("192.168.0.1"), true);
    assert.equal(isPrivateIpv4("10.0.0.1"), true);
    assert.equal(isPrivateIpv4("1.1.1.1"), false);
    assert.equal(isPrivateIpv4("127.0.0.1"), false);

    const topo = lldpTopologyFromHosts([
      {
        ip: "192.168.1.1",
        ok: true,
        sysName: "gateway",
        sysDescr: "gw",
        neighbors: ["core-sw", "192.168.1.3", "gateway"],
      },
      {
        ip: "192.168.1.2",
        ok: true,
        sysName: "core-sw",
        sysDescr: "switch",
        neighbors: ["gateway"],
      },
      { ip: "192.168.1.3", ok: true, sysName: "access", neighbors: [] },
    ]);

    assert.equal(topo.mode, "snmp");
    const sysNameToIp = buildSysNameToIp(topo.nodes.filter((n) => n.source === "snmp"));
    const ipToNode = buildIpToNode(topo.nodes.filter((n) => n.source === "snmp"));
    assert.equal(sysNameToIp.get("core-sw"), "192.168.1.2");
    assert.equal(ipToNode.get("192.168.1.3").sysName, "access");
    assert.equal(resolveLldpTo("core-sw", sysNameToIp, ipToNode).key, "192.168.1.2");
    assert.equal(resolveLldpTo("192.168.1.3", sysNameToIp, ipToNode).key, "192.168.1.3");

    const toSw = topo.edges.find((e) => e.from === "192.168.1.1" && e.to === "192.168.1.2");
    const toAccess = topo.edges.find((e) => e.from === "192.168.1.1" && e.to === "192.168.1.3");
    assert.ok(toSw && toSw.type === "lldp");
    assert.ok(toAccess);
    assert.equal(
      topo.edges.some((e) => e.from === "192.168.1.1" && e.to === "gateway"),
      false
    );
    assert.equal(edgesHitLayout(topo.nodes, topo.edges), true);
    assert.equal(graphNodeKey(topo.nodes[0]), "192.168.1.1");
  });

  it("stubs unpolled sysName to with a counted warning; drops public IP", () => {
    const topo = lldpTopologyFromHosts([
      {
        ip: "192.168.1.1",
        ok: true,
        sysName: "gateway",
        neighbors: ["uplink-sw", "uplink-sw", "8.8.8.8", "192.168.1.99"],
      },
      {
        ip: "192.168.1.10",
        ok: true,
        sysName: "pi",
        neighbors: ["uplink-sw"],
      },
    ]);

    const stubName = topo.nodes.find((n) => n.id === "uplink-sw");
    const stubIp = topo.nodes.find((n) => n.ip === "192.168.1.99");
    assert.ok(stubName);
    assert.equal(stubName.source, "lldp-stub");
    assert.equal(stubName.ok, false);
    assert.ok(stubIp);
    assert.equal(stubIp.source, "lldp-stub");
    assert.equal(topo.nodes.some((n) => n.ip === "8.8.8.8" || n.id === "8.8.8.8"), false);
    assert.equal(topo.unpolled_neighbors, 2);
    assert.match(topo.warning, /2 LLDP neighbors not SNMP-polled/);
    assert.match(topo.warning, /not a switch fabric/);

    const nameEdges = topo.edges.filter((e) => e.to === "uplink-sw");
    assert.equal(nameEdges.length, 2);
    assert.equal(
      topo.edges.some((e) => e.from === "192.168.1.1" && e.to === "192.168.1.10"),
      false
    );
    assert.equal(edgesHitLayout(topo.nodes, topo.edges), true);
    assert.equal(layoutById(topo.nodes).has("uplink-sw"), true);
  });

  it("discoverTopology keeps private seed guard (no public-only walk)", async () => {
    const r = await discoverTopology({ seeds: ["8.8.8.8", "127.0.0.1"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /No private seed IPs/);
    assert.deepEqual(r.nodes, []);
    assert.deepEqual(r.edges, []);
  });
});
