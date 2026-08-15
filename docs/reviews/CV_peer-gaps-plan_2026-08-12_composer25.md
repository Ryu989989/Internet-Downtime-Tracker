# Cross-verify: peer-gaps-info-pass plan (composer25)

**Date:** 2026-08-12  
**Claims attacked:** `c:\Users\reinh\.cursor\plans\peer_gaps_info_pass_e41ce007.plan.md` (locked ship/skip, file-ownership, Overview cert/30d, Devices/Connections/Topology/tooltips, `_tick` constraint)  
**Reviewer:** composer25 (`composer-2.5`) — isolated; no sibling draft  
**Open BLOCKING:** 3  
**Gate:** CLEAR_FORBIDDEN

## Per-reviewer counts

| reviewer | BLOCKING | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| composer25 | 3 | 6 | 5 | 3 |

## Findings

| id | track | slug | severity | claim | evidence_path | fix_owner | status | reviewer |
|----|-------|------|----------|-------|---------------|-----------|--------|----------|
| CV-PLAN-001 | product | internet-downtime-tracker | BLOCKING | `checkHttp` already returns HTTPS cert remaining days for Overview pill | `electron/netcheck.js` L332–384: resolves `[ok, latency]` only; no `secureConnect` / `getPeerCertificate`; callers (`runProbe` L464, `export.test.js` L50) expect 2-tuple | product:internet-downtime-tracker | open | composer25 |
| CV-PLAN-002 | product | internet-downtime-tracker | BLOCKING | 30d uptime bar buildable from existing `probes`/`summary` without new storage | `electron/db.js` L925–931 default `probe_retention_days: 14`; L1341–1350 returns `sparkline_24h` + `windows["30d"]` aggregate only — no 30d bucket array; probes lack 30d at default retention | product:internet-downtime-tracker | open | composer25 |
| CV-PLAN-003 | product | internet-downtime-tracker | BLOCKING | Devices ping/traceroute reuses existing `netcheck` (traceroute) | `electron/netcheck.js` exports `pingHost`/`pingBurst` (L183–272, L497–499); repo grep: zero `traceroute`/`tracert` implementations | product:internet-downtime-tracker | open | composer25 |
| CV-PLAN-004 | product | internet-downtime-tracker | HIGH | LLDP edge fix is a small `to`-id map; edges mostly render today | `electron/snmp-topology.js` L240–241: `to` = raw LLDP sysName string; `web/app.js` L2217–2226 `byId` keyed on `node.ip \|\| node.label` — sysName-only neighbors miss lookup → empty `<line>` | product:internet-downtime-tracker | open | composer25 |
| CV-PLAN-005 | product | internet-downtime-tracker | HIGH | Devices disabled state surfaced (plan Workstream 1) | `electron/lan-bridge.js` L69–70 returns `warning`; `web/app.js` L2007–2050 `refreshDevicesPanel` ignores `data.warning`, sets meta to `0 devices · passive neighbor cache` — unlike Connections L2661–2665 | product:internet-downtime-tracker | open | composer25 |
| CV-PLAN-006 | product | internet-downtime-tracker | HIGH | Dashboard-wide tooltip pass: `bindTooltips` after every dynamic render | `web/app.js` L3667–3675; calls only at L1410, L2287, L2293, L2561, L2640, L3679 — not after Devices L2023, History L1265, Patterns, System logs L1877, Usage L2710, Speed L3035 | product:internet-downtime-tracker | open | composer25 |
| CV-PLAN-007 | product | internet-downtime-tracker | HIGH | Richer layer pill tips include last fail reason “if already in state” | `electron/monitor.js` snapshot L173–233: `failure_domain`, booleans, `latency_ms` — no `fail_reason` / per-layer error string; grep `fail_reason` → none | product:internet-downtime-tracker | open | composer25 |
| CV-PLAN-008 | product | internet-downtime-tracker | HIGH | NetBIOS/DNS hostname resolution is a thin extension of `lan-devices` | `electron/lan-devices.js` L209–257 neighbor snapshot only; `hostname` DB column exists but never populated from NetBIOS/rDNS; no `nbtstat`/`Resolve-DnsName` path | product:internet-downtime-tracker | open | composer25 |
| CV-PLAN-009 | process | null | HIGH | Skip-list vs locked ship complete for TCPView peer | Plan L85 ships resolve/service/delta; skips Close Connection only — TCPView sent/recv bytes (peer column L84) neither shipped nor explicitly skipped | process | open | composer25 |
| CV-PLAN-010 | product | internet-downtime-tracker | HIGH | `monitor._tick` coupling risk contained by plan constraint | `electron/monitor.js` L347–388: tick = probes/prune/adapter/quality only; `electron/test/lan-security.test.js` L28–29 regex on `main.js` not `monitor.js`; device ping IPC could be miswired into tick without new test | product:internet-downtime-tracker | open | composer25 |
| CV-PLAN-011 | process | null | MEDIUM | `web/app.js` file-ownership avoids merge races | Plan L146–148: parent-only after Wave 2, but Wave 3 topology agent still writes `app.js` L210; Wave 2 tooltips “only if pre-split” L141 — conditional dual-writer if coordinator skips parent merge | process | open | composer25 |
| CV-PLAN-012 | product | internet-downtime-tracker | MEDIUM | Privilege honesty: Settings toggles document elevation consequences | `web/index.html` L657–660 usage has UAC copy; L652 `connections_enabled`, L681 `snmp_enabled`, L694 sniffer lack `has-tip`/consequence text; `conn-process` tip L83–84 mentions admin only on Connections header | product:internet-downtime-tracker | open | composer25 |
| CV-PLAN-013 | product | internet-downtime-tracker | MEDIUM | Usage 24h trend gets `wireChartTip` (locked ship) | `web/app.js` L2746–2807 `ensureUsageTrend` creates `usageTrendChart` with no `wireChartTip`; Overview/speed charts wired L828–1176 | product:internet-downtime-tracker | open | composer25 |
| CV-PLAN-014 | product | internet-downtime-tracker | MEDIUM | Devices show last Scan open-port chips “if present in DB” | `electron/db.js` L637–646 `lan_scan_results`; `refreshDevicesPanel` L2023–2046 renders no port chips | product:internet-downtime-tracker | open | composer25 |
| CV-PLAN-015 | product | internet-downtime-tracker | MEDIUM | Cert days surface requires only `netcheck.js` / Overview agent | Cert must flow `checkHttp` → `runProbe` → `monitor.state` → `api:summary`/`snapshot` → `paintStatus` pills; plan scopes Overview agent to `netcheck.js` optional `db.js` only L144 | product:internet-downtime-tracker | open | composer25 |
| CV-PLAN-016 | product | internet-downtime-tracker | LOW | OUI category heuristic ready | `electron/lan-devices.js` L6 `lookupOui`; no category field yet — additive | product:internet-downtime-tracker | open | composer25 |
| CV-PLAN-017 | product | internet-downtime-tracker | LOW | Topology click-select / pan-zoom are incremental UI | `web/app.js` L2498–2500 refresh/stop only; L2214–2249 hover tips, root label only | product:internet-downtime-tracker | open | composer25 |
| CV-PLAN-018 | product | internet-downtime-tracker | LOW | Connections delta/service/reverse-DNS ship items are greenfield | `electron/connections.js` L101+ PowerShell proc-name only; no resolve toggle, service join, or snapshot diff | product:internet-downtime-tracker | open | composer25 |

## Disagreements

N/A (isolated reviewer). Parent merge must reconcile with grok46/grok45.

**30d bar nuance:** Outage-derived daily buckets (extend `sparkline_24h` pattern in `db.summary` L1275–1294) can approximate 30d without probes; plan wording “from probes” is the blocking defect, not the visual itself.

**LLDP:** Plan L217 names the gap; severity HIGH because ship criterion “LLDP edges correct” needs explicit `sysName→node.id` resolver in `snmp-topology.js` + tests (none in `electron/test/`).

## Art routing

N/A — no art claims.

## Verdict

**FAIL** — BLOCKING 3 · HIGH 6 · MEDIUM 5 · LOW 3  
Amend plan before feature waves: cert API/pipeline, 30d data source (outages + optional retention bump, not probes-only), traceroute spec + IPC; tighten file-ownership to single `app.js` integrator per wave.
