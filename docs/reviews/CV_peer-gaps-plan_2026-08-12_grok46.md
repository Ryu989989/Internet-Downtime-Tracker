# Cross-verify: peer-gaps plan (isolated grok46)

**Date:** 2026-08-12
**Reviewer:** grok46 (`cursor-grok-4.6-xhigh`)
**Artifact:** `c:\Users\reinh\.cursor\plans\peer_gaps_info_pass_e41ce007.plan.md`
**Repo:** `E:\Internet Downtime Tracker` (readonly)
**Claims attacked:** `_tick` coupling; privilege honesty; `web/app.js` file-ownership; `checkHttp` cert days; 30d uptime from probes/summary; NetBIOS/DNS hostname; LLDP edge map; skip-list vs locked ship; `bindTooltips` coverage; Devices empty when `lan_devices_enabled=false`
**Open BLOCKING:** 2
**Gate:** FAIL / CLEAR_FORBIDDEN

Sibling `CV_peer-gaps-plan_*` files were not read.

## Counts

| reviewer | BLOCKING | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| grok46 | 2 | 6 | 5 | 2 |

## Claims that held

- Devices disabled is silent-empty: `lan-bridge.js` `listDevices`/`refreshDevices` return `{ok:false, devices:[], warning}`; `web/app.js` `refreshDevicesPanel` always paints `${n} devices · passive neighbor cache` and “No devices yet — click Refresh”. IPC `api:lan:devices:refresh` passes the object through.
- `bindTooltips` / `has-tip` / `LAYER_TIPS` / `wireChartTip` exist; Connections + Topology re-bind after render; Usage 24h trend does **not** call `wireChartTip`.
- LLDP `to` is rem sysName; graph lookup is IP-first so edges miss. Neighbor-mode gateway star already exists and is honest.
- Electron stays unelevated: no `requestedExecutionLevel`; Usage is a separate UAC helper; Connections already documents `"?"` process names without admin.
- Grep contract as written is currently true: `_tick` only probes / prune / adapter / quality burst — not LAN/usage/topology/sniffer/scan.
- Skip of WinDivert / GeoIP / public bind / RDP-shutdown / Close Connection / ARP-as-complete-map matches live code (`metrics-api.js` `BIND_HOST=127.0.0.1`; no WinDivert/GeoIP/tracert/NetBIOS/Close Connection).

## Findings

| id | track | slug | severity | claim | evidence_path | fix_owner | status | reviewer |
|----|-------|------|----------|-------|---------------|-----------|--------|----------|
| CV-PROCESS-001 | process | null | BLOCKING | `web/app.js` is parent-only after Wave 2; Wave 3 topology also writes it; regions are pre-split | plan File-ownership + Parallel build mermaid; `web/app.js` monolith | process | open | grok46 |
| CV-APP-001 | app | null | BLOCKING | 30d uptime bar from existing `probes`/`summary` | `electron/db.js` `probe_retention_days: 14`, `summary().windows`, `sparkline_24h` | app | open | grok46 |
| CV-APP-002 | app | null | HIGH | HTTPS cert days via `checkHttp` | `electron/netcheck.js` `checkHttp` + `DEFAULT_HTTP_URL`; `electron/monitor.js` `_runProbe`/`_tick` | app | open | grok46 |
| CV-APP-003 | app | null | HIGH | Ping/traceroute reuse `netcheck.js` | no `traceroute`/`tracert` in repo; `pingHost` only | app | open | grok46 |
| CV-APP-004 | app | null | HIGH | NetBIOS/DNS hostname when empty | `lan-devices.js` `shapeNeighbor` (no hostname); zero NetBIOS hits | app | open | grok46 |
| CV-APP-005 | app | null | HIGH | Layer pill tips from existing last latency / fail reason | `monitor.js` state: `latency_ms` + ok flags only | app | open | grok46 |
| CV-APP-006 | app | null | HIGH | New-exe first-seen toast (helper) | `db.js` `usage_apps` has no `first_seen`; no Wave 2 owner | app | open | grok46 |
| CV-APP-007 | app | null | HIGH | No `_tick` coupling while cert/30d/quality live on the probe path | `monitor.js` `_tick` → `_runProbe` → `checkHttp`; `_maybeQualityBurst` | app | open | grok46 |
| CV-APP-008 | app | null | MEDIUM | LLDP map sysName/IP to node ids (sufficient) | `snmp-topology.js` edges; `web/app.js` `topologyGraphHtml` `byId` | app | open | grok46 |
| CV-APP-009 | app | null | MEDIUM | After every dynamic table render, `bindTooltips(container)` | `web/app.js` bind sites vs History/Devices/Usage/Sniffer/Scan/Speed | app | open | grok46 |
| CV-APP-010 | app | null | MEDIUM | Privilege honesty for service name + Settings tips | `connections.js` Get-NetTCPConnection; `LAYER_TIPS` conn-process; Settings checkboxes | app | open | grok46 |
| CV-APP-011 | process | null | MEDIUM | Skip-list complete vs locked ship | plan Research vs Workstream 2–3; `probe_retention` write amp | process | open | grok46 |
| CV-APP-012 | app | null | MEDIUM | Last-scan port chips if present in DB | `db.js` `listLanScanResults` (global limit 20, no by-IP) | app | open | grok46 |
| CV-APP-013 | app | null | LOW | Session bytes on adapter chips | `connections.js` `computeAdapterRates` (last sample + NIC counters) | app | open | grok46 |
| CV-APP-014 | process | null | LOW | Wave 3 files include `lan-devices.js` neighbor star | `lan-devices.js` `neighborTopologyFromDevices` already ships | process | open | grok46 |

---

### CV-PROCESS-001 — BLOCKING

**claim:** File-ownership prevents two writers on `web/app.js`; Wave 2 tooltips write it only if regions are pre-split; after Wave 2 it is parent-only; Wave 3 topology writes topology functions there.

**evidence:** `web/app.js` is one file: `bindTooltips`, `refreshDevicesPanel`, `topologyGraphHtml`, `renderConnRows`, `ensureUsageTrend`, `paintStatus`. No pre-split regions. Plan mermaid has `wave2 --> Merge2` **and** `wave2 --> wave3` (Wave 3 concurrent with parent integrate). Collision rule: parent-only **after Wave 2**. Wave 3 ownership: topology **writes** `web/app.js`. Tooltip loophole: “write app.js only if pre-split” — they are not.

**attack:** Executing as written races parent `activateTab`/IPC wiring vs Wave 3 SVG click/pan/zoom vs any tooltip agent that “helpfully” edits the monolith. Lost diffs or double-bind bugs. `main.js`/`preload.js` same hazard if Wave 2 returns ping/DNS IPC names while Merge2 starts before Wave 3 finishes.

**fix:** One owner for `web/app.js` per wave. Wave 3 topology returns snippets; parent applies after Wave 3. Delete the pre-split loophole. Serialize Merge2 after Wave 3 only (already implied by `wave3 --> Merge2` — drop the parallel `wave2 --> Merge2` meaning).

---

### CV-APP-001 — BLOCKING

**claim:** “30d uptime bar (hourly/daily buckets from existing summary/probes — no new poller)”

**evidence:** Default `probe_retention_days: 14`; `pruneProbes` deletes older. `insertProbe` stores `lan_ok, wan_ok, latency_ms, dns_ok, http_ok` — no hourly uptime rollup. `summary()` already has `windows["30d"]` as a **scalar** downtime_pct/count from **outages**, `sparkline_24h` (24 hourly downtime seconds), `by_hour`/`by_dow` (outage-start histograms, not a 30-day strip). Outages are not pruned. sql.js persist is already called out as high-churn.

**attack:** A Kuma-style 30-day bar cannot be built from probes at default retention. Using 14d of probes and labeling 30d is a forged metric. Raising retention to 30d is write amplification on every `_tick` (conflicts with NetWorx skip of always-on billing DB). Honest bar = daily segments from **outages**, capped to `observeSince` / first probe, labeled for short history — plan does not say that.

**fix:** Specify outages + observation-window cap; forbid probe-retention bump for this feature; UI must not say “30d” when observed < 30d.

---

### CV-APP-002 — HIGH

**claim:** “HTTP(S) probe returns cert remaining days when URL is https (`netcheck.js` `checkHttp`); pill + tooltip”

**evidence:** `checkHttp` resolves `[ok, latency]` only; response handler never reads `socket.getPeerCertificate()`. `DEFAULT_HTTP_URL` / `DEFAULT_SETTINGS.http_url` = `http://connectivitycheck.gstatic.com/generate_204`. Tests destructure `[ok, lat]`. `_runProbe` → `probe()` → `checkHttp` runs **inside** `_tick`. Wave 2 Overview owns `netcheck.js` / optional `db.js`, **not** `monitor.js`. Pills read `monitor` snapshot (`http_ok` only).

**attack:** Today `checkHttp` cannot return cert days. Default install is HTTP → shipped “cert days” is always empty unless URL is changed or a **second** HTTPS request is added on the tick. Extra fields on `probe()` are ignored unless `monitor._applyProbe`/`state` change (unowned). Empty/zero cert on the HTTP pill is dishonest Kuma parity.

**fix:** Keep tuple or version the return; parse cert only on `https:`; surface `N/A (HTTP URL)` ; own `monitor.js` in the same wave **or** a dedicated IPC not on `_tick`; do not add a second HTTPS fetch inside `_tick`.

---

### CV-APP-003 — HIGH

**claim:** Devices ping/traceroute “reuse `electron/netcheck.js`”

**evidence:** `pingHost` (ping.exe) exists. Repo grep: zero `traceroute` / `tracert`.

**attack:** Traceroute is new process spawn, timeouts, and privilege/firewall behavior — not reuse. Risk of putting `tracert` in `lan-devices.snapshot()` (slow refresh) or on a timer.

**fix:** Ship ping-only, or add an on-demand IPC (`tracert`) with hop cap/timeout; keep it off snapshot and off `_tick`. Update the Yes-row.

---

### CV-APP-004 — HIGH

**claim:** “NetBIOS or reverse-DNS hostname when empty (same rate limits)”

**evidence:** `shapeNeighbor` never sets `hostname`. Merge only preserves prior. No NetBIOS/`nbtstat`/`dns.reverse` callers. `lan_devices.hostname` column exists but ARP path leaves it null. RFC1918 PTR usually NXDOMAIN.

**attack:** “When empty” is almost always. Reverse-DNS will look like a no-op. NetBIOS is new UDP/137 or `nbtstat` (often firewalled). Doing N lookups inside `snapshot()` makes Refresh an active scan while still claiming “passive neighbor cache” (disclaimer in `parseSnapshot` / Devices meta). Conflicts with “no claiming a complete LAN map from ARP” if UI shows guessed names as facts.

**fix:** On-demand or strict rate-limit **after** ARP snapshot; label source (`PTR`/`NBT`/`none`); keep meta “passive cache” only when names were not actively queried; skip NetBIOS if PTR is the honest default.

---

### CV-APP-005 — HIGH

**claim:** “Richer layer pill tips: last latency, last fail reason if already in state” / PRTG “each layer’s last latency/ok”

**evidence:** `probe()` computes per-layer latencies then returns one `latency_ms` (LAN preferred). `monitor` state: `lan_ok/wan_ok/dns_ok/http_ok`, `latency_ms`, `quality` burst — no per-layer RTT, no fail reason string. `LAYER_TIPS` is static meaning text. `paintStatus` does not set `data-tip-text`.

**attack:** “If already in state” hedges fail reason (honest skip). Last **per-layer** latency is **not** in state. Implementers will invent it or show the same `latency_ms` on every pill (misleading).

**fix:** Either extend `probe()` + `monitor` snapshot (own `monitor.js`) or drop per-layer latency from the Yes-row and tip only ok + static meaning + combined RTT.

---

### CV-APP-006 — HIGH

**claim:** “Usage: new-exe first-seen tray toast (opt-in, helper required)”

**evidence:** `usage_apps` columns: `app_key, display_name, exe_path, ignored` — no first-seen. File-ownership Wave 2: Connections / Devices / Overview / HTML+CSS. No owner for `usage-bridge.js` / usage DB. LAN already has `lan_new_device_toast` (different feature).

**attack:** Locked GlassWire partial has no implementer and no schema. Easy to skip silently or overload LAN toast.

**fix:** Assign `usage-bridge.js` + `db.js` usage_apps migration to one agent (not Overview netcheck), or drop from this pass.

---

### CV-APP-007 — HIGH

**claim:** Locked: no `monitor._tick` coupling. Grep: LAN/usage/topology/sniffer/scan not called from `_tick`. Overview reads `monitor.js`; no `_tick` edits. Ping/traceroute not on `_tick`.

**evidence:** `_tick` → `_runProbe` → `checkHttp` / `checkDns` / `checkWan`. Also `_maybeQualityBurst` (`pingBurst`) on the same timer. Cert-in-`checkHttp` and any extra HTTPS for TLS **are** on `_tick` without matching the grep. sql.js `insertProbe`+`_persist` already every successful tick.

**attack:** Grep contract is too narrow. Cert days, heavier HTTP, or probe_retention 30d all couple work to the probe timer while still grepping clean. Plan gives a false safety net.

**fix:** Extend grep to `checkHttp` cost / extra requests; forbid second network call from `_tick`; keep cert on the existing https response only; 30d from outages not probes.

---

### CV-APP-008 — MEDIUM

**claim:** “LLDP `to` resolution: map sysName/IP to node ids (today edges can miss positions)”

**evidence:** `edges.push({ from: h.ip, to: String(n).slice(0, 64), type: "lldp" })` with `n` from `LLDP_REM_SYS` (sysName). `topologyGraphHtml` `byId.set(String(point.node.ip || point.node.label || point.index))` — SNMP nodes always have `ip`, so keys are IPs; `byId.get(sysName)` fails. `enrichTopologyWithDevices` remaps node labels, **not** edges. Only one LLDP OID (sysName), not `lldpRemManAddr`. Unpolled neighbors never get nodes.

**attack:** sysName→existing node IP is necessary and still incomplete. Plan tests “LLDP edge mapping” can pass a happy-path helper and leave real edges dropped.

**fix:** Build `sysName→ip` and `ip→node`; also map management address if polled; stub or drop unpolled `to` with a counted warning; tests must use sysName `to` vs IP-keyed layout.

---

### CV-APP-009 — MEDIUM

**claim:** Reuse `bindTooltips`; after every dynamic table render call `bindTooltips(container)`. Surfaces: Overview, History, Patterns, Logs, Devices, Connections, Usage, Topology, Sniffer, Scan, Speed, Settings.

**evidence:** Bind after render only: timeline (`1410`), topo tbody/graph (`2287`/`2293`), conn adapter strip (`2561`), conn tbody (`2640`), plus `setupTooltips` once on `document`. **Not** called: `renderOutageRows` / History / Patterns, `renderSystemLogRows`, `refreshDevicesPanel`, `renderUsageLiveRows`, `refreshSnifferPanel`, Scan, `renderSpeedHistory`. `ensureUsageTrend` never `wireChartTip`. History rows have no `has-tip`. Settings `lan_devices_enabled` has no `data-tip`. Static pills keep `data-tip="lan"` — richer last-ok/latency requires rewriting `data-tip-text` on each `paintStatus` **and** re-bind (or don’t use `data-tipBound` skip).

**attack:** Plan under-specifies call sites. `data-tipBound` means updating `data-tip-text` on already-bound pills will not rebind; Overview richer tips can silently stay static.

**fix:** Name functions; re-bind or mutate bound nodes; `wireChartTip(usageTrendChart, …)` on create **and** data update; Overview: set `data-tip-text` in `paintStatus`.

---

### CV-APP-010 — MEDIUM

**claim:** Electron non-elevated by default; Connections works without admin; Usage needs helper; Settings tips for privilege consequences. Service name via cached `Get-CimInstance Win32_Service`.

**evidence:** No manifest `requestedExecutionLevel` (nsis default asInvoker). Helper path is honest. `Get-NetTCPConnection` already unelevated with `"?"` names (`LAYER_TIPS` conn-process). Win32_Service join is new; some PIDs stay unnamed without admin. Reverse-DNS / NetBIOS / ping.exe usually unelevated; not the same as “complete TCPView”. Settings: usage/control have copy; `lan_devices_enabled` does not.

**attack:** Shipping service names without the same “may be blank without admin” tip repeats a solved honesty bug. CIM on every Connections auto-refresh can hitch the unelevated app (plan says cache — must be once-per-process, not per snapshot).

**fix:** Cache services once; Settings + Connections tips: service/DNS/NetBIOS may be empty without admin; do not imply TCPView-complete.

---

### CV-APP-011 — MEDIUM

**claim:** Locked skip list is complete vs locked ship Yes-rows.

**evidence / holes not skipped but implied by ship:**

- Extra HTTPS or `http_url` flip for cert (changes probe meaning).
- `probe_retention_days` 14→30 (write amp vs NetWorx skip).
- New `tracert` / NetBIOS UDP 137 (active, not ARP-passive).
- Kuma 90d bars, maintenance windows, public status (90d not listed; 30d substituted without saying “not 90d”).
- Fing presence timeline (only first/last in tips — OK if named skip).
- GlassWire time-machine graph (skipped implicitly).

**fix:** Add explicit skips: no second probe on `_tick`; no retention bump for 30d; traceroute optional/on-demand; NetBIOS not in ARP snapshot; “30d not 90d”; no maintenance windows.

---

### CV-APP-012 — MEDIUM

**claim:** “Show last Scan open-port chips if present in DB”

**evidence:** `lan_scan_results` keyed by `target_ip`. API: `insertLanScanResult`, latest row, `listLanScanResults({limit:20})` global — **no** `getLatestScanForIp`. Devices Wave 2 owns `lan-devices.js` not `db.js` (Overview optional `db.js`).

**attack:** Joining last 20 scans to 500 devices misses older hosts; looks like “no ports” when DB has them.

**fix:** `SELECT … WHERE target_ip=? ORDER BY started_at DESC LIMIT 1`; assign db helper to Devices wave.

---

### CV-APP-013 — LOW

**claim:** NetWorx “session bytes + rate on adapter chips”

**evidence:** `Get-NetAdapterStatistics` cumulative `rx_bytes`/`tx_bytes`; `computeAdapterRates` keeps **one** previous sample for Mbps. No session baseline (since tracker start). UI chips: Mbps only (`data-tip="conn-adapter-mbps"`).

**fix:** Store first sample as session origin, or say “since last refresh” not “session”.

---

### CV-APP-014 — LOW

**claim:** Wave 3 files include `electron/lan-devices.js` neighbor star.

**evidence:** `neighborTopologyFromDevices` already builds gateway-star edges. Wave 3 ownership writes `snmp-topology.js` + `app.js` only; `lan-devices.js` is Wave 2 Devices. Neighbor-star work is already shipped or unowned.

**fix:** Drop `lan-devices.js` from Wave 3 write-set unless SNMP mapping helpers move there **after** Wave 2 with a single owner.

---

## Disagreements

Isolated reviewer — none.

## Art routing

None (plan/code review, no cover art).

## Gate note

Do not start Wave 2–3 until CV-PROCESS-001 (app.js owners) and CV-APP-001 (30d data source) are rewritten. HIGH items will otherwise ship empty cert, fake 30d, traceroute-that-isn’t-reuse, and NetBIOS-as-passive.
