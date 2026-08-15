# Peer gaps + info/tooltip pass (2026-08-12)

Locked after merged CV `docs/reviews/CV_peer-gaps-plan_2026-08-12.md` vs live code. Approach **B**: information pass + Yes rows below. No `monitor._tick` coupling of LAN/usage/topology/sniffer/scan or **new IPC from this spec**. Electron **non-elevated by default**. Usage still needs the elevated helper.

**Status:** remaining **BLOCKING=0** after summary-clock fix (`api:summary` / export pass MIN(first probe, first outage) into `db.summary`, not session `started_at`). Do not stamp `CLEAR_OK` / “all CV findings implemented” for leftover non-BLOCKING. `npm test` 142/142; unpacked rebuild this wave (`dist\win-unpacked\Internet Downtime Tracker.exe`); not relaunched.

## Live contracts (do not invert)

| Topic | Live today | This pass |
|-------|------------|-----------|
| `checkHttp` | `[ok, latency]` only (`electron/netcheck.js`). Default `http_url` is **HTTP**. | **EXTEND** `checkHttp` → `[ok, latency, certDays\|null]`; `probe()` adds `http_cert_days`. Parse peer cert **only** on the existing `https:` response (`getPeerCertificate`). No second fetch on `_tick`. HTTP URL → UI `N/A (HTTP URL)`, never `0`. Parent copies `http_cert_days` into monitor snapshot / `_applyProbe` **without changing `_tick` control flow**. Tests today destructure 2-tuple — keep 3rd element optional-safe. |
| 30d | `probe_retention_days` **14**; `pruneProbes` deletes older. `summary().windows["30d"]` = outage overlap **aggregate** (`downtime_pct`/`count`), not hourly buckets. `sparkline_24h` = 24 hourly outage seconds. Latency spark = 6h probes. Outages are **not** pruned. | **Honest 30d (picked):** (1) number = `windows["30d"]` uptime/downtime % (outages). If observation window (`observeSince` / first probe) **&lt; 30d**, label actual days, not “30d”. (2) sparkline/bar = existing `sparkline_24h` and/or probe spark labeled with **`probe_retention_days`** (default 14d). **Never** label 14d probe data as 30d. **Do not** raise `probe_retention_days`. Optional extra: 30 **daily** outage buckets (same overlap math as `sparkline_24h`) — only that visual may be captioned 30d, and only if observed ≥ 30d. No new poller. |
| traceroute | **Not in netcheck.** `pingHost` / `pingBurst` only. | **ADD** `tracerouteHost` in **`electron/traceroute.js`** (Devices-owned; `tracert` hop cap + timeout). Ping IPC wraps existing `netcheck.pingHost`. Do **not** say “reuse netcheck traceroute”. On-demand IPC only — not `snapshot()`, not `_tick`. |
| `web/app.js` | Monolith; not pre-split. | See File ownership. |
| NetBIOS / rDNS | `shapeNeighbor` has no hostname; column exists but ARP path leaves it null. | **New work** in `electron/lan-devices.js` (not “already there”). |
| TCPView sent/recv | `Get-NetTCPConnection` has **no** byte counters here. Adapter NIC Rx/Tx rates already exist. | **SKIP** per-connection sent/recv. Do not add Win32 byte counters on Connections in this pass. |
| `fail_reason` | Monitor state: `lan_ok`/`wan_ok`/`dns_ok`/`http_ok`, `latency_ms`, `failure_domain`, `last_probe_at`, `quality`. **No** `fail_reason`, no per-layer RTT. | Richer pill tips use **only those fields**. Do **not** add `fail_reason` (would need `_applyProbe`/`_tick`). Do not show the same `latency_ms` as if it were per-layer. |
| Devices disabled | Bridge returns `{ok:false, devices:[], warning}`; `refreshDevicesPanel` ignores it → “0 devices”. Connections uses `data.warning` on meta + error row. | **Show warning** when `lan_devices_enabled=false` — mirror Connections (`web/app.js` ~2661–2665). |
| Privilege | No `requestedExecutionLevel`; Usage = separate UAC helper. | Unchanged. Connections still works unelevated (`?` names). Usage helper still required for usage. Settings tips: service/DNS/NetBIOS may be empty; do not claim TCPView-complete. |

## 8-loop matrix (locked ship / skip)

| Peer | They do better | IDT today | This pass |
|------|----------------|-----------|-----------|
| **GlassWire** | Time-machine graph; rDNS + country; new-app alert | Usage table + 24h chart (no chart tips); no DNS on remotes | **Partial:** Connections reverse-DNS toggle; new-exe toast (helper; first `upsertUsageApp` INSERT — no `first_seen` column required); Usage `wireChartTip`. **Skip:** GeoIP, mini-widget, Ask-to-connect, time-machine graph |
| **Fing** | Category, ping/traceroute/DNS, presence timeline | IP/MAC/vendor/alias; no row ping | **Yes:** OUI category; ping + **new** traceroute helper; first/last seen in tips. **Skip:** Fing presence timeline |
| **NetLimiter** | Per-connection limits, scheduler, log | Block + caps JSON; Usage rates | **Skip** limits/scheduler. **Yes:** Usage chart tips; connection-count already on Topology |
| **Advanced IP Scanner** | NetBIOS, SMB/HTTP chips, WOL, CSV | WOL + export; hostname often empty | **Yes:** **new** NetBIOS/rDNS in `lan-devices.js`; last-scan port chips (`SELECT … WHERE target_ip=? ORDER BY started_at DESC LIMIT 1`). **Skip:** RDP, remote shutdown, SMB browse |
| **TCPView** | Resolve, delta colors, service name, **sent/recv** | proto/process/PID/endpoints/state | **Yes:** resolve toggle (`connections_resolve_dns` default **off**), new/changed highlight, service name (cached `Win32_Service` once per process). **Skip:** Close Connection. **SKIP sent/recv** (no Win32 byte counters on Connections) |
| **Uptime Kuma** | Ping charts, TLS cert, 90d bars, maintenance | Layered probes + 24h timeline | **Yes:** HTTPS cert days (extend `checkHttp`); honest 30d **%** + honestly labeled sparkline. **Skip:** public status page, 90d bars, maintenance windows |
| **NetWorx** | Adapter day/week/month totals, tray graph | Adapter Mbps on Connections | **Yes:** session origin bytes + rate on adapter chips/tips (first sample = session start, or label “since last refresh” if not stored). **Skip:** always-on billing DB; **no** `probe_retention_days` bump |
| **PRTG** | Independent sensors + maps | Layered probes | **Yes:** layer pills tip ok + combined `latency_ms` + `failure_domain` + `last_probe_at`. **Skip:** 250-sensor platform; invented per-layer RTT / `fail_reason` |

**Also skip (locked):** WinDivert/throttle/Ask-to-connect; public bind; GeoIP DB; RDP/remote-shutdown; claiming a complete LAN map from ARP; second network call from `_tick`; traceroute inside `snapshot()` or `_tick`; NetBIOS inside ARP snapshot (rate-limit **after** snapshot or on-demand; label source `PTR`/`NBT`/`none`; drop “passive cache” meta when names were actively queried).

## File ownership (no dual writers)

| Wave | Agent | May write | Must not write |
|------|-------|-----------|----------------|
| 2 | Tooltips/UI | `web/index.html`, `web/styles.css`, **`web/snippets/tooltips.js.txt`** (returned list of insertion points) | `web/app.js`, `electron/*` |
| 2 | Connections | `electron/connections.js` + connection tests | `app.js`, `main.js`, `preload.js`, `lan-devices.js`, `netcheck.js` |
| 2 | Devices | `electron/lan-devices.js`, **`electron/traceroute.js`**, devices/traceroute tests; may add `db.js` **`getLatestScanForIp(ip)` only** | `app.js`, `netcheck.js`, `monitor.js` |
| 2 | Overview/cert | `electron/netcheck.js` + netcheck tests (`checkHttp` 3-tuple + `probe().http_cert_days`) | `app.js`, `monitor.js`, `lan-devices.js`. **No** `db.js` retention change |
| 2→3 | **Parent** | `web/app.js` (apply tooltip snippets), `electron/main.js`, `electron/preload.js`, `electron/monitor.js` (copy `http_cert_days` into state/snapshot only — **no `_tick` edits**), `electron/usage-bridge.js` (new-exe toast on first INSERT), `electron/lan-bridge.js` ping/traceroute IPC wrappers if not in lan-devices | — |
| 3 | Topology UI | Topology fns in `web/app.js` **only after parent merged tooltip snippets:** `topologyLayout`, `topologyNodeTip`, `topologyDetailHtml`, `topologyGraphHtml`, `refreshTopologyPanel` + new click/pan/zoom helpers | Tooltip/`paintStatus`/Devices/Connections/Usage regions; `electron/*` |
| 3 | SNMP/LLDP | `electron/snmp-topology.js` + tests (`sysName→ip` / `ip→node`; stub unpolled `to` with counted warning) | `lan-devices.js` (neighbor star **already ships**; do not retake). `app.js` |

Collision: `app.js` / `main.js` / `preload.js` are parent-only during Wave 2. Wave 2 returns snippet + IPC names; parent wires `activateTab`, preload allowlist, `registerIpc` in one pass.

## Workstream 1 — Tooltips (Wave 2 UI + parent `app.js`)

Reuse `bindTooltips` / `has-tip` / `data-tip-text` / `LAYER_TIPS`. After every dynamic table render, `bindTooltips(container)`. Re-bind or mutate bound nodes (`data-tip-bound` skip). Overview: set `data-tip-text` in `paintStatus`. `wireChartTip` on Usage 24h create **and** data update. Keyboard: existing chart tip path.

Surfaces: Overview pills/stats/quality/provider/split-pills/recent outages; History/Patterns/logs; Devices; Connections; Usage; Topology; Sniffer/Scan; Speed history; Settings privilege tips.

UI: `:active` scale on buttons; tooltip skip-delay after first; `prefers-reduced-motion` on topology layout only.

Devices `lan_devices_enabled=false`: meta + error row from `data.warning` (Connections pattern).

## Workstream 2 — Feature gaps

**Connections** (`connections.js`): rDNS cache (N lookups/snapshot, timeout, toggle default off); well-known port names (local map); cached Win32_Service join (once per process, not per snapshot); CSS highlight new/dropped/state-changed (1 cycle). **No sent/recv.**

**Devices** (`lan-devices.js`): OUI category (router/phone/pc/iot/unknown); NetBIOS or PTR when hostname empty (rate-limit after ARP; label source); row Ping / Traceroute IPC; last-scan chips via per-IP DB lookup.

**Overview:** cert days on HTTP pill + tip; honest 30d % + labeled sparkline; richer tips from existing monitor fields only.

**Usage:** opt-in new-exe tray toast when `upsertUsageApp` first INSERT (`existing == null`); helper required; parent-owned.

## Workstream 3 — Topology

- Click node ↔ row select; selected node short label (others hover-only).
- LLDP: map sysName/IP to node ids; tests must use sysName `to` vs IP-keyed layout; unpolled `to` stubbed + warning count. Neighbor-mode gateway star stays honest (no fake switch fabric).
- Legend (gateway / neighbor / snmp / selected). Pan/zoom (wheel + drag; reduced-motion = buttons only). Collision-avoid selected label only.

## New IPC (parent `main.js` / `preload.js`; not on `_tick`)

| Channel | Owner backend | Notes |
|---------|---------------|--------|
| `api:lan:devices:ping` | lan-devices → `pingHost` | on-demand |
| `api:lan:devices:traceroute` | lan-devices → `traceroute.js` | hop cap/timeout |
| `api:connections:snapshot` | existing; may honor `connections_resolve_dns` | still tab-visible only |

Settings: `connections_resolve_dns` default false.

## Grep / test contract

Must stay true of `electron/monitor.js` `_tick` **and** `main.js`:

- No calls to lan-devices / lan-bridge / usage-bridge / connections / snmp-topology / sniffer / scan / **`traceroute` / `tracerouteHost` / `api:lan:devices:ping` / `api:lan:devices:traceroute`**.
- No second HTTP(S) request from `_tick` (cert rides existing `checkHttp` only).
- Extend `electron/test/lan-security.test.js` + `security.test.js` to grep **`monitor.js` source** (not only `main.js`) and the new channel names.

Also: full `npm test`; README matrix (Connections without admin; Usage needs helper; Scan private/known-device); rebuild `dist\win-unpacked\Internet Downtime Tracker.exe`; do not relaunch.

## Review gates

1. This spec + merged CV (done this step).
2. Wave 2 agents → parent integrate `app.js`/IPC/monitor snapshot field.
3. Wave 3 after tooltip merge.
4. Mega-review → post-impl triple CV → implement **all** findings → parent `npm test` + rebuild.
