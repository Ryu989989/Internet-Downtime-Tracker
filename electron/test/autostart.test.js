"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolvedExePath } = require("../autostart");

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
