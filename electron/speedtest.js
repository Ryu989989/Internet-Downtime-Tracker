"use strict";

const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { createWriteStream } = require("fs");
const { powershellExe } = require("./system-logs");

// Official Ookla Windows x64 CLI package (personal / non-commercial use per Ookla terms).
const OFFICIAL_WIN64_ZIP =
  "https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-win64.zip";

/** SHA-256 of OFFICIAL_WIN64_ZIP (ookla-speedtest-1.2.0-win64.zip). */
const OFFICIAL_WIN64_SHA256 =
  "13e3d888b845d301a556419e31f14ab9bff57e3f06089ef2fd3bdc9ba6841efa";

const RUN_TIMEOUT_MS = 180_000;
const MAX_DOWNLOAD_REDIRECTS = 5;

function isAllowedDownloadUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return (
      host === "install.speedtest.net" ||
      host === "speedtest.net" ||
      host.endsWith(".speedtest.net") ||
      host === "ookla.com" ||
      host.endsWith(".ookla.com")
    );
  } catch {
    return false;
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function verifyOfficialZip(filePath, expectedSha256 = OFFICIAL_WIN64_SHA256) {
  const digest = sha256File(filePath);
  if (digest !== expectedSha256) {
    throw new Error(
      `Official CLI zip failed integrity check (got ${digest}, expected ${expectedSha256})`
    );
  }
  return digest;
}

/**
 * SPEEDTEST_CLI / PATH / bundled: basename must be speedtest(.exe) and path
 * must resolve under an allowlisted directory.
 */
function pathApi() {
  // process.platform, not the host path module — tests stub win32 on POSIX.
  return process.platform === "win32" ? path.win32 : path.posix;
}

function isTrustedCliPath(cliPath, userDataDir) {
  if (!cliPath || typeof cliPath !== "string") return false;
  const p = pathApi();
  let resolved;
  try {
    resolved = p.resolve(cliPath);
  } catch {
    return false;
  }
  const base = p.basename(resolved).toLowerCase();
  if (base !== "speedtest.exe" && base !== "speedtest") return false;

  const isWin = process.platform === "win32";
  const allowedRoots = [];
  if (userDataDir) {
    allowedRoots.push(p.resolve(userDataDir, "speedtest"));
  }
  if (isWin) {
    allowedRoots.push(
      p.join(process.env.ProgramFiles || "C:\\Program Files", "Speedtest CLI"),
      p.join(
        process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
        "Speedtest CLI"
      )
    );
  } else {
    allowedRoots.push(
      "/usr/local/bin",
      "/usr/bin",
      "/opt/homebrew/bin",
      "/opt/local/bin",
      p.join(require("os").homedir(), ".local", "bin")
    );
  }

  const sep = p.sep;
  const target = p.resolve(resolved).toLowerCase();
  return allowedRoots.some((root) => {
    const r = p.resolve(root).toLowerCase();
    if (target === r) return true;
    if (!target.startsWith(`${r}${sep}`)) return false;
    // Disallow directory traversal past the allowed root.
    const relative = p.relative(r, target);
    return relative && !relative.startsWith("..") && !p.isAbsolute(relative);
  });
}

/** @type {import('child_process').ChildProcess | null} */
let running = null;
/** True after cancelRun until the child process closes. */
let cancelRequested = false;

function speedtestChildEnv() {
  const pick = (key) => {
    const v = process.env[key];
    return v != null && v !== "" ? v : undefined;
  };
  const env = {};
  for (const key of [
    "SystemRoot",
    "PATH",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ComSpec",
  ]) {
    const v = pick(key);
    if (v !== undefined) env[key] = v;
  }
  return env;
}

function round(n, digits = 2) {
  if (n == null || Number.isNaN(Number(n))) return null;
  const f = 10 ** digits;
  return Math.round(Number(n) * f) / f;
}

/** bytes/sec → Mbps */
function bandwidthToMbps(bytesPerSec) {
  if (bytesPerSec == null || Number.isNaN(Number(bytesPerSec))) return null;
  return round((Number(bytesPerSec) * 8) / 1_000_000, 2);
}

/**
 * Parse Ookla Speedtest CLI JSON (`--format=json`).
 * Pure helper — unit-tested.
 */
function parseSpeedtestJson(raw) {
  const j = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!j || typeof j !== "object") throw new Error("Invalid speedtest JSON");
  const ping = j.ping || {};
  const download = j.download || {};
  const upload = j.upload || {};
  const server = j.server || {};
  const result = j.result || {};
  let testedAt = Date.now() / 1000;
  if (j.timestamp) {
    const t = Date.parse(j.timestamp);
    if (!Number.isNaN(t)) testedAt = t / 1000;
  }
  let packetLoss = j.packetLoss;
  if (packetLoss === "Not available" || packetLoss === undefined) packetLoss = null;
  else if (packetLoss != null) packetLoss = Number(packetLoss);

  return {
    tested_at: testedAt,
    download_mbps: bandwidthToMbps(download.bandwidth),
    upload_mbps: bandwidthToMbps(upload.bandwidth),
    ping_ms: ping.latency != null ? round(ping.latency, 3) : null,
    jitter_ms: ping.jitter != null ? round(ping.jitter, 3) : null,
    packet_loss: packetLoss != null && !Number.isNaN(packetLoss) ? round(packetLoss, 3) : null,
    server_name: server.name || null,
    server_id: server.id != null ? String(server.id) : null,
    server_location: server.location || null,
    isp: j.isp || null,
    result_url: result.url || null,
    interface_name: (j.interface && j.interface.name) || null,
  };
}

function whichSync(cmd) {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const finder = isWin ? "where" : "which";
    execFile(finder, [cmd], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const line = String(stdout)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      resolve(line || null);
    });
  });
}

function bundledCliPath(userDataDir) {
  return path.join(userDataDir, "speedtest", "speedtest.exe");
}

async function resolveCli(userDataDir) {
  const candidates = [];
  // SPEEDTEST_CLI is honored only when it still passes basename + allowlisted-dir checks.
  if (process.env.SPEEDTEST_CLI) candidates.push(process.env.SPEEDTEST_CLI);
  if (userDataDir) candidates.push(bundledCliPath(userDataDir));
  if (process.platform === "win32") {
    candidates.push(
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Speedtest CLI", "speedtest.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Speedtest CLI", "speedtest.exe")
    );
  } else {
    candidates.push(
      "/usr/local/bin/speedtest",
      "/opt/homebrew/bin/speedtest",
      "/usr/bin/speedtest",
      "/opt/local/bin/speedtest",
      path.join(require("os").homedir(), ".local", "bin", "speedtest")
    );
  }
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && isTrustedCliPath(c, userDataDir)) {
        return { path: path.resolve(c), source: "file" };
      }
    } catch {
      /* ignore */
    }
  }
  const onPath = await whichSync("speedtest");
  if (onPath && isTrustedCliPath(onPath, userDataDir)) {
    return { path: path.resolve(onPath), source: "path" };
  }
  const onPathExe = await whichSync("speedtest.exe");
  if (onPathExe && isTrustedCliPath(onPathExe, userDataDir)) {
    return { path: path.resolve(onPathExe), source: "path" };
  }
  return null;
}

function getStatus(userDataDir) {
  return resolveCli(userDataDir).then((cli) => ({
    available: !!cli,
    path: cli ? cli.path : null,
    source: cli ? cli.source : null,
    running: !!running,
    install_hint:
      process.platform === "win32"
        ? "Install Ookla Speedtest CLI (winget install --id Ookla.Speedtest.CLI) or download from https://www.speedtest.net/apps/cli — personal non-commercial use. Or use Speed → Install CLI to fetch the official Windows zip into app data."
        : "Install Ookla Speedtest CLI for your platform (macOS/Linux tarball from https://www.speedtest.net/apps/cli) and place it in /usr/local/bin or another PATH directory — personal non-commercial use.",
  }));
}

function downloadFile(url, dest, redirectsLeft = MAX_DOWNLOAD_REDIRECTS) {
  return new Promise((resolve, reject) => {
    if (!isAllowedDownloadUrl(url)) {
      reject(new Error(`Download host not allowed: ${url}`));
      return;
    }
    if (redirectsLeft < 0) {
      reject(new Error("Too many download redirects"));
      return;
    }
    const req = https.get(
      url,
      { headers: { "User-Agent": "InternetDowntimeTracker/1.0" } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let next;
          try {
            next = new URL(res.headers.location, url).href;
          } catch {
            reject(new Error("Invalid download redirect"));
            return;
          }
          if (!isAllowedDownloadUrl(next)) {
            reject(new Error(`Download redirect host not allowed: ${next}`));
            return;
          }
          downloadFile(next, dest, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed HTTP ${res.statusCode}`));
          return;
        }
        const out = createWriteStream(dest);
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve(dest)));
        out.on("error", reject);
      }
    );
    req.on("error", reject);
    req.setTimeout(120_000, () => {
      req.destroy(new Error("Download timed out"));
    });
  });
}

/**
 * Download official Windows CLI zip into userData/speedtest/.
 * Uses PowerShell Expand-Archive (reliable on Win10/11).
 */
async function installOfficialCli(userDataDir) {
  if (process.platform !== "win32") {
    throw new Error("Automatic CLI install is only supported on Windows. Install the official tarball for macOS/Linux from https://www.speedtest.net/apps/cli and place it on PATH.");
  }
  if (!userDataDir) throw new Error("userDataDir required");
  const dir = path.join(userDataDir, "speedtest");
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, "ookla-speedtest-win64.zip");
  const exePath = bundledCliPath(userDataDir);

  await downloadFile(OFFICIAL_WIN64_ZIP, zipPath);
  try {
    verifyOfficialZip(zipPath);
  } catch (err) {
    try {
      fs.unlinkSync(zipPath);
    } catch {
      /* ignore */
    }
    throw err;
  }

  await new Promise((resolve, reject) => {
    const ps = spawn(
      powershellExe(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`,
      ],
      { windowsHide: true }
    );
    let err = "";
    ps.stderr.on("data", (c) => {
      err += c.toString();
    });
    ps.on("error", reject);
    ps.on("close", (code) => {
      if (code !== 0) reject(new Error(err || `Expand-Archive failed (${code})`));
      else resolve();
    });
  });

  try {
    fs.unlinkSync(zipPath);
  } catch {
    /* ignore */
  }

  if (!fs.existsSync(exePath)) {
    // zip may nest a folder — search
    const walk = (d) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) {
          const found = walk(p);
          if (found) return found;
        } else if (name.toLowerCase() === "speedtest.exe") return p;
      }
      return null;
    };
    const found = walk(dir);
    if (found && found !== exePath) {
      fs.copyFileSync(found, exePath);
    }
  }
  if (!fs.existsSync(exePath)) {
    throw new Error("speedtest.exe not found after extracting official zip");
  }
  return { path: exePath, source: "bundled" };
}

function runCli(exePath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (running) {
      reject(new Error("A speed test is already running"));
      return;
    }
    cancelRequested = false;
    const child = spawn(exePath, args, {
      windowsHide: true,
      env: speedtestChildEnv(),
    });
    running = child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running = null;
      fn();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(() => {
        reject(new Error(`Speed test timed out after ${Math.round(timeoutMs / 1000)}s`));
      });
    }, timeoutMs);

    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      finish(() => reject(err));
    });
    child.on("close", (code) => {
      if (cancelRequested) {
        finish(() => {
          const err = new Error("Speed test cancelled");
          err.code = "CANCELLED";
          reject(err);
        });
        return;
      }
      finish(() => {
        if (code !== 0 && !stdout.trim()) {
          reject(new Error(stderr.trim() || `speedtest exited with code ${code}`));
          return;
        }
        resolve({ stdout, stderr, code });
      });
    });
  });
}

function cancelRun() {
  if (!running) return { cancelled: false };
  cancelRequested = true;
  try {
    running.kill();
  } catch {
    /* ignore */
  }
  return { cancelled: true };
}

async function runSpeedTest(userDataDir) {
  const cli = await resolveCli(userDataDir);
  if (!cli) {
    const err = new Error(
      "Ookla Speedtest CLI not found. Install via winget (Ookla.Speedtest.CLI), download from speedtest.net/apps/cli, or use Install CLI in this tab."
    );
    err.code = "CLI_MISSING";
    throw err;
  }
  const { stdout } = await runCli(
    cli.path,
    ["--format=json", "--accept-license", "--accept-gdpr", "--progress=no"],
    RUN_TIMEOUT_MS
  );
  // CLI may emit progress lines before JSON; take last JSON object
  const text = stdout.trim();
  let jsonText = text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) jsonText = text.slice(start, end + 1);
  const parsed = parseSpeedtestJson(jsonText);
  return { ...parsed, cli_path: cli.path, raw_json: jsonText };
}

module.exports = {
  parseSpeedtestJson,
  bandwidthToMbps,
  resolveCli,
  getStatus,
  installOfficialCli,
  runSpeedTest,
  cancelRun,
  runCli,
  speedtestChildEnv,
  isAllowedDownloadUrl,
  isTrustedCliPath,
  verifyOfficialZip,
  sha256File,
  OFFICIAL_WIN64_ZIP,
  OFFICIAL_WIN64_SHA256,
  RUN_TIMEOUT_MS,
};
