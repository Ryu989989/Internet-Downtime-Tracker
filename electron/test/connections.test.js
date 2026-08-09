"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  shapeConnections,
  shapeConnectionRow,
  computeAdapterRates,
  snapshot,
  buildSnapshotScript,
  setRunPowerShellForTest,
  resetRunPowerShellForTest,
  ROW_CAP,
} = require("../connections");

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
  });
});
