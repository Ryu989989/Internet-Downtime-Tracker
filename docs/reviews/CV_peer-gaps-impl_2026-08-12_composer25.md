# Cross-verify: peer-gaps post-impl mega-review

**Date:** 2026-08-12  
**Claims attacked:** `docs/reviews/MEGA_REVIEW_20260812.md` (FAIL, 7 High), `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md` (line 5 “Done / CLEAR_OK / all CV findings implemented”)  
**Reviewers:** grok46 · grok45 · **composer25** (`composer-2.5`, this file)  
**Open BLOCKING:** 3  
**Gate:** CLEAR_FORBIDDEN

## Per-reviewer counts

| reviewer | BLOCKING | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| composer25 | 3 | 8 | 10 | 6 |

*(Mega-review merged counts: 0 Critical · 7 High · 9 Medium · 6 Low · 2 Info — no BLOCKING row; see attack below.)*

## Mega-review honesty verdict

**Honest FAIL — not fake-PASS.** Independent code reads confirm all seven merged Highs; `npm test` 135/135 pass (verified locally, exit 0). Product `_tick` isolation holds (`monitor.js` requires only `netcheck` + `uptime-bar`). CV-APP-002/003 product claims (3-tuple `checkHttp`, `traceroute.js` on-demand IPC) are accurate.

**Under-FAIL / missed escalations (not over-FAIL):**

| Area | Mega says | Code says | composer25 |
|------|-----------|-----------|------------|
| Security specialist | PASS | Ping/traceroute IPC bypass `lan_devices_enabled` | Should be FAIL or at least not PASS |
| ping/traceroute gate | Medium M4 | `main.js:861-866` calls `pingDevice`/`tracerouteDevice` with no settings check; `lan-bridge.js:67-71` gates list/refresh only | **BLOCKING** product |
| Spec status | Not cited | Spec L5: “triple CV `CLEAR_OK`; all CV findings implemented” vs open H1–H7 | **BLOCKING** schism |
| CV-APP-001 | Partial (H1) | `main.js:529` `observeSince = monitor.state.started_at`; `db.js:1221-1229` computes `firstProbe` then overridden | Still **BLOCKING** per plan CV |
| H7 severity | High | `paintDevicesDisabled` ships (`web/app.js:2257-2271`); only `ui.test.js` grep missing | Agree gap; borderline HIGH→MEDIUM |
| Privilege 9/10 | Hold | No `requestedExecutionLevel`; Usage UAC helper only | Fair; not fake-PASS |
| Locked skip “14d as 30d” | Skipped | `uptime-bar.test.js` spark `"14d"`; H1 is session-clock vs 30d **%** math | Skip is correct |

No evidence of **over-FAIL** on the seven Highs. H3–H7 are test/contract gaps but spec grep contract explicitly requires them; treating as High is defensible.

## Seven Highs — code verification

| Mega ID | Real? | Evidence |
|---------|-------|----------|
| H1 30d label clock | **Yes (product)** | `electron/main.js:529` passes `monitor.state.started_at` to `db.summary` / `honestUptimeBar`; `windows["30d"]` uses 30d outage lookback while `pct_label` uses session age |
| H2 Connections delta global | **Yes (product)** | `connections.js:445-464` `applySnapshotDelta` always runs; `lan-bridge.js:33,229` `snapshot({ establishedOnly: true })` with no `trackDelta:false` |
| H3 `probe().http_cert_days` untested | **Yes (test)** | `netcheck.test.js` imports `checkHttp` only; no `probe()` call; `probe()` at `netcheck.js:486-504` |
| H4 monitor snapshot copy untested | **Yes (test)** | `monitor.js:425` assigns field; `monitor.test.js:12-21` `makeResult()` omits `http_cert_days` |
| H5 `_tick` grep module list | **Yes (test)** | `lan-security.test.js:34-41` greps `monitor.js` for lan/traceroute only; no `usage-bridge`/`connections`/`snmp-topology`/`packet-sniffer`/`port-scan` |
| H6 retention/prune lock | **Yes (test)** | `db.js:19,927-933` default 14 + `DELETE FROM probes`; zero test hits for `probe_retention_days` / `pruneProbes` |
| H7 Devices disabled UI test | **Yes (test)** | `paintDevicesDisabled` in product; `ui.test.js` has no grep for it / `devicesDisabledBanner` |

## Findings

| id | track | slug | severity | claim | evidence_path | fix_owner | status | reviewer |
|----|-------|------|----------|-------|---------------|-----------|--------|----------|
| MR-MR-001 | process | null | BLOCKING | Mega-review omits spec↔reality status schism: spec claims CLEAR_OK + all CV implemented while H1–H7 open | `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md:5` vs `docs/reviews/MEGA_REVIEW_20260812.md` verdict FAIL | process | open | composer25 |
| MR-APP-001 | product | internet-downtime-tracker | BLOCKING | `lan_devices_enabled=false` does not block ping/traceroute IPC (master switch bypass) | `electron/main.js:861-866`; contrast `electron/lan-bridge.js:67-71,150-151`; `electron/lan-devices.js:476-493` no settings check | product:internet-downtime-tracker | open | composer25 |
| MR-APP-002 | product | internet-downtime-tracker | BLOCKING | CV-APP-001 honest 30d still open in product: session `started_at` labels 30d outage % | `electron/main.js:529-539`; `electron/db.js:1221-1229` (`firstProbe` dropped when `observeSince` passed) | product:internet-downtime-tracker | open | composer25 |
| MR-MR-002 | process | null | HIGH | Security specialist PASS understates ping/traceroute bypass (should fail or carry BLOCKING) | `docs/reviews/MEGA_REVIEW_20260812.md` security PASS; `electron/main.js:861-866` | process | open | composer25 |
| MR-APP-003 | product | internet-downtime-tracker | HIGH | Connections delta shared with Topology/sniffer (mega H2) | `electron/connections.js:512`; `electron/lan-bridge.js:33,229` | product:internet-downtime-tracker | open | composer25 |
| MR-TEST-001 | app | null | HIGH | `probe().http_cert_days` + LAN-down skip `checkHttp` untested (mega H3) | `electron/test/netcheck.test.js`; `electron/netcheck.js:486-494` | app | open | composer25 |
| MR-TEST-002 | app | null | HIGH | Monitor `http_cert_days` snapshot copy untested (mega H4) | `electron/test/monitor.test.js:12-21`; `electron/monitor.js:425` | app | open | composer25 |
| MR-TEST-003 | app | null | HIGH | `monitor.js` grep misses spec module list (mega H5) | `electron/test/lan-security.test.js:34-41`; spec grep contract L87-92 | app | open | composer25 |
| MR-TEST-004 | app | null | HIGH | No lock on `probe_retention_days===14` or `pruneProbes` vs outages (mega H6) | `electron/db.js:19,927-933`; grep tests empty | app | open | composer25 |
| MR-TEST-005 | app | null | HIGH | Devices disabled UI warning untested (mega H7) | `web/app.js:2257-2271`; `electron/test/ui.test.js` | app | open | composer25 |
| MR-APP-004 | product | internet-downtime-tracker | MEDIUM | `http_cert_days` wiped when HTTP layer skipped (mega M1) | `electron/monitor.js:425`; `electron/netcheck.js:486-494` | product:internet-downtime-tracker | open | composer25 |
| MR-APP-005 | product | internet-downtime-tracker | MEDIUM | Adapter chips omit session bytes (mega M2) | spec NetWorx Yes row; `web/app.js` adapter chip path | product:internet-downtime-tracker | open | composer25 |
| MR-APP-006 | product | internet-downtime-tracker | MEDIUM | `hostname_source` memory-only disclaimer drift (mega M3) | `electron/lan-devices.js` hostname cache | product:internet-downtime-tracker | open | composer25 |
| MR-APP-007 | product | internet-downtime-tracker | MEDIUM | `connections_resolve_dns` default false not on `getSettings()` assert (mega M5) | `electron/db.js:27`; `electron/test/usage-db.test.js:103-108` | app | open | composer25 |
| MR-TEST-006 | app | null | MEDIUM | 30d edge labels `<1d`/null/30.0d untested (mega M6) | `electron/uptime-bar.js:23-26`; `electron/test/uptime-bar.test.js` | app | open | composer25 |
| MR-APP-008 | product | internet-downtime-tracker | MEDIUM | `tracerouteHost` no private guard at module level (mega M7) | `electron/traceroute.js:67-71` vs `lan-devices.js:490-492` | product:internet-downtime-tracker | open | composer25 |
| MR-TEST-007 | app | null | MEDIUM | Second-HTTP / same-response cert not request-count locked (mega M8) | `electron/test/netcheck.test.js:112-134` | app | open | composer25 |
| MR-TEST-008 | app | null | MEDIUM | UI data-tip contracts thin for new surfaces (mega M9) | `electron/test/ui.test.js:88-89` only topo headers | app | open | composer25 |
| MR-APP-009 | product | internet-downtime-tracker | LOW | Duplicated `formatHttpCertDays` (mega L1) | `web/app.js:230-242`; `electron/uptime-bar.js:35-47` | product:internet-downtime-tracker | open | composer25 |
| MR-APP-010 | product | internet-downtime-tracker | LOW | rDNS timeout caches null forever (mega L2) | `electron/connections.js:429-437` | product:internet-downtime-tracker | open | composer25 |
| MR-APP-011 | product | internet-downtime-tracker | LOW | Neighbor-mode warning omits “not a switch fabric” (mega L3) | `electron/lan-devices.js` vs `snmp-topology.js:164` | product:internet-downtime-tracker | open | composer25 |
| MR-APP-012 | product | internet-downtime-tracker | LOW | Settings privilege copy weak on NBT/PTR emptiness (mega L4) | Settings tips grep | product:internet-downtime-tracker | open | composer25 |
| MR-APP-013 | product | internet-downtime-tracker | LOW | Traceroute in-flight uncapped (mega L5) | `electron/traceroute.js:77-80`; `electron/main.js:864-866` | product:internet-downtime-tracker | open | composer25 |
| MR-TEST-009 | app | null | LOW | IPv6 public traceroute untested (mega L6) | `electron/test/lan-devices.test.js:460-462` IPv4 only | app | open | composer25 |
| MR-MR-003 | process | null | LOW | Mega lists 0 BLOCKING while plan CV had 4 product BLOCKING rows; post-impl table uses “Partial/Done” without open BLOCKING count | `docs/reviews/MEGA_REVIEW_20260812.md:47-56` vs `docs/reviews/CV_peer-gaps-plan_2026-08-12.md` | process | open | composer25 |

## Disagreements

1. **ping/traceroute vs `lan_devices_enabled`:** Mega M4. composer25 **BLOCKING** — disabling Devices is a user-facing master switch; list/refresh honor it (`lan-bridge.js`) but IPC spawns `ping`/`tracert` anyway (`main.js:861-866`). Renderer sandbox + preload allowlist still expose channels; CWE-285 broken access control. Inconsistent with “disabled = no LAN device ops.”

2. **Security PASS:** Mega security-auditor PASS with one Medium. composer25: ping/traceroute bypass alone warrants security FAIL or explicit BLOCKING carry-over; PASS reads lenient.

3. **H7 High vs Medium:** Product ships `paintDevicesDisabled`; gap is grep-only. Accept mega High for spec test contract; severity could be Medium without changing ship gate.

4. **_tick product vs greps:** Mega correctly splits “product Hold” vs “grep H5.” No disagreement.

## Art routing

None (no art FAIL ids).

## Return contract

- **Merge path:** `docs/reviews/CV_peer-gaps-impl_2026-08-12_composer25.md`
- **Gate:** `CLEAR_FORBIDDEN` (3 open BLOCKING)
- **Counts (composer25):** BLOCKING 3 · HIGH 8 · MEDIUM 10 · LOW 6 · Info 0
- **Mega 7 Highs:** all **confirmed** in code
- **Missed BLOCKING:** spec status schism (MR-MR-001), ping/traceroute master-switch bypass (MR-APP-001), CV-APP-001 product partial 30d (MR-APP-002)
