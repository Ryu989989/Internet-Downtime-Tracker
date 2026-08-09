"use strict";

/**
 * Named-pipe bridge to elevated IdtUsageHelper.
 * Electron stays unelevated; helper is started with UAC when usage_monitoring is on.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn, execFileSync } = require("child_process");

const PIPE_PREFIX = "IdtUsageHelper";
const CONNECT_ATTEMPTS = 25;
const CONNECT_GAP_MS = 400;
const HELPER_REL = path.join(
  "helper",
  "IdtUsageHelper",
  "bin",
  "Release",
  "net8.0-windows",
  "win-x64",
  "IdtUsageHelper.exe"
);
const HELPER_PUBLISH = path.join("helper", "IdtUsageHelper", "publish", "IdtUsageHelper.exe");

/** @type {{ socket: net.Socket | null, token: string | null, elevated: boolean, lastLive: object | null, suppress: boolean, starting: boolean, lastError: string | null, child: import("child_process").ChildProcess | null, helperExit: { code: number|null, signal: string|null, stderr: string } | null, buf: string, pending: Map, seq: number }} */
const state = {
  socket: null,
  token: null,
  elevated: false,
  lastLive: null,
  suppress: false,
  starting: false,
  lastError: null,
  buf: "",
  pending: new Map(),
  seq: 0,
  child: null,
  helperExit: null,
};

function projectRoot() {
  return path.join(__dirname, "..");
}

/** True when this path lives inside an asar (cannot spawn). */
function isInsideAsar(filePath) {
  return String(filePath || "").replace(/\\/g, "/").includes(".asar/");
}

/**
 * Prefer extraResources (packaged) over project publish (dev).
 * Never return an asar path — Windows cannot execute from asar.
 */
function resolveHelperExe() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "helper", "IdtUsageHelper.exe"));
  }
  candidates.push(
    path.join(projectRoot(), HELPER_PUBLISH),
    path.join(projectRoot(), HELPER_REL)
  );
  for (const c of candidates) {
    try {
      if (c && !isInsideAsar(c) && fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Best-effort: is this Electron process already elevated (High IL / admin)? */
function isProcessElevated() {
  if (process.platform !== "win32") return false;
  try {
    execFileSync("net", ["session"], { windowsHide: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function tokenPath(userDataDir) {
  return path.join(userDataDir, "usage-helper.token");
}

/** Best-effort: current-user-only ACL on the token file (Windows). */
function hardenTokenFileAcl(filePath) {
  if (process.platform !== "win32") return;
  try {
    execFileSync(
      "icacls",
      [filePath, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:R`],
      { windowsHide: true, stdio: "ignore" }
    );
  } catch {
    /* ignore — mode 0o600 still applied where supported */
  }
}

function ensureToken(userDataDir) {
  const p = tokenPath(userDataDir);
  try {
    if (fs.existsSync(p)) {
      const t = fs.readFileSync(p, "utf8").trim();
      if (t.length >= 16) {
        state.token = t;
        return t;
      }
    }
  } catch {
    /* ignore */
  }
  const t = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(p, t, { encoding: "utf8", mode: 0o600 });
  hardenTokenFileAcl(p);
  state.token = t;
  return t;
}

function pipePath(token) {
  // Windows named pipe path for Node net.connect
  return `\\\\.\\pipe\\${PIPE_PREFIX}-${token.slice(0, 16)}`;
}

function pipeNameForToken(token) {
  return `${PIPE_PREFIX}-${token.slice(0, 16)}`;
}

function trimStderr(stderr) {
  return String(stderr || "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-3)
    .join(" ");
}

function formatHelperExit(exitInfo) {
  if (!exitInfo) return null;
  const code = exitInfo.code ?? exitInfo.signal ?? "?";
  const detail = trimStderr(exitInfo.stderr);
  return detail
    ? `Helper exited early (${code}): ${detail}`
    : `Helper exited early (${code})`;
}

/** Map raw net.connect failures to actionable Usage-tab copy. */
function formatConnectError(err, pipeName, exitInfo) {
  const exitMsg = formatHelperExit(exitInfo);
  if (exitMsg) return exitMsg;
  const msg = String((err && err.message) || err || "helper pipe connect failed");
  if (/ENOENT/i.test(msg) || /connect timeout/i.test(msg)) {
    return (
      `Usage helper is not listening on \\\\.\\pipe\\${pipeName}. ` +
      `IdtUsageHelper did not start, crashed before the pipe opened, or UAC was cancelled. ` +
      `Click Enable again and approve UAC if prompted.`
    );
  }
  return msg;
}

function snapshotStatus() {
  return {
    available: !!resolveHelperExe(),
    connected: !!(state.socket && !state.socket.destroyed),
    elevated: state.elevated,
    starting: state.starting,
    suppress: state.suppress,
    last_error: state.lastError,
    last_live: state.lastLive,
    helper_path: resolveHelperExe(),
  };
}

function status() {
  return snapshotStatus();
}

function send(cmd, extra = {}) {
  return new Promise((resolve, reject) => {
    if (!state.socket || state.socket.destroyed) {
      reject(new Error("helper not connected"));
      return;
    }
    const id = ++state.seq;
    const payload = { id, cmd, token: state.token, ...extra };
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`helper cmd ${cmd} timed out`));
    }, 8000);
    state.pending.set(id, { resolve, reject, timer });
    try {
      state.socket.write(JSON.stringify(payload) + "\n");
    } catch (err) {
      clearTimeout(timer);
      state.pending.delete(id);
      reject(err);
    }
  });
}

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.cmd === "live" || msg.apps) {
    state.lastLive = {
      apps: Array.isArray(msg.apps) ? msg.apps : [],
      ts: msg.ts || Date.now(),
      suppressed: !!msg.suppressed,
    };
  }
  if (msg.id != null && state.pending.has(msg.id)) {
    const p = state.pending.get(msg.id);
    state.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok === false) p.reject(new Error(msg.error || "helper error"));
    else p.resolve(msg);
  }
}

function attachSocket(socket) {
  state.socket = socket;
  state.buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    state.buf += chunk;
    let idx;
    while ((idx = state.buf.indexOf("\n")) >= 0) {
      const line = state.buf.slice(0, idx).trim();
      state.buf = state.buf.slice(idx + 1);
      if (line) handleLine(line);
    }
  });
  socket.on("error", (err) => {
    state.lastError = String(err.message || err);
  });
  socket.on("close", () => {
    state.socket = null;
    state.elevated = false;
    for (const [, p] of state.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("helper disconnected"));
    }
    state.pending.clear();
  });
}

function connect(userDataDir) {
  const token = ensureToken(userDataDir);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: pipePath(token) });
    const timer = setTimeout(() => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      reject(new Error("connect timeout"));
    }, 3000);
    socket.once("connect", async () => {
      clearTimeout(timer);
      attachSocket(socket);
      try {
        const hello = await send("hello");
        state.elevated = !!hello.elevated;
        state.lastError = null;
        resolve(hello);
      } catch (err) {
        state.lastError = String(err.message || err);
        reject(err);
      }
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      state.lastError = String(err.message || err);
      reject(err);
    });
  });
}

function trackChildExit(child) {
  state.child = child;
  state.helperExit = null;
  let stderr = "";
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
      if (state.helperExit) state.helperExit.stderr = stderr;
    });
  }
  child.on("exit", (code, signal) => {
    state.helperExit = { code, signal, stderr };
    if (state.child === child) state.child = null;
  });
}

/**
 * Spawn helper in the current process integrity level (no UAC).
 * Used when Electron is already elevated.
 */
function spawnHelperDirect(exe, pipeName, tokFile) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(exe, ["--pipe", pipeName, "--token-file", tokFile], {
      windowsHide: true,
      detached: true,
      cwd: path.dirname(exe),
      stdio: ["ignore", "ignore", "pipe"],
    });
    trackChildExit(child);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      reject(new Error(formatHelperExit({ code, signal, stderr: state.helperExit?.stderr || "" })));
    });
    // Resolve once the process is actually running; exit listener keeps tracking afterward.
    setTimeout(() => {
      if (settled) return;
      if (state.helperExit) {
        settled = true;
        reject(new Error(formatHelperExit(state.helperExit)));
        return;
      }
      settled = true;
      try {
        child.unref();
      } catch {
        /* ignore */
      }
      resolve(child);
    }, 300);
  });
}

function launchHelperElevated(exe, pipeName, tokFile) {
  const workDir = path.dirname(exe);
  const argList = ["--pipe", pipeName, "--token-file", tokFile]
    .map((a) => `'${String(a).replace(/'/g, "''")}'`)
    .join(",");
  return new Promise((resolve, reject) => {
    const ps = spawn(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -WorkingDirectory '${workDir.replace(/'/g, "''")}' -ArgumentList @(${argList}) -Verb RunAs`,
      ],
      { windowsHide: true }
    );
    ps.on("error", reject);
    ps.on("close", (code) => {
      // RunAs returns quickly after UAC; non-zero often means user cancelled.
      if (code !== 0) reject(new Error("UAC elevation cancelled or failed"));
      else resolve();
    });
  });
}

async function waitForHelperPipe(userDataDir, pipeName) {
  let lastErr = null;
  for (let i = 0; i < CONNECT_ATTEMPTS; i++) {
    if (state.helperExit) {
      throw new Error(formatHelperExit(state.helperExit));
    }
    await new Promise((r) => setTimeout(r, CONNECT_GAP_MS));
    if (state.helperExit) {
      throw new Error(formatHelperExit(state.helperExit));
    }
    try {
      await connect(userDataDir);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(formatConnectError(lastErr, pipeName, state.helperExit));
}

/**
 * Launch helper elevated via PowerShell Start-Process -Verb RunAs (UAC).
 * If Electron is already elevated, spawn directly — no second UAC.
 */
async function startElevated(userDataDir) {
  if (state.starting) return snapshotStatus();
  // Already connected (e.g. helper still running from prior enable).
  if (state.socket && !state.socket.destroyed && state.elevated) {
    state.lastError = null;
    return snapshotStatus();
  }
  const exe = resolveHelperExe();
  if (!exe) {
    state.lastError =
      "Helper binary not found. Build helper/IdtUsageHelper (dotnet publish) and ensure it is copied to resources/helper.";
    console.error("[usage-bridge]", state.lastError, {
      resourcesPath: process.resourcesPath || null,
      projectRoot: projectRoot(),
    });
    return snapshotStatus();
  }
  state.starting = true;
  state.helperExit = null;
  try {
    // Reattach if a prior helper is already listening.
    try {
      await connect(userDataDir);
      state.lastError = null;
      console.log("[usage-bridge] attached to existing helper", exe);
    } catch {
      const token = ensureToken(userDataDir);
      const tokFile = tokenPath(userDataDir);
      hardenTokenFileAcl(tokFile);
      // Pass token via file path — avoid putting the secret on the elevated process command line.
      const pipeName = pipeNameForToken(token);
      const alreadyElevated = isProcessElevated();
      console.log("[usage-bridge] starting helper", {
        exe,
        pipeName,
        alreadyElevated,
        cwd: path.dirname(exe),
      });

      if (alreadyElevated) {
        await spawnHelperDirect(exe, pipeName, tokFile);
      } else {
        await launchHelperElevated(exe, pipeName, tokFile);
      }

      await waitForHelperPipe(userDataDir, pipeName);
      state.lastError = null;
      console.log("[usage-bridge] helper connected");
    }
  } catch (err) {
    const token = state.token || ensureToken(userDataDir);
    const pipeName = pipeNameForToken(token);
    state.lastError = formatConnectError(err, pipeName, state.helperExit);
    console.error("[usage-bridge] start failed:", state.lastError);
  } finally {
    state.starting = false;
  }
  return snapshotStatus();
}

async function stop() {
  try {
    if (state.socket && !state.socket.destroyed) await send("quit");
  } catch {
    /* ignore */
  }
  try {
    if (state.socket) state.socket.destroy();
  } catch {
    /* ignore */
  }
  state.socket = null;
  state.elevated = false;
}

async function getLive() {
  if (!state.socket || state.socket.destroyed) return { ok: false, ...snapshotStatus(), apps: [] };
  try {
    const msg = await send("get_live");
    state.lastLive = {
      apps: msg.apps || [],
      ts: msg.ts || Date.now(),
      suppressed: !!msg.suppressed,
    };
    return { ok: true, ...snapshotStatus(), apps: state.lastLive.apps, ts: state.lastLive.ts };
  } catch (err) {
    return { ok: false, ...snapshotStatus(), apps: [], error: String(err.message || err) };
  }
}

async function setSuppress(on) {
  state.suppress = !!on;
  if (!state.socket || state.socket.destroyed) return { ok: false, suppress: state.suppress };
  try {
    await send("set_suppress", { on: state.suppress });
    return { ok: true, suppress: state.suppress };
  } catch (err) {
    return { ok: false, suppress: state.suppress, error: String(err.message || err) };
  }
}

async function blockExe(exePath) {
  if (!state.socket || state.socket.destroyed) throw new Error("helper not connected");
  return send("block", { exe: exePath });
}

async function unblockExe(exePath) {
  if (!state.socket || state.socket.destroyed) throw new Error("helper not connected");
  return send("unblock", { exe: exePath });
}

function disconnectForTests() {
  try {
    if (state.socket) state.socket.destroy();
  } catch {
    /* ignore */
  }
  state.socket = null;
  state.elevated = false;
  state.lastLive = null;
  state.lastError = null;
  state.buf = "";
  state.pending.clear();
  state.helperExit = null;
  state.child = null;
}

module.exports = {
  status,
  connect,
  startElevated,
  stop,
  getLive,
  setSuppress,
  blockExe,
  unblockExe,
  resolveHelperExe,
  isProcessElevated,
  isInsideAsar,
  ensureToken,
  tokenPath,
  hardenTokenFileAcl,
  pipePath,
  pipeNameForToken,
  formatConnectError,
  formatHelperExit,
  waitForHelperPipe,
  PIPE_PREFIX,
  CONNECT_ATTEMPTS,
  disconnectForTests,
};
