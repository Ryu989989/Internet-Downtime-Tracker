"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  shapeConnections,
  shapeConnectionRow,
  computeAdapterRates,
  snapshot,
  buildSnapshotScript,
  buildServiceScript,
  setRunPowerShellForTest,
  setReverseLookupForTest,
  resetRunPowerShellForTest,
  ROW_CAP,
  DNS_LOOKUP_CAP,
  DNS_TIMEOUT_MS,
  RESOLVE_DNS_SETTING,
} = require("../connections");

function mockSnap(connections, services = [], adapters = []) {
  setRunPowerShellForTest(async (script) => {
    if (/Win32_Service/.test(script)) {
      return { stdout: JSON.stringify(services), stderr: "", code: 0 };
    }
    return {
      stdout: JSON.stringify({ connections, adapters, captured_at: Date.now() }),
      stderr: "",
      code: 0,
    };
  });
}

afterEach(() => {
  resetRunPowerShellForTest();
});

describe("buildSnapshotScript", () => {
  it("casts OwningProcess to int for Get-Process lookup", () => {
    const script = buildSnapshotScript();
    assert.match(script, /\$procs\[\[int\]\$_\.Id\]/);
    assert.match(script, /\$procId = \[int\]\$_\.OwningProcess/);
    assert.match(script, /Get-Process -Id \$procId/);
  });
});

describe("shapeConnectionRow", () => {
  it("normalizes fields and caps lengths", () => {
    const row = shapeConnectionRow({
      proto: "tcp",
      process: "x".repeat(200),
      pid: "42",
      local: "127.0.0.1:80",
      remote: "1.1.1.1:443",
      state: "Established",
    });
    assert.equal(row.proto, "TCP");
    assert.equal(row.pid, 42);
    assert.equal(row.process.length, 128);
    assert.equal(row.state, "Established");
  });
});

describe("shapeConnections", () => {
  it("caps rows and reports truncation", () => {
    const raw = [];
    for (let i = 0; i < ROW_CAP + 25; i++) {
      raw.push({
        proto: "TCP",
        process: `p${i}`,
        pid: i,
        local: `127.0.0.1:${i}`,
        remote: "1.1.1.1:443",
        state: i % 2 === 0 ? "Established" : "TimeWait",
      });
    }
    const shaped = shapeConnections(raw);
    assert.equal(shaped.rows.length, ROW_CAP);
    assert.equal(shaped.truncated, true);
    assert.equal(shaped.total, ROW_CAP + 25);
  });

  it("filters Established-only (keeps UDP)", () => {
    const shaped = shapeConnections(
      [
        { proto: "TCP", process: "a", pid: 1, local: "l", remote: "r", state: "Established" },
        { proto: "TCP", process: "b", pid: 2, local: "l", remote: "r", state: "Listen" },
        { proto: "UDP", process: "c", pid: 3, local: "l", remote: "-", state: "Listen" },
      ],
      { establishedOnly: true }
    );
    assert.equal(shaped.rows.length, 2);
    assert.deepEqual(
      shaped.rows.map((r) => r.process).sort(),
      ["a", "c"]
    );
  });
});

describe("computeAdapterRates", () => {
  it("returns null rates on first sample then Mbps on second", () => {
    const first = computeAdapterRates(
      [{ name: "Ethernet", rx_bytes: 1_000_000, tx_bytes: 500_000 }],
      1000
    );
    assert.equal(first.length, 1);
    assert.equal(first[0].rx_mbps, null);

    const second = computeAdapterRates(
      [{ name: "Ethernet", rx_bytes: 1_000_000 + 1_250_000, tx_bytes: 500_000 + 625_000 }],
      2000
    );
    assert.ok(Math.abs(second[0].rx_mbps - 10) < 0.01);
    assert.ok(Math.abs(second[0].tx_mbps - 5) < 0.01);
  });
});

describe("snapshot", () => {
  it("returns empty+warning on timeout/spawn failure", async () => {
    setRunPowerShellForTest(async () => {
      throw new Error("Connections snapshot timed out after 10s");
    });
    const result = await snapshot();
    assert.equal(result.ok, false);
    assert.equal(result.connections.length, 0);
    assert.match(result.warning, /timed out/i);
    assert.equal(result.error, "timeout_or_spawn");
  });

  it("shapes JSON from PowerShell", async () => {
    setRunPowerShellForTest(async () => ({
      stdout: JSON.stringify({
        connections: [
          {
            proto: "TCP",
            process: "chrome",
            pid: 99,
            local: "10.0.0.2:50000",
            remote: "1.1.1.1:443",
            state: "Established",
          },
        ],
        adapters: [{ name: "Wi-Fi", rx_bytes: 100, tx_bytes: 50 }],
        captured_at: 1_700_000_000_000,
      }),
      stderr: "",
      code: 0,
    }));
    const result = await snapshot();
    assert.equal(result.ok, true);
    assert.equal(result.connections.length, 1);
    assert.equal(result.connections[0].process, "chrome");
    assert.equal(result.adapters[0].name, "Wi-Fi");
    assert.equal(result.connections[0].portName, "https");
    assert.equal(result.connections[0].resolved, null);
    assert.equal(result.connections[0].serviceName, null);
    assert.equal(result.connections[0].delta, null);
  });
});

describe("enrichment", () => {
  it("maps well-known ports locally (not DNS)", async () => {
    mockSnap([
      {
        proto: "TCP",
        process: "nginx",
        pid: 1,
        local: "0.0.0.0:80",
        remote: "-",
        state: "Listen",
      },
      {
        proto: "TCP",
        process: "chrome",
        pid: 2,
        local: "10.0.0.2:50000",
        remote: "[2001:db8::1]:443",
        state: "Established",
      },
      {
        proto: "TCP",
        process: "app",
        pid: 3,
        local: "10.0.0.2:50001",
        remote: "203.0.113.9:49152",
        state: "Established",
      },
    ]);
    const result = await snapshot();
    const byPid = Object.fromEntries(result.connections.map((r) => [r.pid, r.portName]));
    assert.equal(byPid[1], "http");
    assert.equal(byPid[2], "https");
    assert.equal(byPid[3], null);
  });

  it("skips reverse-DNS unless resolveDns; caps, caches, times out", async () => {
    assert.equal(RESOLVE_DNS_SETTING, "connections_resolve_dns");
    const calls = [];
    let resolveLate;
    setReverseLookupForTest((ip) => {
      calls.push(ip);
      if (ip === "203.0.113.1") return new Promise((r) => { resolveLate = r; });
      return `host-${ip}.example`;
    });
    const rows = [];
    for (let i = 1; i <= DNS_LOOKUP_CAP + 2; i++) {
      rows.push({
        proto: "TCP",
        process: "p",
        pid: i,
        local: `10.0.0.2:${40000 + i}`,
        remote: `203.0.113.${i}:443`,
        state: "Established",
      });
    }
    mockSnap(rows);

    const off = await snapshot();
    assert.equal(calls.length, 0);
    assert.ok(off.connections.every((r) => r.resolved == null));

    resetRunPowerShellForTest();
    mockSnap(rows);
    setReverseLookupForTest((ip) => {
      calls.push(ip);
      if (ip === "203.0.113.1") return new Promise((r) => { resolveLate = r; });
      return `host-${ip}.example`;
    });

    const on = await snapshot({ resolveDns: true });
    if (resolveLate) resolveLate("late.example");
    assert.equal(calls.length, DNS_LOOKUP_CAP);
    const resolved = on.connections.filter((r) => r.resolved);
    const missing = on.connections.filter((r) => !r.resolved);
    assert.equal(resolved.length, DNS_LOOKUP_CAP - 1);
    assert.equal(missing.length, 3);
    const timed = on.connections.find((r) => r.remote.startsWith("203.0.113.1:"));
    assert.equal(timed.resolved, null);

    const firstBatch = calls.slice();
    const again = await snapshot({ resolveDns: true });
    assert.equal(calls.length, DNS_LOOKUP_CAP + 2);
    assert.deepEqual(calls.slice(0, DNS_LOOKUP_CAP), firstBatch);
    const third = await snapshot({ resolveDns: true });
    assert.equal(calls.length, DNS_LOOKUP_CAP + 2);
    assert.equal(again.connections.filter((r) => r.resolved).length, DNS_LOOKUP_CAP + 1);
    assert.equal(third.connections.find((r) => r.remote.startsWith("203.0.113.1:")).resolved, null);
    assert.ok(DNS_TIMEOUT_MS > 0);
  });

  it("joins Win32_Service by pid from one cached CIM query", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "win32",
      writable: true,
      configurable: true,
    });
    let svcCalls = 0;
    let snapCalls = 0;
    setRunPowerShellForTest(async (script) => {
      if (/Win32_Service/.test(script)) {
        svcCalls += 1;
        return {
          stdout: JSON.stringify([
            { Name: "Dnscache", ProcessId: 99 },
            { Name: "Dhcp", ProcessId: 99 },
          ]),
          stderr: "",
          code: 0,
        };
      }
      snapCalls += 1;
      return {
        stdout: JSON.stringify({
          connections: [
            {
              proto: "UDP",
              process: "svchost",
              pid: 99,
              local: "0.0.0.0:53",
              remote: "-",
              state: "Listen",
            },
          ],
          adapters: [],
          captured_at: 1,
        }),
        stderr: "",
        code: 0,
      };
    });
    try {
      const a = await snapshot();
      const b = await snapshot();
      assert.equal(svcCalls, 1);
      assert.equal(snapCalls, 2);
      assert.equal(a.connections[0].serviceName, "Dnscache, Dhcp");
      assert.equal(b.connections[0].serviceName, "Dnscache, Dhcp");
      assert.match(buildServiceScript(), /Get-CimInstance[\s\S]*Win32_Service/);
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        writable: true,
        configurable: true,
      });
    }
  });

  it("marks new / dropped / state-changed for one cycle", async () => {
    const row = (over) => ({
      proto: "TCP",
      process: "c",
      pid: 1,
      local: "10.0.0.2:1",
      remote: "1.1.1.1:443",
      state: "Established",
      ...over,
    });
    let current = [row({ pid: 1 }), row({ pid: 2, local: "10.0.0.2:2" })];
    mockSnap(current);
    const first = await snapshot({ trackDelta: true });
    assert.ok(first.connections.every((c) => c.delta == null));

    current = [row({ pid: 1, state: "TimeWait" }), row({ pid: 3, local: "10.0.0.2:3" })];
    mockSnap(current);
    const second = await snapshot({ trackDelta: true });
    const byPid = Object.fromEntries(second.connections.map((c) => [c.pid, c.delta]));
    assert.equal(byPid[1], "state-changed");
    assert.equal(byPid[3], "new");
    assert.equal(byPid[2], "dropped");

    const third = await snapshot({ trackDelta: true });
    assert.equal(third.connections.length, 2);
    assert.ok(third.connections.every((c) => c.delta == null));
    assert.ok(!third.connections.some((c) => c.pid === 2));
  });

  it("sidecar snapshot does not steal UI delta or adapter sample", async () => {
    const listen = {
      proto: "TCP",
      process: "srv",
      pid: 1,
      local: "10.0.0.2:80",
      remote: "-",
      state: "Listen",
    };
    const est = {
      proto: "TCP",
      process: "chrome",
      pid: 2,
      local: "10.0.0.2:50000",
      remote: "1.1.1.1:443",
      state: "Established",
    };
    const nic = (rx) => [{ name: "Ethernet", rx_bytes: rx, tx_bytes: 0 }];

    mockSnap([listen, est], [], nic(100));
    const ui1 = await snapshot({ trackDelta: true, trackAdapters: true });
    assert.ok(ui1.connections.every((c) => c.delta == null));
    assert.equal(ui1.adapters[0].rx_mbps, null);

    mockSnap([est], [], []);
    const side = await snapshot({ establishedOnly: true });
    assert.equal(side.connections.length, 1);
    assert.equal(side.connections[0].pid, 2);
    assert.equal(side.connections[0].delta, null);
    assert.ok(!side.connections.some((c) => c.delta === "dropped"));

    mockSnap([listen, est], [], nic(200));
    const ui2 = await snapshot({ trackDelta: true, trackAdapters: true });
    const byPid2 = Object.fromEntries(ui2.connections.map((c) => [c.pid, c.delta]));
    assert.equal(byPid2[1], null);
    assert.equal(byPid2[2], null);
    assert.ok(!ui2.connections.some((c) => c.delta === "dropped"));
    assert.equal(typeof ui2.adapters[0].rx_mbps, "number");

    mockSnap(
      [{ ...est, state: "TimeWait" }, { ...listen, pid: 3, local: "10.0.0.2:81" }],
      [],
      nic(200)
    );
    const side2 = await snapshot({ establishedOnly: true });
    assert.ok(!side2.connections.some((c) => c.delta === "dropped" || c.delta === "new"));

    const ui3 = await snapshot({ trackDelta: true, trackAdapters: true });
    const byPid3 = Object.fromEntries(ui3.connections.map((c) => [c.pid, c.delta]));
    assert.equal(byPid3[2], "state-changed");
    assert.equal(byPid3[3], "new");
    assert.equal(byPid3[1], "dropped");
  });
});
