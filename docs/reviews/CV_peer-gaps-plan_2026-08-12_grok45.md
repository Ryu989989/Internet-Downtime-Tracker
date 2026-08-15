# Cross-verify (isolated): Peer Gaps Info Pass plan

**Date:** 2026-08-12  
**Reviewer:** grok45 (`cursor-grok-4.5-high`)  
**Claims attacked:** `c:\Users\reinh\.cursor\plans\peer_gaps_info_pass_e41ce007.plan.md` vs live repo `E:\Internet Downtime Tracker`  
**Siblings:** not read (`CV_peer-gaps-plan_*` isolation)  
**Product edits:** none  
**Gate (this reviewer):** **FAIL** — open BLOCKING present; several HIGH plan/code mismatches  
**Open BLOCKING:** 2  

## Counts

| reviewer | BLOCKING | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| grok45   | 2        | 5    | 4      | 2   |

## Findings

| id | track | slug | severity | claim | evidence_path | fix_owner | status | reviewer |
|----|-------|------|----------|-------|---------------|-----------|--------|----------|
| CV-PLAN-001 | process | null | BLOCKING | File-ownership: `web/app.js` is parent-only after Wave 2, yet Wave 2 Tooltips may write tooltip helpers in `app.js` and Wave 3 Topology **writes** topology functions in `app.js` | plan §Parallel build File-ownership + Collision rule; Workstream 3 “Files: web/app.js radial renderer” | process | open | grok45 |
| CV-PLAN-002 | app | null | BLOCKING | “30d uptime bar from existing **probes**/summary” — probes default retention is **14d**, so a probe-derived 30d bar is dishonest unless retention is raised; honest path is outage `summary.windows["30d"]` only | `electron/db.js` `probe_retention_days: 14`, `pruneProbes`; `summary()` builds 30d via `listOutages` / `windows`, not long probe history | app | open | grok45 |
| CV-PLAN-003 | app | null | HIGH | “HTTP(S) probe returns cert remaining days” via `checkHttp` — **cannot today**; returns `[ok, latency]` only; no peer-cert read; no cert in `insertProbe`/monitor state | `electron/netcheck.js` `checkHttp` ~332–384; `electron/db.js` `INSERT INTO probes (... dns_ok, http_ok)`; `monitor._applyProbe` | app | open | grok45 |
| CV-PLAN-004 | app | null | HIGH | Cert-on-`checkHttp` runs on the **existing** `monitor._tick` → `_runProbe` path — not LAN coupling, but every-tick TLS cert work unless throttled/cached; plan’s `_tick` grep contract does not cover this budget risk | `electron/monitor.js` `_tick` → `_runProbe`; plan Verification grep only bans lan/usage/topology/sniffer/scan | app | open | grok45 |
| CV-PLAN-005 | app | null | HIGH | Devices ping/**traceroute** “reuse netcheck” — `pingHost` exists; **no traceroute/tracert anywhere in repo** | `electron/netcheck.js` exports; repo grep `traceroute|tracert` = 0 hits | app | open | grok45 |
| CV-PLAN-006 | app | null | HIGH | LLDP “map sysName/IP to node ids” under-scoped: edges already set `to` = raw rem **sysName**; renderer keys `byId` on **IP/label** so lines drop; OID polled is only `LLDP_REM_SYS` — no remManAddr / chassis IP OID | `electron/snmp-topology.js` ~159–241; `web/app.js` `topologyGraphHtml` ~2217–2227 | app | open | grok45 |
| CV-PLAN-007 | process | null | HIGH | Wave 3 lists `electron/lan-devices.js` neighbor star as a topology file, but ownership assigns `lan-devices.js` to Wave 2 Devices only; SNMP “reads” neighbor helper — unclear who may edit neighbor topology during Wave 3 | plan Workstream 3 Files vs File-ownership Devices/SNMP rows | process | open | grok45 |
| CV-PLAN-008 | app | null | MEDIUM | NetBIOS/DNS hostname “Yes” oversold: neighbor PS snapshot never sets `hostname` (IP/MAC/state/iface only); column exists but stays null; no NetBIOS helper; reverse-DNS often empty on home LANs | `electron/lan-devices.js` `Get-NetNeighbor` script ~169–182; `shapeNeighbor` no hostname field | app | open | grok45 |
| CV-PLAN-009 | app | null | MEDIUM | `bindTooltips` coverage: plan says call after every dynamic table render; live callers are timeline, topology, conn adapters/rows, + `setupTooltips(document)` only — **Devices, Usage live rows, Scan, Sniffer, Speed history, History/Patterns/Logs** do not rebind; Usage trend chart has **no** `wireChartTip` | `web/app.js` `bindTooltips(` call sites; `ensureUsageTrend` ~2747–2806 vs Overview charts that call `wireChartTip` | app | open | grok45 |
| CV-PLAN-010 | app | null | MEDIUM | “last fail reason if already in state” — monitor state has layer booleans + `latency_ms`, **not** a last-fail-reason string; richer tips cannot invent reasons from current state | `electron/monitor.js` state / `_applyProbe` | app | open | grok45 |
| CV-PLAN-011 | product | null | MEDIUM | Privilege honesty: Electron unelevated-by-default holds; Connections checklist OK today; plan adds Win32_Service join, reverse-DNS, NetBIOS, new-exe toast (helper) without requiring Settings tips to disclose partial elevation / helper / DNS side effects | `electron/usage-bridge.js` unelevated comment; plan Settings “privilege consequences”; `LAYER_TIPS` `conn-process` already warns on `?` | product:idt | open | grok45 |
| CV-PLAN-012 | app | null | LOW | Devices silent-empty when `lan_devices_enabled=false` — **plan claim TRUE**: bridge returns `warning`, UI ignores `ok`/`warning` and shows “0 devices” | `electron/lan-bridge.js` `listDevices`/`refreshDevices` ~67–121; `web/app.js` `refreshDevicesPanel` ~2007–2046 | app | open | grok45 |
| CV-PLAN-013 | app | null | LOW | Skip-list vs locked ship mostly aligned (no WinDivert/GeoIP/Ask-to-connect/public bind/RDP/complete ARP map); residual: port chips need per-IP scan lookup (`listLanScanResults` only, no device join helper) | plan Locked constraints + Research table; `electron/db.js` `listLanScanResults` | app | open | grok45 |

## Attack notes (evidence)

### `monitor._tick` coupling
`_tick` only probes / prune / adapter / quality-burst (`electron/monitor.js` ~347–388). No lan/usage/topology/sniffer/scan. Plan lock + grep contract match **today**. Residual risk is **cert/extra DNS inside probe**, not LAN bridges (see CV-PLAN-004).

### Privilege honesty
README + usage-bridge: Electron unelevated; Usage helper UAC opt-in. Plan correctly skips elevating whole app. Incomplete for **new** Connections/Devices resolve features (CV-PLAN-011).

### `web/app.js` races
Self-contradictory ownership (CV-PLAN-001). Parent integrate cannot simultaneously satisfy “Wave 3 agent writes topology in app.js” and “app.js parent-only after Wave 2”.

### `checkHttp` → cert days
Not implementable as a return-field tweak alone (CV-PLAN-003). Needs TLS peer cert + optional state/UI; decide interval vs every tick (CV-PLAN-004).

### 30d uptime
`summary().windows["30d"]` downtime from **outages** is real. Probe history defaults to 14d. Plan wording “probes/summary” must be fixed before Overview agent ships a probe histogram (CV-PLAN-002).

### NetBIOS/DNS
Greenfield; neighbor path has no hostname population (CV-PLAN-008). Feasible with rate limits; often empty — UI must not imply Fing-class completeness.

### LLDP edges
Confirmed miss: `to` = sysName string, layout lookup by IP (CV-PLAN-006). Plan’s ship item is valid; OID scope incomplete.

### Skip-list
No major ship/skip schism found beyond under-specified scan-chip join (CV-PLAN-013).

### Tooltips
`bindTooltips` idempotent via `data-tip-bound`; dynamic surfaces that replace innerHTML without rebind stay tip-dead (CV-PLAN-009). Overview static `data-tip` pills survive `setPill` class churn.

### Devices disabled
Silent empty confirmed; plan correctly schedules warning (CV-PLAN-012) — not a false claim.

## Disagreements
N/A (isolated; no sibling merge).

## Art routing
N/A (plan/code CV; no cover art).

## Verdict
**FAIL** — BLOCKING 2 · HIGH 5 · MEDIUM 4 · LOW 2  

Do not start Wave 2–3 until BLOCKING ownership + 30d-data-source claims are rewritten in the plan (or accepted_risk by human).
