"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolvedExePath, registryCommandMatchesExe } = require("../autostart");

describe("autostart resolvedExePath", () => {
  it("uses PORTABLE_EXECUTABLE_FILE when present and exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idt-auto-"));
    const fake = path.join(dir, "Internet Downtime Tracker 1.0.0.exe");
    fs.writeFileSync(fake, "x");
    const prev = process.env.PORTABLE_EXECUTABLE_FILE;
    process.env.PORTABLE_EXECUTABLE_FILE = fake;
    try {
      assert.equal(resolvedExePath(), path.resolve(fake));
    } finally {
      if (prev == null) delete process.env.PORTABLE_EXECUTABLE_FILE;
      else process.env.PORTABLE_EXECUTABLE_FILE = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to process.execPath", () => {
    const prev = process.env.PORTABLE_EXECUTABLE_FILE;
    delete process.env.PORTABLE_EXECUTABLE_FILE;
    try {
      const p = resolvedExePath();
      assert.ok(fs.existsSync(p));
      assert.equal(path.resolve(p), path.resolve(process.execPath));
    } finally {
      if (prev != null) process.env.PORTABLE_EXECUTABLE_FILE = prev;
    }
  });
});

describe("autostart registry path match", () => {
  it("registryCommandMatchesExe requires exact exe path", () => {
    const exe = "C:\\Apps\\Internet Downtime Tracker.exe";
    const stale = "C:\\Old\\Internet Downtime Tracker.exe";
    assert.equal(
      registryCommandMatchesExe(`"${exe}"`, exe),
      true
    );
    assert.equal(
      registryCommandMatchesExe(`"${stale}"`, exe),
      false
    );
    assert.equal(registryCommandMatchesExe(`"${exe}" "C:\\proj"`, exe), true);
  });
});

describe("autostart windows packaged login items", () => {
  const { useElectronLoginItems, ELECTRON_RUN_VALUE } = require("../autostart");

  it("skips Electron login items on packaged Windows", () => {
    assert.equal(useElectronLoginItems("win32", true), false);
    assert.equal(useElectronLoginItems("win32", false), true);
    assert.equal(useElectronLoginItems("darwin", true), true);
  });

  it("Electron Run value is the appId", () => {
    assert.equal(ELECTRON_RUN_VALUE, "com.local.internetdowntimetracker");
  });
});
