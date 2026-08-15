# Cross-verify: peer-gaps POST-IMPL (grok45)

**Date:** 2026-08-12  
**Reviewer:** grok45 (`cursor-grok-4.5-high`) — isolated Task 2/3  
**Claims attacked:** `docs/reviews/MEGA_REVIEW_20260812.md` (FAIL, 7 High); product vs `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md`  
**Did not read:** other `CV_peer-gaps-impl_*` files  
**Did not:** implement, rebuild, relaunch  

**Gate:** **FAIL**  
**Open BLOCKING:** 4 · High: 6 · Medium: 3 · Low: 1  

## Attack verdict

| Question | Result |
|----------|--------|
| Mega honest or fake-PASS / over-FAIL? | **Honest FAIL overall** — not fake-PASS. Mild **under-severity**: plan BLOCKING (honest 30d) demoted to High; Devices kill-switch IPC left Medium. The 7 Highs are **real in code/tests** (not invented). |
| 7 Highs real? | **Yes** — H1–H2 product bugs; H3–H7 missing/weak test locks (product often partial-OK). |
| Missed BLOCKING? | **Yes** — 30d label clock, shared Connections delta, ping/traceroute vs `lan_devices_enabled`, plus spec “Done / CLEAR_OK” vs mega FAIL schism. Privilege + product `_tick` Holds are correct. |

## Counts (this reviewer)

| severity | n |
|----------|---|
| BLOCKING | 4 |
| HIGH | 6 |
| MEDIUM | 3 |
| LOW | 1 |

## Findings

| id | track | slug | severity | claim | evidence_path | fix_owner | status | reviewer |
|----|-------|------|----------|-------|---------------|-----------|--------|----------|
| CV-IMPL-001 | product | internet-downtime-tracker | BLOCKING | Honest-30d ship contract still broken: `%` = `windows["30d"]` outage math; label clock = `monitor.state.started_at` (session), not history. After restart UI reads like “&lt;1d/Nd observed · X% down” where X is 30d-denominator. Mega listed as H1 / CV-APP-001 Partial — **under-severed**; plan BLOCKING still open. | `electron/main.js:529-538`; `electron/db.js:1187,1221-1230` (`firstProbe` loaded then unused for observe clock when `observeSince` passed); `electron/uptime-bar.js:23-26,89-99`; tip copy `web/app.js:123` | product:internet-downtime-tracker | open | grok45 |
| CV-IMPL-002 | product | internet-downtime-tracker | BLOCKING | Connections delta is process-global; Topology/sniffer `snapshot({ establishedOnly: true })` rewrites `lastConnRows` → next Connections paint marks Listen/non-EST as `new` and can push `dropped` ghosts into sniffer flows. Spec: one-cycle highlight on Connections only. Mega H2 real; escalate — primary multi-panel corruption. | `electron/connections.js:97,445-464,512`; `electron/lan-bridge.js:33,229` | product:internet-downtime-tracker | open | grok45 |
| CV-IMPL-003 | product | internet-downtime-tracker | BLOCKING | Devices master switch does not gate ping/traceroute IPC. `listDevices`/`refresh` honor `lan_devices_enabled===false`; `pingDevice`/`tracerouteDevice` only check private IP then spawn. Mega M4 under-severed (CWE-285 / A01). | `electron/main.js:861-866`; `electron/lan-devices.js:476-493`; contrast `electron/lan-bridge.js:67-71,148-151` | product:internet-downtime-tracker | open | grok45 |
| CV-IMPL-004 | process | null | BLOCKING | Status schism: spec stamp “Done … triple CV CLEAR_OK; all CV findings implemented” vs mega `MEGA_REVIEW_STATUS: FAIL` + open Highs / partial plan BLOCKING. Invalid completion claim. | `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md:5`; `docs/reviews/MEGA_REVIEW_20260812.md:13-15,252-253` | process | open | grok45 |
| CV-IMPL-005 | product | internet-downtime-tracker | HIGH | `probe().http_cert_days` + LAN-down `checkHttp` skip untested (mega H3). Product wires 3-tuple in `probe()`; `netcheck.test.js` never imports `probe`. | `electron/netcheck.js:486-504`; `electron/test/netcheck.test.js` (checkHttp only) | product:internet-downtime-tracker | open | grok45 |
| CV-IMPL-006 | product | internet-downtime-tracker | HIGH | Monitor `http_cert_days` copy unasserted (mega H4). Product assigns at `_applyProbe`; `makeResult()` omits field — removing copy still passes. | `electron/monitor.js:425`; `electron/test/monitor.test.js:12-22` | product:internet-downtime-tracker | open | grok45 |
| CV-IMPL-007 | product | internet-downtime-tracker | HIGH | `_tick` isolation greps miss spec module list (mega H5). Product `_tick` clean (only netcheck+uptime-bar requires). Tests miss `usage-bridge`/`connections`/`snmp-topology`/`packet-sniffer`/`port-scan`; `main.js` adjacency regex never hits real `_tick`. | `electron/monitor.js:8-9,364+`; `electron/test/lan-security.test.js:24-41`; `electron/test/security.test.js:273-288` | product:internet-downtime-tracker | open | grok45 |
| CV-IMPL-008 | product | internet-downtime-tracker | HIGH | No lock that `probe_retention_days===14` or `pruneProbes` never deletes outages (mega H6). Product OK today (`DELETE FROM probes` only; default 14) — unguarded. | `electron/db.js:19,927-935`; no hits in `electron/test/**` | product:internet-downtime-tracker | open | grok45 |
| CV-IMPL-009 | product | internet-downtime-tracker | HIGH | Devices-disabled UI warning untested (mega H7). Product has `paintDevicesDisabled`; `ui.test.js` has zero greps for it / `data.warning` path. | `web/app.js:2257-2271,2325`; `electron/test/ui.test.js` | product:internet-downtime-tracker | open | grok45 |
| CV-IMPL-010 | product | internet-downtime-tracker | HIGH | `http_cert_days` wiped on lower-layer skip (mega M1). `_applyProbe` always nulls when `probe()` never called `checkHttp`. | `electron/monitor.js:425`; `electron/netcheck.js:484-504` | product:internet-downtime-tracker | open | grok45 |
| CV-IMPL-011 | product | internet-downtime-tracker | MEDIUM | Adapter chips omit session bytes / “since last refresh” (mega M2 / NetWorx Yes). | `web/app.js` adapter chip path (~3146+); `connections.computeAdapterRates` returns `rx_bytes`/`tx_bytes` | product:internet-downtime-tracker | open | grok45 |
| CV-IMPL-012 | product | internet-downtime-tracker | MEDIUM | `tracerouteHost` private guard only in wrapper (mega M7). | `electron/traceroute.js`; guard at `lan-devices.js:490-492` | product:internet-downtime-tracker | open | grok45 |
| CV-IMPL-013 | product | internet-downtime-tracker | MEDIUM | New Overview/Devices/Connections UI tip contracts thin (mega M9). | `electron/test/ui.test.js` | product:internet-downtime-tracker | open | grok45 |
| CV-IMPL-014 | product | internet-downtime-tracker | LOW | Hostname source / “passive cache” disclaimer memory-only (mega M3). | `electron/lan-devices.js` hostname cache / tip paths | product:internet-downtime-tracker | open | grok45 |

## Preferred attack areas (explicit)

| Area | Mega said | grok45 |
|------|-----------|--------|
| Privilege (unelevated default) | Hold / 9 | **Hold OK** — no `requestedExecutionLevel` in nsis; Usage still UAC helper |
| `_tick` coupling | Hold product; H5 greps | **Hold product OK**; H5 real as HIGH test gap |
| 30d mislabel | High H1 | **BLOCKING** (CV-IMPL-001) |
| Shared connections delta | High H2 | **BLOCKING** (CV-IMPL-002) |
| Ping/traceroute vs `lan_devices_enabled` | Medium M4 | **BLOCKING** (CV-IMPL-003) |

## Mega honesty notes

- Verdict **FAIL / Do not ship** matches evidence; CI 135/135 does not stamp ship (skill: scripts green ≠ READY).
- Not over-FAIL: H1–H2 reproducible; H3–H7 match missing assertions.
- Under-FAIL risk: demoting open plan **CV-APP-001** to High; leaving Devices IPC kill-switch at Medium.
- Fable-judge table accurate on `_tick` product Hold, privilege Hold, rebuild skip.

## Return

**FAIL** — BLOCKING **4** · HIGH **6** · MEDIUM **3** · LOW **1**
