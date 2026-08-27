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
/** Electron setLoginItemSettings writes this (appId) — unquoted, may pin temp unpack. */
const ELECTRON_RUN_VALUE = "com.local.internetdowntimetracker";

/** Packaged Windows: registry-only. Electron's login item is unquoted and can pin process.execPath. */
function useElectronLoginItems(platform = process.platform, isPackaged) {
  if (isPackaged === undefined) {
    try {
      isPackaged = !!require("electron").app.isPackaged;
    } catch {
      isPackaged = false;
    }
  }
  return !(platform === "win32" && isPackaged);
}

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
  if (!useElectronLoginItems(process.platform, app.isPackaged)) {
    app.setLoginItemSettings({ openAtLogin: false, openAsHidden: false });
    return;
  }
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
    opts.path = resolvedExePath();
    opts.args = [];
  }
  app.setLoginItemSettings(opts);
}

function deleteRunValue(name) {
  if (process.platform !== "win32" || !name) return;
  try {
    const { execFileSync } = require("child_process");
    execFileSync(
      "reg",
      ["delete", `HKCU\\${RUN_KEY}`, "/v", name, "/f"],
      { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] }
    );
  } catch {
    /* already absent */
  }
}

/**
 * Chromium RegisterApplicationRestart relaunches the inner exe after reboot.
 * Portable unpacks to %TEMP% then deletes it on exit — leftover dir is missing
 * ffmpeg.dll (Chromium load-time dep, not an app feature).
 */
function unregisterApplicationRestart() {
  if (process.platform !== "win32") return;
  const root = process.env.SystemRoot || "C:\\Windows";
  const ps = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script =
    'Add-Type -TypeDefinition @"\n' +
    "using System.Runtime.InteropServices;\n" +
    "public static class NativeRestart {\n" +
    "  [DllImport(\"kernel32.dll\")] public static extern int UnregisterApplicationRestart();\n" +
    "}\n" +
    '"@\n' +
    "[NativeRestart]::UnregisterApplicationRestart() | Out-Null\n";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    require("child_process").execFile(
      ps,
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 10000 },
      () => {}
    );
  } catch {
    /* ignore */
  }
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
    if (useElectronLoginItems() && isEnabledElectron()) return true;
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
  deleteRunValue(ELECTRON_RUN_VALUE);
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
  useElectronLoginItems,
  unregisterApplicationRestart,
  VALUE_NAME,
  ELECTRON_RUN_VALUE,
};
