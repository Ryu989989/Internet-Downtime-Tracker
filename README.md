# Internet Downtime Tracker

Cross-platform **Electron** tray app that monitors **LAN** (router/gateway), **WAN** (public internet), **DNS**, **HTTP**, and user-defined TCP/HTTP/PING targets, stores outages in SQLite, and shows an in-app dashboard.

## Features

- Probe every 5s (configurable): ICMP ping to default gateway with TCP fallback; WAN TCP to `1.1.1.1:443` and `8.8.8.8:53`; DNS + HTTP checks only when lower layers are up
- User-defined **Custom monitors** (TCP/HTTP/PING) with per-target history and independent intervals
- Debounced outages: **2 consecutive failures** to open, **1 success** to close; plus optional **degradation detection** when loss/latency/jitter thresholds breach N consecutive quality bursts
- Outage domains: `lan` | `wan` | `dns` | `http`
- Live quality strip (Overview): rolling 4-ping burst (~every 30s) for loss/jitter — informational only; never opens outages; suppressed during speed tests
- Automatic **Ookla speed tests** on a configurable interval (optional; 0 = off)
- Native notification channels: Discord, Slack, Telegram, ntfy, and SMTP email, in addition to generic HTTPS webhooks
- Cross-platform support: Windows, macOS, and Linux; platform-specific tooling falls back gracefully on non-Windows
- Honest 30d: downtime % uses outage overlap; if observation &lt; 30d the label is actual days, not “30d”. Probe spark is labeled with `probe_retention_days` (default 14d) — never as 30d
- TLS cert days on the HTTP pill: remaining days from the existing HTTPS probe only. HTTP URL → `N/A (HTTP URL)`, never `0`
- Incident snapshots on outage open/close (adapter, latency, layer flags) — expandable in History
- Stale-monitor banner when probes stop unexpectedly (not while Pause / speed test)
- Dashboard tabs: Overview, History, Patterns, System logs (OS-inferred gaps), **Network** (Devices / Connections / Usage / Topology / Sniffer / Scan), Monitors (custom targets), Speed (Ookla CLI), Settings
- Optional frameless **desktop status widget** (Settings or tray → Show desktop widget): live LAN/WAN/DNS/HTTP at a glance
- System tray: Open Dashboard, Show desktop widget, Pause/Resume, Start with Windows, Quit
- Single-instance lock; dashboard via `BrowserWindow` + IPC (no public bind). Opt-in Prometheus/HTTP API bind **127.0.0.1 only** (never `0.0.0.0`)
- Data under OS-appropriate user data directories (`%LOCALAPPDATA%\InternetDowntimeTracker\` on Windows, `~/Library/Application Support/InternetDowntimeTracker` on macOS, `~/.config/InternetDowntimeTracker` or the XDG config dir on Linux); same SQLite schema as the old Python app
- SQLite via **sql.js** (no native C++ build tools required)

### Capability matrix (Network + privilege)

| Capability | Privilege | Notes |
|------------|-----------|-------|
| **Devices** — neighbor cache, OUI, category, alias/notes, WOL, CSV/JSON; ping/traceroute on-demand | None (default on) | **Not** a complete network map. Opt-in new-device toast. Ping/traceroute are Devices row actions — not on the probe tick. |
| **Connections** — live TCP/UDP by process + adapter RX/TX Mbps | None (works without admin) | Snapshot while the app runs. Reverse-DNS (`connections_resolve_dns`) default **off**. **Not** per-app bytes; not billing-grade. |
| **Usage** — per-app download/upload rates, hourly/daily rollups, CSV export, ignore list | Elevated `.NET` ETW helper still required (UAC opt-in) | **Windows-only**. Electron stays unelevated. Named-pipe bridge. Local DB tables `usage_*`. |
| **Control** — usage alerts, data caps, Firewall block/unblock by exe | Master toggle **off** + elevated helper | **Windows-only**. Windows Firewall only. No WinDivert/throttle. |
| **Router poll** — ASUSWRT, Nighthawk/Orbi, UniFi, Omada | Opt-in; unofficial | Cap **4** enabled targets. Per-client RF + router CPU/WAN — **not** a complete RF map. Dual-vendor clients merge **by MAC** (latest RF on `lan_devices`; history keeps both sources). Host NIC series (SSID/BSSID/band/channel/signal, `netsh`/`iw`) **always** recorded while this PC is on Wi-Fi (~30s), even if router poll is off. ASUS: nonce login + `appGet.cgi`. Nighthawk/Orbi: SOAP `/soap/server_sa/` — port **5000** then **80** unless set; missing methods **404** (skip). UniFi: local OS API key (`X-API-KEY`) or cookie fallback; RFC1918/`.local`. Omada: controller HTTPS (often `:8043`). Merlin/ASUS SSH **chanim** is key-only OpenSSH (`BatchMode=yes`); no password SSH. ISP-locked/app-only firmware may disable SOAP. |
| **Wi-Fi RSSI alerts** — `wifi_weak` toast + notify | Opt-in `wifi_alerts_json` | Debounced weak streak (dBm else %). Empty `macs` = all Wi-Fi clients + this PC `host_nic`. Quiet hours honored. **Not** an outage type. |
| **Wi-Fi drop chronicle** — roam / disconnect / sleep vs ISP | None (Windows Event Log + host NIC) | Correlates WLAN-AutoConfig + Kernel-Power with LAN outages and optional router `wan_ok`. Verdict on Overview/History. **Not** an outage type. Sleep is labeled sleep. Windows Signal % is never converted to dBm. |
| **Router writes** — block/allow + guest SSID on/off | Master toggle **off** + confirm | `setClientBlocked` / `setGuestWifi` only. **No** firmware or reboot. Omada: block/allow only (guest skipped). Audit `router_actions`. Private host required. |
| **Topology** — SNMP sysName/IF-MIB + LLDP when present | SNMP community; Settings off by default | Seeds = gateway + Devices/Settings IPs. Cancel on leave. |
| **Sniffer** — metadata flow open/close ring buffer | Settings gate; always-on optional | Payloads off by default. Not full packet capture / Npcap. |
| **Scan** — top ports + offline CVE advisories; gated subnet discovery | User-triggered; still private/known-device only | CVE labeled advisory/stale. Discovery ≥5 min; probe suppress while running. |
| **Notifications** — outage/new-device/scan/monitor/`wifi_weak` + quiet hours | None | Generic HTTPS webhooks plus Discord, Slack, Telegram, ntfy, and SMTP email. Secret tokens are never logged. |
| **Custom monitors** — user-defined TCP/HTTP/PING targets | None | Per-target history in `monitor_checks`; independent intervals and notifications. |
| **Router webhook** — manual/auto quarantine-ish POST | Opt-in URL | Generic payload; no Omada/OPNsense plugin marketplace. |
| **Influx / ES push** | Opt-in tokens | Outbound only. |
| **Prometheus `/metrics` + HTTP API** | Opt-in | **127.0.0.1 only**; scrape `http://127.0.0.1:9108/metrics`. Import [`grafana/idt-router-poll.json`](grafana/idt-router-poll.json) (Prometheus datasource) for router CPU/WAN, Wi-Fi RSSI (online, max 50), chanim idle. API requires token. No embedded Grafana/Docker. |

Build the helper (once) before enabling Usage:

```powershell
cd helper\IdtUsageHelper
dotnet publish -c Release -o publish
```

Packaging copies the full `publish/` tree into `resources/helper` via electron-builder `extraResources` (exe + dlls + `*.json` + `amd64/`). The helper must not live only inside `app.asar` — Windows cannot spawn it from there.

Speed tests saturate the link. While a test runs, the monitor **suppresses probes** and Usage sampling is marked suppressed so saturated-link blips do not distort outage History or byte rollups.

### System logs

Scans Windows Event Logs (NetworkProfile, WLAN-AutoConfig, System NIC events, Kernel-Power) for disconnect/connect periods. Separate from live probe History. May miss ISP-only outages if the NIC stayed up; may flag local Wi‑Fi drops. Sleep overlaps are labeled sleep, not Wi-Fi faults; sleep/hibernate gaps can still be missing.

### Speed tests (Ookla CLI)

Uses the **official** Ookla Speedtest CLI (`speedtest.exe`) — no website scraping.

1. Install CLI: `winget install --id Ookla.Speedtest.CLI`, or download from [speedtest.net/apps/cli](https://www.speedtest.net/apps/cli), or use **Speed → Install CLI** (official Windows zip into app userData).
2. Open dashboard → **Speed** → **Run test**, or enable **Scheduled speed tests** in Settings to run automatically on an interval.
3. Results (download/upload Mbps, ping, jitter, packet loss, server, ISP, result URL) are stored in SQLite table `speed_tests`. Latest ISP + closest server also appear on **Overview**.

Speed tests saturate the link. While a test runs, the monitor **suppresses probes** (and ignores failure streaks for ~8s after) so the test does not create false LAN/WAN outages in History. System-log scanning stays on-demand (**Refresh**), not continuous.

Ookla's CLI terms allow personal / non-commercial use; review their EULA before automated or commercial use. First run accepts license/GDPR flags via CLI.

## Requirements

- Windows 10/11, macOS 12+, or a modern Linux distribution
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

## Build

### Windows

```powershell
npm install
npm run build
```

Output under `dist\`:

- NSIS installer
- Portable exe

### macOS

```bash
npm install
npm run build:mac
```

Output under `dist/`:

- DMG

### Linux

```bash
npm install
npm run build:linux
```

Output under `dist/`:

- AppImage
- deb package

## Use

| Action | How |
|--------|-----|
| Open dashboard | Tray → **Open Dashboard** (or double-click tray icon / widget) |
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

SQLite file: `%LOCALAPPDATA%\InternetDowntimeTracker\tracker.db` on Windows, `~/Library/Application Support/InternetDowntimeTracker/tracker.db` on macOS, or `~/.config/InternetDowntimeTracker/tracker.db` (or `$XDG_CONFIG_HOME`) on Linux.

Schema matches the Python app (`outages`, `probes`, `settings`) plus `speed_tests` for Ookla history, `snapshot_json` on outages, `monitor_checks` for custom monitor history, `degradation_windows` for degradation history, and optional `usage_apps` / `usage_hourly` / `usage_daily` / `usage_alert_state` when Usage is enabled. Existing DBs are reused as-is. The `port` setting remains in the DB for compatibility but is unused (Electron loads the UI with `loadFile` + IPC).

Persistence uses **sql.js** (WASM SQLite) writing the same `.db` file format so Python-era data continues to work. Quit the Python app before switching; if `tracker.db-wal` exists, leave the Python process exit cleanly so SQLite checkpoints first.

## Caveats

- After `npm run build`, relaunch the new package from `dist\` / `dist/` — an already-running old build will not pick up changes.
- sql.js loads the full DB into memory and rewrites the file on changes; fine for personal outage history, not for huge multi-GB DBs.
- ICMP ping may need network permissions; TCP to gateway `:80`/`:53` is used as fallback.
- While LAN is down, new WAN/DNS/HTTP outages are not opened.
- Chart.js is vendored under `web/vendor/` (offline OK after install).
- Autostart uses Electron login items and, on Windows, `HKCU\...\Run\InternetDowntimeTracker`.
- **Usage** and **Control** require the `.NET` ETW/Firewall helper and are therefore **Windows-only**; the UI hides/gates them on macOS/Linux.
- Packaged binaries are large (Electron runtime); accepted for personal use.
- First `npm install` downloads the Electron binary (GitHub/CDN). If that step is blocked, extract the matching platform zip (`electron-v*-win32-x64.zip`, `electron-v*-darwin-x64.zip`, `electron-v*-linux-x64.zip`) into `node_modules/electron/dist/` and write `path.txt` / `dist/version`.
- Python/`src/` is left for reference only — prefer `npm start` / `npm run build`.
- `better-sqlite3` was skipped (no VC++ toolset here); **sql.js** is the intentional fallback.
- macOS and Linux packaging use the same `electron-builder` config; `dmg` builds require macOS, and `AppImage`/`deb` require Linux.
