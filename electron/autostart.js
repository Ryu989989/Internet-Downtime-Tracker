"use strict";

/**
 * Start-with-Windows via Electron login items + HKCU Run key.
 * Portable builds must use PORTABLE_EXECUTABLE_FILE — process.execPath is a
 * per-launch temp unpack that breaks after reboot.
 */

const fs = require("fs");
const path = require("path");

const RUN_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "InternetDowntimeTracker";

/** Stable path to the user-launched exe (portable wrapper or installed binary). */
function resolvedExePath() {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable && typeof portable === "string" && fs.existsSync(portable)) {
    return path.resolve(portable);
  }
  const exe = process.execPath;
  if (!exe || typeof exe !== "string" || !fs.existsSync(exe)) {
    throw new Error("autostart: invalid process.execPath");
  }
  return path.resolve(exe);
}

function loginCommand() {
  const { app } = require("electron");
  const exe = resolvedExePath();
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
  const on = !!enabled;
  const opts = { openAtLogin: on, openAsHidden: on };
  if (!app.isPackaged) {
    const exe = resolvedExePath();
    const project = path.resolve(path.join(__dirname, ".."));
    if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) {
      throw new Error("autostart: project root missing");
    }
    opts.path = exe;
    opts.args = [project];
  } else {
    // Packaged (NSIS or portable): always pin the stable launch path.
    opts.path = resolvedExePath();
    opts.args = [];
  }
  app.setLoginItemSettings(opts);
}

function extractRegistryCommand(regQueryOutput) {
  if (!regQueryOutput || typeof regQueryOutput !== "string") return null;
  for (const line of regQueryOutput.split(/\r?\n/)) {
    if (!line.includes(VALUE_NAME)) continue;
    const match = line.match(/REG_SZ\s+(.*)$/i);
    if (match) return match[1].trim();
  }
  return null;
}

/** True when the Run-key value points at the current stable exe path. */
function registryCommandMatchesExe(regValue, exePath) {
  if (!regValue || !exePath) return false;
  const quoted = regValue.match(/^"([^"]+)"/);
  if (!quoted) return false;
  try {
    return path.resolve(quoted[1]) === path.resolve(exePath);
  } catch {
    return false;
  }
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
    const regValue = extractRegistryCommand(out);
    if (!regValue) return false;
    const exe = resolvedExePath();
    return registryCommandMatchesExe(regValue, exe);
  } catch {
    return false;
  }
}

function setRegistry(enabled) {
  if (process.platform !== "win32") return;
  const { execFileSync } = require("child_process");
  const opts = { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] };
  if (enabled) {
    const cmd = loginCommand();
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
        cmd,
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

/**
 * Apply autostart. Returns the resulting enabled state (may differ if write failed).
 */
function setEnabled(enabled) {
  const on = !!enabled;
  if (process.platform !== "win32") return false;
  try {
    setElectron(on);
  } catch (err) {
    console.error("login item update failed", err);
  }
  try {
    setRegistry(on);
  } catch (err) {
    console.error("registry autostart update failed", err);
  }
  return isEnabled();
}

/**
 * Settings are source of truth: re-apply so portable paths stay fresh after moves/rebuilds.
 * Returns the effective enabled flag.
 */
function syncFromSettings(wantEnabled) {
  return setEnabled(!!wantEnabled);
}

module.exports = {
  isEnabled,
  setEnabled,
  syncFromSettings,
  resolvedExePath,
  registryCommandMatchesExe,
  extractRegistryCommand,
  VALUE_NAME,
};
