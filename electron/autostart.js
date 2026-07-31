"use strict";

/**
 * Start-with-Windows via Electron login items when `app` is available,
 * with HKCU Run key fallback for parity with the Python app.
 */

const fs = require("fs");
const path = require("path");

const RUN_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "InternetDowntimeTracker";

function loginCommand() {
  const { app } = require("electron");
  const exe = process.execPath;
  if (!exe || typeof exe !== "string" || !fs.existsSync(exe)) {
    throw new Error("autostart: invalid process.execPath");
  }
  if (app.isPackaged) {
    return `"${exe}"`;
  }
  // Dev: electron.exe + project path (fixed argv; no user-controlled args).
  const project = path.resolve(path.join(__dirname, ".."));
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) {
    throw new Error("autostart: project root missing");
  }
  return `"${exe}" "${project}"`;
}

function isEnabledElectron() {
  try {
    const { app } = require("electron");
    return !!app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function setElectron(enabled) {
  const { app } = require("electron");
  const opts = { openAtLogin: !!enabled };
  if (!app.isPackaged) {
    const exe = process.execPath;
    const project = path.resolve(path.join(__dirname, ".."));
    if (!exe || !fs.existsSync(exe)) {
      throw new Error("autostart: invalid process.execPath");
    }
    if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) {
      throw new Error("autostart: project root missing");
    }
    opts.path = exe;
    opts.args = [project];
  }
  app.setLoginItemSettings(opts);
}

function isEnabledRegistry() {
  if (process.platform !== "win32") return false;
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync(
      "reg",
      ["query", `HKCU\\${RUN_KEY}`, "/v", VALUE_NAME],
      { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return out.includes(VALUE_NAME);
  } catch {
    return false;
  }
}

function setRegistry(enabled) {
  if (process.platform !== "win32") return;
  const { execFileSync } = require("child_process");
  const opts = { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] };
  if (enabled) {
    execFileSync(
      "reg",
      [
        "add",
        `HKCU\\${RUN_KEY}`,
        "/v",
        VALUE_NAME,
        "/t",
        "REG_SZ",
        "/d",
        loginCommand(),
        "/f",
      ],
      opts
    );
  } else {
    try {
      execFileSync(
        "reg",
        ["delete", `HKCU\\${RUN_KEY}`, "/v", VALUE_NAME, "/f"],
        opts
      );
    } catch {
      /* already absent */
    }
  }
}

function isEnabled() {
  if (process.platform !== "win32") return false;
  try {
    if (isEnabledElectron()) return true;
  } catch {
    /* ignore */
  }
  return isEnabledRegistry();
}

function setEnabled(enabled) {
  const on = !!enabled;
  try {
    setElectron(on);
  } catch (err) {
    console.error("login item update failed", err);
  }
  // Also maintain Run key so behavior matches Python / survives edge cases
  try {
    setRegistry(on);
  } catch (err) {
    console.error("registry autostart update failed", err);
  }
  return isEnabled();
}

module.exports = { isEnabled, setEnabled, VALUE_NAME };
