# Cross-verify: peer-gaps plan (merged)

**Date:** 2026-08-12
**Claims attacked:** `c:\Users\reinh\.cursor\plans\peer_gaps_info_pass_e41ce007.plan.md` vs live repo `E:\Internet Downtime Tracker`
**Reviewers:** grok46 (`cursor-grok-4.6-xhigh`) · grok45 (`cursor-grok-4.5-high`) · composer25 (`composer-2.5`)
**Inputs:** `docs/reviews/CV_peer-gaps-plan_2026-08-12_grok46.md` · `_grok45.md` · `_composer25.md`
**Open BLOCKING:** 4
**Gate:** FAIL / CLEAR_FORBIDDEN
**Verdict:** **FAIL** until findings are implemented in product. This document is merge-only (no product edits).

Union rule: worst severity wins; no BLOCKING/HIGH dropped. `reviewer` lists all models that raised the claim. `sources` = original isolated IDs.

## Per-reviewer counts (isolated)

| reviewer | BLOCKING | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| grok46 | 2 | 6 | 5 | 2 |
| grok45 | 2 | 5 | 4 | 2 |
| composer25 | 3 | 6 | 5 | 3 |

## Merged counts (union)

| | BLOCKING | HIGH | MEDIUM | LOW |
|--|----------|------|--------|-----|
| merged | 4 | 9 | 3 | 4 |

## Findings

| id | track | slug | severity | claim | evidence_path | fix_owner | status | reviewer | sources |
|----|-------|------|----------|-------|---------------|-----------|--------|----------|---------|
| CV-PROCESS-001 | process | null | BLOCKING | `web/app.js` single-owner per wave; Wave 3 may not write it while Wave 2/parent also write it | plan File-ownership + Collision rule vs Workstream 3; `web/app.js` monolith (no pre-split) | process | open | grok46, grok45, composer25 | grok46 CV-PROCESS-001; grok45 CV-PLAN-001; composer25 CV-PLAN-011 |
| CV-APP-001 | app | internet-downtime-tracker | BLOCKING | 30d uptime bar from existing `probes`/`summary` without new storage / without raising retention | `electron/db.js` `probe_retention_days: 14`; `summary().windows["30d"]` outage aggregate; `sparkline_24h` = 24 hourly outage seconds | app | open | grok46, grok45, composer25 | grok46 CV-APP-001; grok45 CV-PLAN-002; composer25 CV-PLAN-002 |
| CV-APP-002 | app | internet-downtime-tracker | BLOCKING | HTTPS cert remaining days already returned by `checkHttp` / only a netcheck tweak | `electron/netcheck.js` `checkHttp` resolves `[ok, latency]` only; default `http_url` is HTTP; `probe()` / tests 2-tuple; cert must flow into monitor snapshot for pills | app | open | grok46, grok45, composer25 | grok46 CV-APP-002; grok45 CV-PLAN-003; composer25 CV-PLAN-001, CV-PLAN-015 |
| CV-APP-003 | app | internet-downtime-tracker | BLOCKING | Devices ping/traceroute reuses existing netcheck traceroute | `electron/netcheck.js` exports `pingHost`/`pingBurst` only; repo grep `traceroute`/`tracert` = 0 product hits | app | open | grok46, grok45, composer25 | grok46 CV-APP-003; grok45 CV-PLAN-005; composer25 CV-PLAN-003 |
| CV-APP-004 | app | internet-downtime-tracker | HIGH | NetBIOS/DNS hostname when empty is a thin extension of current neighbor snapshot | `electron/lan-devices.js` `shapeNeighbor` has no hostname; no nbtstat/PTR callers; `lan_devices.hostname` stays null on ARP path | app | open | grok46, grok45, composer25 | grok46 CV-APP-004; grok45 CV-PLAN-008; composer25 CV-PLAN-008 |
| CV-APP-005 | app | internet-downtime-tracker | HIGH | Richer layer pill tips include last fail reason already in monitor state; per-layer last latency already in state | `electron/monitor.js` state: layer booleans, `latency_ms`, `failure_domain`, `quality` — no `fail_reason`, no per-layer RTT | app | open | grok46, grok45, composer25 | grok46 CV-APP-005; grok45 CV-PLAN-010; composer25 CV-PLAN-007 |
| CV-APP-006 | app | internet-downtime-tracker | HIGH | Usage new-exe first-seen tray toast has a Wave 2 owner and `usage_apps.first_seen` | `electron/db.js` `usage_apps` = app_key/display_name/exe_path/ignored; `upsertUsageApp` can detect first INSERT; no Wave 2 owner for `usage-bridge.js` | app | open | grok46 | grok46 CV-APP-006 |
| CV-APP-007 | app | internet-downtime-tracker | HIGH | `_tick` grep (LAN/usage/topology/sniffer/scan) is a complete safety net for cert/DNS/new IPC | `electron/monitor.js` `_tick` → `_runProbe`/`checkHttp`/`_maybeQualityBurst`; `electron/test/lan-security.test.js` greps `main.js` not `monitor.js` | app | open | grok46, grok45, composer25 | grok46 CV-APP-007; grok45 CV-PLAN-004; composer25 CV-PLAN-010 |
| CV-APP-008 | app | internet-downtime-tracker | HIGH | LLDP `to` resolution is a small sysName→id map; edges mostly render today | `electron/snmp-topology.js` `to` = rem sysName; `web/app.js` `topologyGraphHtml` `byId` keyed on `node.ip \|\| node.label`; only `LLDP_REM_SYS` polled | app | open | grok46, grok45, composer25 | grok46 CV-APP-008; grok45 CV-PLAN-006; composer25 CV-PLAN-004 |
| CV-PROCESS-002 | process | null | HIGH | Wave 3 may write `lan-devices.js` neighbor star while Wave 2 Devices owns that file | plan Workstream 3 Files vs File-ownership; `neighborTopologyFromDevices` already ships | process | open | grok46, grok45 | grok46 CV-APP-014; grok45 CV-PLAN-007 |
| CV-APP-009 | app | internet-downtime-tracker | HIGH | `bindTooltips` after every dynamic table render; Usage `wireChartTip` on 24h trend | `web/app.js` bind sites: timeline, topo, conn strip/rows, `setupTooltips(document)` only; `ensureUsageTrend` has no `wireChartTip` | app | open | grok46, grok45, composer25 | grok46 CV-APP-009; grok45 CV-PLAN-009; composer25 CV-PLAN-006, CV-PLAN-013 |
| CV-PROCESS-003 | process | null | HIGH | TCPView sent/recv bytes neither shipped nor explicitly skipped | plan Research TCPView row vs Workstream 2 (resolve/service/delta + skip Close Connection only) | process | open | composer25 | composer25 CV-PLAN-009 |
| CV-APP-010 | app | internet-downtime-tracker | HIGH | Devices disabled state already surfaced like Connections | `electron/lan-bridge.js` returns `warning`; `web/app.js` `refreshDevicesPanel` ignores `ok`/`warning` (Connections meta+row uses `data.warning`) | app | open | grok45, composer25 | composer25 CV-PLAN-005; grok45 CV-PLAN-012 |
| CV-APP-011 | app | internet-downtime-tracker | MEDIUM | Privilege honesty holds for new service-name / DNS / NetBIOS / Settings tips | no `requestedExecutionLevel`; `LAYER_TIPS` conn-process; Settings usage UAC copy; new CIM/DNS/NetBIOS may be empty without admin | product:internet-downtime-tracker | open | grok46, grok45, composer25 | grok46 CV-APP-010; grok45 CV-PLAN-011; composer25 CV-PLAN-012 |
| CV-APP-012 | process | null | MEDIUM | Skip-list complete vs locked ship (90d, maintenance, second `_tick` probe, retention bump, Fing timeline, GlassWire time-machine) | plan Research vs Workstream 2–3; `probe_retention_days` write amp | process | open | grok46 | grok46 CV-APP-011 |
| CV-APP-013 | app | internet-downtime-tracker | MEDIUM | Last-scan port chips if present in DB (global last-20 is enough) | `electron/db.js` `listLanScanResults({limit:20})` — no `WHERE target_ip=?` | app | open | grok46, grok45, composer25 | grok46 CV-APP-012; grok45 CV-PLAN-013; composer25 CV-PLAN-014 |
| CV-APP-014 | app | internet-downtime-tracker | LOW | Adapter chips already show session bytes (not just Mbps since last sample) | `electron/connections.js` `computeAdapterRates` one previous sample; chips Mbps only | app | open | grok46 | grok46 CV-APP-013 |
| CV-APP-015 | app | internet-downtime-tracker | LOW | OUI category heuristic already present | `electron/lan-devices.js` `lookupOui`; no category field | app | open | composer25 | composer25 CV-PLAN-016 |
| CV-APP-016 | app | internet-downtime-tracker | LOW | Topology click-select / pan-zoom already exist | `web/app.js` hover tips + root label; refresh/stop only | app | open | composer25 | composer25 CV-PLAN-017 |
| CV-APP-017 | app | internet-downtime-tracker | LOW | Connections reverse-DNS / service / delta already exist | `electron/connections.js` process name only | app | open | composer25 | composer25 CV-PLAN-018 |

## BLOCKING detail (live code)

### CV-PROCESS-001 — `web/app.js` dual-owner race

Plan says parent-only after Wave 2 **and** Wave 3 topology writes topology functions in `web/app.js`. Wave 2 tooltips may write `app.js` “if regions are pre-split” — they are not (`bindTooltips`, `refreshDevicesPanel`, `topologyGraphHtml`, `paintStatus` in one file). Mermaid has `wave2 --> Merge2` and `wave2 --> wave3`.

**Fix (locked in spec):** Wave 2 UI writes `web/index.html`, `web/styles.css`, and `web/snippets/tooltips.js.txt`. Parent wires `app.js`. Wave 3 may edit topology functions in `app.js` only after that parent merge.

### CV-APP-001 — 30d bar vs 14d probes

`DEFAULT_SETTINGS.probe_retention_days: 14`; `pruneProbes` deletes older. `insertProbe` stores layer oks + latency — no hourly uptime rollup. `summary()`:

- `windows["30d"]` = outage overlap aggregate (`downtime_ms` / `downtime_pct` / `count`), not a bucket array
- `sparkline_24h` = 24 hourly **outage seconds**
- `by_hour` / `by_dow` = outage-start histograms
- latency spark = last **6h** of probes

Labeling 14d probe data as 30d is a forged metric. Raising retention to 30d is write amplification on every `_tick`.

**Fix (locked in spec):** Honest dual-source: 30d **% from `windows["30d"]`** (outages, not pruned) + sparkline limited to retained probe days / existing 24h outage spark; never label 14d probes as 30d; do not bump `probe_retention_days`.

### CV-APP-002 — `checkHttp` is `[ok, latency]` only

`checkHttp` `resolve([ok, latency])`. No `getPeerCertificate`. Default URL `http://connectivitycheck.gstatic.com/generate_204`. `probe()` destructures `[httpOk, httpLat]`. `export.test.js` destructures `[ok, lat]`. `_runProbe` runs inside `_tick`. Cert cannot appear on pills without extending the return **and** parent wiring into monitor snapshot (Overview agent does not own `monitor.js`). Extra HTTPS on `_tick` is forbidden.

**Fix (locked in spec):** EXTEND `checkHttp` (third value / `http_cert_days` on `probe()`); parse cert only on existing `https:` response; HTTP URL → `N/A (HTTP URL)`; parent copies field into snapshot without changing `_tick` control flow; no second fetch.

### CV-APP-003 — traceroute is not in netcheck

`pingHost` exists. Zero product `traceroute`/`tracert` implementations. “Reuse netcheck traceroute” is false.

**Fix (locked in spec):** ADD `tracerouteHost` in new `electron/traceroute.js` (Devices-owned). Ping wraps existing `pingHost`. On-demand IPC only; not snapshot; not `_tick`.

## Claims that held (do not invert)

- `_tick` today: probes / prune / adapter / quality burst only — not LAN/usage/topology/sniffer/scan.
- Electron unelevated default (no `requestedExecutionLevel`); Usage is a separate UAC helper.
- Devices disabled is silent-empty (bridge `warning`; UI ignores it). Plan already scheduled a warning — HIGH is “must ship; mirror Connections,” not “plan forgot it.”
- LLDP `to` = sysName vs IP-keyed layout is a real miss (ship item valid; OID scope incomplete).
- Skip of WinDivert / GeoIP / public bind / RDP-shutdown / Close Connection / ARP-as-complete-map matches live code.

## Disagreements (resolved by worst-severity + live code)

| Fact | grok46 | grok45 | composer25 | Merge |
|------|--------|--------|------------|-------|
| `app.js` ownership | BLOCKING | BLOCKING | MEDIUM | **BLOCKING** |
| 30d from probes | BLOCKING | BLOCKING | BLOCKING | **BLOCKING** |
| cert already on `checkHttp` | HIGH | HIGH | BLOCKING | **BLOCKING** (live: 2-tuple only) |
| traceroute reuse | HIGH | HIGH | BLOCKING | **BLOCKING** (live: no traceroute) |
| LLDP under-scoped | MEDIUM | HIGH | HIGH | **HIGH** |
| `bindTooltips` coverage | MEDIUM | MEDIUM | HIGH | **HIGH** |
| NetBIOS/rDNS greenfield | HIGH | MEDIUM | HIGH | **HIGH** |
| fail_reason in state | HIGH | MEDIUM | HIGH | **HIGH** (live: absent) |
| Wave 3 `lan-devices.js` | LOW | HIGH | — | **HIGH** |
| Devices disabled UI | (held / scheduled) | LOW (plan true) | HIGH (product silent) | **HIGH** keep; spec locks Connections-mirror warning |
| TCPView sent/recv | (skip-list hole MEDIUM) | — | HIGH | **HIGH**; spec **SKIP** |
| 30d visual | outages + cap; no retention bump | `windows["30d"]` only | outage daily buckets OK | spec: `%` from `windows["30d"]` + sparkline not labeled 30d if from 14d probes |

## Art routing

None (plan/code review, no cover art).

## Gate note

`CLEAR_OK` is forbidden until product implements all merged BLOCKING/HIGH (and remaining findings per plan gate). Pre-impl spec `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md` locks honest contracts; it does not close these rows.
