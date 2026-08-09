# Internet Downtime Tracker

Windows **Electron** tray app that monitors **LAN** (router/gateway), **WAN** (public internet), **DNS**, and **HTTP** separately, stores outages in SQLite, and shows an in-app dashboard.

## Features

- Probe every 5s (configurable): ICMP ping to default gateway with TCP fallback; WAN TCP to `1.1.1.1:443` and `8.8.8.8:53`; DNS + HTTP checks only when lower layers are up
- Debounced outages: **2 consecutive failures** to open, **1 success** to close
- Outage domains: `lan` | `wan` | `dns` | `http`
- Live quality strip (Overview): rolling 4-ping burst (~every 30s) for loss/jitter — informational only; never opens outages; suppressed during speed tests
- Incident snapshots on outage open/close (adapter, latency, layer flags) — expandable in History
- Stale-monitor banner when probes stop unexpectedly (not while Pause / speed test)
- Dashboard tabs: Overview, History, Patterns, System logs (OS-inferred gaps), **Network** (Devices / Connections / Usage / Topology / Sniffer / Scan), Speed (Ookla CLI), Settings
- System tray: Open Dashboard, Pause/Resume, Start with Windows, Quit
- Single-instance lock; dashboard via `BrowserWindow` + IPC (no public bind). Opt-in Prometheus/HTTP API bind **127.0.0.1 only** (never `0.0.0.0`)
- Data under `%LOCALAPPDATA%\InternetDowntimeTracker\` (same path/schema as the old Python app)
- SQLite via **sql.js** (no native C++ build tools required)

### Capability matrix (Network + privilege)

| Capability | Privilege | Notes |
|------------|-----------|-------|
| **Devices** — passive neighbor cache, OUI, alias/notes, WOL, CSV/JSON export | None (default on) | **Not** a complete network map. Opt-in new-device toast. |
| **Connections** — live TCP/UDP by process + adapter RX/TX Mbps | None (default on) | Snapshot while the app runs. **Not** per-app bytes; not billing-grade. |
| **Usage** — per-app download/upload rates, hourly/daily rollups, CSV export, ignore list | Elevated `.NET` ETW helper (UAC opt-in) | Electron stays unelevated. Named-pipe bridge. Local DB tables `usage_*`. |
| **Control** — usage alerts, data caps, Firewall block/unblock by exe | Master toggle **off** + elevated helper | Windows Firewall only. No WinDivert/throttle. |
| **Topology** — SNMP sysName/IF-MIB + LLDP when present | SNMP community; Settings off by default | Seeds = gateway + Devices/Settings IPs. Cancel on leave. |
| **Sniffer** — metadata flow open/close ring buffer | Settings gate; always-on optional | Payloads off by default. Not full packet capture / Npcap. |
| **Scan** — top ports + offline CVE advisories; gated subnet discovery | User-triggered; private/local IPs only | CVE labeled advisory/stale. Discovery ≥5 min; probe suppress while running. |
| **Notify webhooks** — outage/new-device/scan + quiet hours | None | HTTPS POST JSON; no Apprise dependency; secrets not logged. |
| **Router webhook** — manual/auto quarantine-ish POST | Opt-in URL | Generic payload; no Omada/OPNsense plugin marketplace. |
| **Influx / ES push** | Opt-in tokens | Outbound only. |
| **Prometheus `/metrics` + HTTP API** | Opt-in | **127.0.0.1 only**; API requires token. No embedded Grafana/Docker. |

Build the helper (once) before enabling Usage:

```powershell
cd helper\IdtUsageHelper
dotnet publish -c Release -o publish
```

Packaging copies the full `publish/` tree into `resources/helper` via electron-builder `extraResources` (exe + dlls + `*.json` + `amd64/`). The helper must not live only inside `app.asar` — Windows cannot spawn it from there.

Speed tests saturate the link. While a test runs, the monitor **suppresses probes** and Usage sampling is marked suppressed so saturated-link blips do not distort outage History or byte rollups.

### System logs

Scans Windows Event Logs (NetworkProfile, WLAN-AutoConfig, System NIC events) for disconnect/connect periods. Separate from live probe History. May miss ISP-only outages if the NIC stayed up; may flag local Wi‑Fi drops; sleep/hibernate gaps can appear or be missing.

### Speed tests (Ookla CLI)

Uses the **official** Ookla Speedtest CLI (`speedtest.exe`) — no website scraping.

1. Install CLI: `winget install --id Ookla.Speedtest.CLI`, or download from [speedtest.net/apps/cli](https://www.speedtest.net/apps/cli), or use **Speed → Install CLI** (official Windows zip into app userData).
2. Open dashboard → **Speed** → **Run test** (manual only — no automatic interval).
3. Results (download/upload Mbps, ping, jitter, packet loss, server, ISP, result URL) are stored in SQLite table `speed_tests`. Latest ISP + closest server also appear on **Overview**.

Speed tests saturate the link. While a test runs, the monitor **suppresses probes** (and ignores failure streaks for ~8s after) so the test does not create false LAN/WAN outages in History. System-log scanning stays on-demand (**Refresh**), not continuous.

Ookla's CLI terms allow personal / non-commercial use; review their EULA before automated or commercial use. First run accepts license/GDPR flags via CLI.

## Requirements

- Windows 10/11
- Node.js **18+** (dev / build)

## Dev run

```powershell
cd "E:\Internet Downtime Tracker"
npm install
npm start
```

Unit smoke tests (monitor debounce + netcheck):

```powershell
npm test
```

## Build Windows exe

```powershell
npm run build
```

Output under `dist\`:

- NSIS installer
- Portable exe

## Use

| Action | How |
|--------|-----|
| Open dashboard | Tray → **Open Dashboard** (or double-click tray icon) |
| Pause probes | Tray → **Pause** / **Resume**, or **Settings** |
| Autostart | Tray → **Start with Windows**, or **Settings** |
| Quit | Tray → **Quit** (closing the window only hides to tray) |

### Status colors

| Icon | Meaning |
|------|---------|
| Green | LAN + WAN OK (DNS/HTTP not failing) |
| Amber | LAN up, WAN/DNS/HTTP down — or monitor stalled |
| Red | LAN down |
| Gray | Paused / unknown |

## Layout

```
electron/     main, preload, db, monitor, netcheck, system-logs, connections, usage-bridge, usage-control, speedtest, autostart, icons
helper/       IdtUsageHelper (.NET elevated ETW + Firewall helper)
web/          dashboard (Chart.js vendored)
src/          archived Python implementation (not used for normal runs)
package.json  Electron + electron-builder
```

## Data / migration

SQLite file: `%LOCALAPPDATA%\InternetDowntimeTracker\tracker.db`

Schema matches the Python app (`outages`, `probes`, `settings`) plus `speed_tests` for Ookla history, `snapshot_json` on outages, and optional `usage_apps` / `usage_hourly` / `usage_daily` / `usage_alert_state` when Usage is enabled. Existing DBs are reused as-is. The `port` setting remains in the DB for compatibility but is unused (Electron loads the UI with `loadFile` + IPC).

Persistence uses **sql.js** (WASM SQLite) writing the same `.db` file format so Python-era data continues to work. Quit the Python app before switching; if `tracker.db-wal` exists, leave the Python process exit cleanly so SQLite checkpoints first.

## Caveats

- After `npm run build`, relaunch the new exe from `dist\` — an already-running old build will not pick up changes.
- sql.js loads the full DB into memory and rewrites the file on changes; fine for personal outage history, not for huge multi-GB DBs.
- ICMP ping may need network permissions; TCP to gateway `:80`/`:53` is used as fallback.
- While LAN is down, new WAN/DNS/HTTP outages are not opened.
- Chart.js is vendored under `web/vendor/` (offline OK after install).
- Autostart uses Electron login items **and** `HKCU\...\Run\InternetDowntimeTracker`.
- Packaged binaries are large (Electron runtime); accepted for personal use.
- First `npm install` downloads the Electron binary (GitHub/CDN). If that step is blocked, extract a matching `electron-v*-win32-x64.zip` into `node_modules/electron/dist/` and write `path.txt` / `dist/version`.
- Python/`src/` is left for reference only — prefer `npm start` / `npm run build`.
- `better-sqlite3` was skipped (no VC++ toolset here); **sql.js** is the intentional fallback.
