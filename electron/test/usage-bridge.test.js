"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  PIPE_PREFIX,
  pipePath,
  pipeNameForToken,
  formatConnectError,
  formatHelperExit,
  isInsideAsar,
  resolveHelperExe,
  ensureToken,
  CONNECT_ATTEMPTS,
} = require("../usage-bridge");

describe("usage-bridge pipe naming", () => {
  it("uses IdtUsageHelper prefix (not ldt)", () => {
    assert.equal(PIPE_PREFIX, "IdtUsageHelper");
    const token = "a45948680cab1dc21afba5caa6b1cae4";
    assert.equal(pipeNameForToken(token), "IdtUsageHelper-a45948680cab1dc2");
    assert.equal(pipePath(token), "\\\\.\\pipe\\IdtUsageHelper-a45948680cab1dc2");
    assert.doesNotMatch(pipePath(token), /ldtUsageHelper/);
  });
});

describe("usage-bridge error formatting", () => {
  it("maps ENOENT/timeout to actionable copy and prefers helper exit", () => {
    const named = formatConnectError(
      new Error("connect ENOENT \\\\.\\pipe\\IdtUsageHelper-a45948680cab1dc2"),
      "IdtUsageHelper-a45948680cab1dc2",
      null
    );
    assert.match(named, /not listening/i);
    assert.match(named, /IdtUsageHelper/);
    assert.doesNotMatch(named, /^connect ENOENT/);

    const timed = formatConnectError(new Error("connect timeout"), "IdtUsageHelper-x", null);
    assert.match(timed, /not listening/i);

    const exit = formatConnectError(new Error("connect ENOENT"), "IdtUsageHelper-x", {
      code: 2,
      signal: null,
      stderr: "token-file read failed: Access denied",
    });
    assert.match(exit, /Helper exited early \(2\)/);
    assert.match(exit, /Access denied/);
  });

  it("formatHelperExit handles missing stderr", () => {
    assert.equal(formatHelperExit(null), null);
    assert.equal(formatHelperExit({ code: 1, signal: null, stderr: "" }), "Helper exited early (1)");
  });
});

describe("usage-bridge resolve paths", () => {
  it("rejects asar paths and finds a real helper when present", () => {
    assert.equal(isInsideAsar("C:/app/resources/app.asar/helper/IdtUsageHelper.exe"), true);
    assert.equal(isInsideAsar("C:/app/resources/helper/IdtUsageHelper.exe"), false);
    const exe = resolveHelperExe();
    if (exe) {
      assert.equal(isInsideAsar(exe), false);
      assert.match(exe, /IdtUsageHelper\.exe$/i);
      assert.ok(fs.existsSync(exe));
    }
  });

  it("ensureToken is stable and long enough for pipe suffix", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-usage-tok-"));
    const a = ensureToken(dir);
    const b = ensureToken(dir);
    assert.equal(a, b);
    assert.ok(a.length >= 16);
  });

  it("retries long enough for slow UAC/helper boot", () => {
    assert.ok(CONNECT_ATTEMPTS >= 15);
  });
});

describe("usage-bridge contracts", () => {
  it("sets WorkingDirectory and tracks helper exit during pipe wait", () => {
    const bridge = fs.readFileSync(path.join(__dirname, "..", "usage-bridge.js"), "utf8");
    assert.match(bridge, /WorkingDirectory/);
    assert.match(bridge, /cwd:\s*path\.dirname\(exe\)/);
    assert.match(bridge, /helperExit/);
    assert.match(bridge, /waitForHelperPipe/);
    assert.match(bridge, /formatConnectError/);
    assert.match(bridge, /spawnHelperDirect/);
    assert.match(bridge, /isProcessElevated/);
  });
});
