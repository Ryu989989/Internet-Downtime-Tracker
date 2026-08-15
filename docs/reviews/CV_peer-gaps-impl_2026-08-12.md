# Cross-verify: peer-gaps POST-IMPL (merged)

**Date:** 2026-08-12  
**Claims attacked:** `docs/reviews/MEGA_REVIEW_20260812.md` (FAIL, 7 High); spec `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md` L5 Done/`CLEAR_OK`  
**Reviewers:** grok46 (`cursor-grok-4.6-xhigh`) · grok45 (`cursor-grok-4.5-high`) · composer25 (`composer-2.5`)  
**Inputs:** `docs/reviews/CV_peer-gaps-impl_2026-08-12_grok46.md` · `_grok45.md` · `_composer25.md`  
**Open BLOCKING:** 4  
**Gate:** FAIL / CLEAR_FORBIDDEN  
**Verdict:** **FAIL** until product fixes land. Merge-only (no product edits, no rebuild).

Union: worst severity wins; any reviewer’s BLOCKING stays open. `reviewer` = all models that raised the claim. `sources` = isolated IDs.

## Mega-review honesty

**Honest FAIL — not fake-PASS.** Specialist union (code FAIL H2 · security PASS M1 · test FAIL H5 → merged 7 High) is arithmetically honest. All seven Highs confirmed in live code/tests. Privilege Hold and `_tick` **product** Hold confirmed (all three).

**Under-FAIL (severity), not over-FAIL (verdict):** mega H1/H2 are spec live-contract / leftover plan BLOCKING, not High. Ping/traceroute vs `lan_devices_enabled` is CWE-285 (mega M4 / security PASS). Spec L5 stamps `CLEAR_OK` while mega is FAIL.

## Per-reviewer counts (isolated)

| reviewer | BLOCKING | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| grok46 | 3 | 6 | 8 | 6 |
| grok45 | 4 | 6 | 3 | 1 |
| composer25 | 3 | 8 | 10 | 6 |

## Merged counts (union)

| | BLOCKING | HIGH | MEDIUM | LOW |
|--|----------|------|--------|-----|
| merged | **4** | **7** | **7** | **7** |

## Mega 7 Highs — real?

| Mega | Real? | Merged |
|------|-------|--------|
| H1 30d session clock | **Yes (product)** | **BLOCKING** `CV-APP-001` |
| H2 shared `lastConnRows` | **Yes (product)** | **BLOCKING** `CV-APP-002` |
| H3 `probe().http_cert_days` untested | **Yes (tests)**; product copies 3rd tuple | HIGH `CV-TEST-001` |
| H4 `_applyProbe` copy untested | **Yes (tests)**; product assigns | HIGH `CV-TEST-002` |
| H5 `_tick` greps miss module list | **Yes (tests)**; product `_tick` clean | HIGH `CV-TEST-003` |
| H6 retention 14 / `pruneProbes` vs outages | **Yes (tests)**; product default 14, `DELETE FROM probes` only | HIGH `CV-TEST-004` |
| H7 Devices-disabled UI untested | **Yes (tests)**; product `paintDevicesDisabled` exists | HIGH `CV-TEST-005` |

## Findings

| id | track | slug | severity | claim | evidence_path | fix_owner | status | reviewer | sources |
|----|-------|------|----------|-------|---------------|-----------|--------|----------|---------|
| CV-PROCESS-001 | process | null | BLOCKING | Spec **Done** stamps `CLEAR_OK` + all findings implemented while mega is FAIL and H1–H7 open | `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md:5` vs `MEGA_REVIEW_20260812.md` FAIL | process | open | grok46, grok45, composer25 | grok46 CV-PROCESS-001; grok45 CV-IMPL-004; composer25 MR-MR-001 |
| CV-APP-001 | product | internet-downtime-tracker | BLOCKING | Honest 30d: `%` = `windows["30d"]`; label clock = observation history, not `monitor.state.started_at` | `electron/main.js:529-539`; `electron/db.js:1185-1230,1343-1373`; `electron/uptime-bar.js:23-26,89-99`; `web/app.js:123,1767-1790` | product:internet-downtime-tracker | open | grok46, grok45, composer25 | grok46 CV-APP-001; grok45 CV-IMPL-001; composer25 MR-APP-002 |
| CV-APP-002 | product | internet-downtime-tracker | BLOCKING | Connections 1-cycle delta isolated from Topology/sniffer (`applySnapshotDelta` not process-global) | `electron/connections.js:91,97,445-513`; `electron/lan-bridge.js:33,229`; `electron/packet-sniffer.js:126-128` | product:internet-downtime-tracker | open | grok46, grok45, composer25 | grok46 CV-APP-002; grok45 CV-IMPL-002; composer25 MR-APP-003 |
| CV-APP-003 | product | internet-downtime-tracker | BLOCKING | `lan_devices_enabled=false` blocks ping/traceroute IPC (not UI-only) | `electron/main.js:861-866`; `electron/lan-devices.js:476-493`; contrast `electron/lan-bridge.js:67-71,148-151` | product:internet-downtime-tracker | open | grok46, grok45, composer25 | grok46 CV-APP-003; grok45 CV-IMPL-003; composer25 MR-APP-001 |
| CV-TEST-001 | app | internet-downtime-tracker | HIGH | Spec `probe().http_cert_days` + LAN-down skip `checkHttp` tested | `electron/test/netcheck.test.js` (no `probe` import); `electron/netcheck.js:486-504` | app | open | grok46, grok45, composer25 | grok46 CV-TEST-001; grok45 CV-IMPL-005; composer25 MR-TEST-001 |
| CV-TEST-002 | app | internet-downtime-tracker | HIGH | `_applyProbe`/`snapshot().http_cert_days` asserted | `electron/test/monitor.test.js:12-22`; `electron/monitor.js:425` | app | open | grok46, grok45, composer25 | grok46 CV-TEST-002; grok45 CV-IMPL-006; composer25 MR-TEST-002 |
| CV-TEST-003 | app | internet-downtime-tracker | HIGH | `monitor.js` greps cover spec module list | `electron/test/lan-security.test.js:24-41`; `electron/test/security.test.js:273-288`; `electron/monitor.js:8-9,364+` | app | open | grok46, grok45, composer25 | grok46 CV-TEST-003; grok45 CV-IMPL-007; composer25 MR-TEST-003 |
| CV-TEST-004 | app | internet-downtime-tracker | HIGH | Retention 14 + `pruneProbes` does not delete outages | no `probe_retention_days`/`pruneProbes` in `electron/test/**`; `electron/db.js:19,927-935` | app | open | grok46, grok45, composer25 | grok46 CV-TEST-004; grok45 CV-IMPL-008; composer25 MR-TEST-004 |
| CV-TEST-005 | app | internet-downtime-tracker | HIGH | Devices-disabled UI shows `data.warning` | `web/app.js:2257-2271,2325`; `electron/test/ui.test.js` no `paintDevicesDisabled` | app | open | grok46, grok45, composer25 | grok46 CV-TEST-005; grok45 CV-IMPL-009; composer25 MR-TEST-005 |
| CV-APP-004 | product | internet-downtime-tracker | HIGH | Cert days wiped when HTTP not probed | `electron/monitor.js:425`; `electron/netcheck.js:484-504` | product:internet-downtime-tracker | open | grok46, grok45, composer25 | grok46 CV-APP-004; grok45 CV-IMPL-010; composer25 MR-APP-004 |
| CV-PROCESS-002 | process | null | HIGH | Security specialist PASS understates ping/traceroute bypass (should FAIL or carry BLOCKING) | `docs/reviews/MEGA_REVIEW_20260812.md` security PASS; `electron/main.js:861-866` | process | open | grok46, grok45, composer25 | composer25 MR-MR-002; grok46/grok45 mega-honesty |
| CV-APP-005 | product | internet-downtime-tracker | MEDIUM | Adapter chips omit session bytes (NetWorx Yes) | `web/app.js:3146-3158` vs `computeAdapterRates` `rx_bytes`/`tx_bytes` | product:internet-downtime-tracker | open | grok46, grok45, composer25 | grok46 CV-APP-005; grok45 CV-IMPL-011; composer25 MR-APP-005 |
| CV-APP-006 | product | internet-downtime-tracker | MEDIUM | `hostname_source` memory-only; “passive cache” after restart | `electron/lan-devices.js:318-320,457-467`; `db.js` `lan_devices` has no `hostname_source` | product:internet-downtime-tracker | open | grok46, grok45, composer25 | grok46 CV-APP-006; grok45 CV-IMPL-014; composer25 MR-APP-006 |
| CV-APP-007 | app | internet-downtime-tracker | MEDIUM | `connections_resolve_dns` default false not on `getSettings()` test | `electron/db.js:27`; `electron/test/usage-db.test.js:103-108` | app | open | grok46, composer25 | grok46 CV-APP-007; composer25 MR-APP-007 |
| CV-APP-008 | app | internet-downtime-tracker | MEDIUM | null / `<1d` / 30.0d `pct_label` untested | `electron/uptime-bar.js:23-24`; `electron/test/uptime-bar.test.js:13-44` | app | open | grok46, composer25 | grok46 CV-APP-008; composer25 MR-TEST-006 |
| CV-APP-009 | product | internet-downtime-tracker | MEDIUM | `tracerouteHost` not private-only | `electron/traceroute.js:67-71` vs wrapper `lan-devices.js:490-492` | product:internet-downtime-tracker | open | grok46, grok45, composer25 | grok46 CV-APP-009; grok45 CV-IMPL-012; composer25 MR-APP-008 |
| CV-APP-010 | app | internet-downtime-tracker | MEDIUM | Same-response cert / no second HTTP from `_tick` unlocked | `electron/test/netcheck.test.js:112-134`; `electron/monitor.js` | app | open | grok46, composer25 | grok46 CV-APP-010; composer25 MR-TEST-007 |
| CV-APP-011 | app | internet-downtime-tracker | MEDIUM | UI contracts for Overview/Devices/Connections/Usage missing | `electron/test/ui.test.js` only `hist-type`/`topo-nb`/`topo-conns` | app | open | grok46, grok45, composer25 | grok46 CV-APP-011; grok45 CV-IMPL-013; composer25 MR-TEST-008 |
| CV-APP-012 | product | internet-downtime-tracker | LOW | Duplicated `formatHttpCertDays` | `web/app.js:230-242`; `electron/uptime-bar.js:35-47` | product:internet-downtime-tracker | open | grok46, composer25 | grok46 CV-APP-012; composer25 MR-APP-009 |
| CV-APP-013 | product | internet-downtime-tracker | LOW | rDNS timeout caches `null` for session | `electron/connections.js:429-437` | product:internet-downtime-tracker | open | grok46, composer25 | grok46 CV-APP-013; composer25 MR-APP-010 |
| CV-APP-014 | product | internet-downtime-tracker | LOW | Neighbor disclaimer omits “not a switch fabric” | `electron/lan-devices.js:312-316,688-693` vs `snmp-topology.js:164` | product:internet-downtime-tracker | open | grok46, composer25 | grok46 CV-APP-014; composer25 MR-APP-011 |
| CV-APP-015 | product | internet-downtime-tracker | LOW | Settings privilege: CIM/NBT emptiness unelevated | Settings copy vs no `requestedExecutionLevel` | product:internet-downtime-tracker | open | grok46, composer25 | grok46 CV-APP-015; composer25 MR-APP-012 |
| CV-APP-016 | product | internet-downtime-tracker | LOW | Uncapped in-flight traceroute IPC | `electron/traceroute.js:77-80`; `electron/main.js:864-866` | product:internet-downtime-tracker | open | grok46, composer25 | grok46 CV-APP-016; composer25 MR-APP-013 |
| CV-APP-017 | app | internet-downtime-tracker | LOW | IPv6 public traceroute untested | `port-scan.js` `fc`/`fd`/`fe80`; traceroute tests IPv4-only (`lan-devices.test.js:460-462`) | app | open | grok46, composer25 | grok46 CV-APP-017; composer25 MR-TEST-009 |
| CV-PROCESS-003 | process | null | LOW | Mega lists 0 BLOCKING while plan CV had open product BLOCKING; post-impl table uses Partial/Done without open BLOCKING count | `MEGA_REVIEW_20260812.md:47-56` vs `CV_peer-gaps-plan_2026-08-12.md` | process | open | composer25 | composer25 MR-MR-003 |

---

### CV-PROCESS-001 — BLOCKING

**claim:** Spec **Done** includes mega-review + triple CV `CLEAR_OK` + all findings implemented.

**evidence:** Spec L5 past-tense Done vs `MEGA_REVIEW_STATUS: FAIL` and open H1/H2. Review gate 4 still says mega → CV → implement findings.

**attack:** Status schism. A later agent can treat the pass as closed while Overview 30d and Connections delta remain wrong.

**fix:** Strip `CLEAR_OK` / “all findings implemented” from spec; stamp **FAIL until product fixes land**.

### CV-APP-001 — BLOCKING (mega H1 under-scored)

**claim:** Honest 30d: number = `windows["30d"]`; if observation window (`observeSince` / **first probe**) < 30d, label actual days — not session uptime.

**evidence:** `api:summary` sets `observeSince = monitor.state.started_at`. `summary()` loads `firstProbe = MIN(timestamp)` then **does not return it**; `observeStart` uses caller `observeSince`. `windows["30d"]` denominator stays 30d outage overlap. UI `paintUptimeBar30` prefers `uptime_bar.pct_label`. After restart of a 40d DB: `"<1d observed"` + 30d `%`. Spark captions stay honest (24h / 14d).

**attack:** Forged Overview metric. Plan `CV-APP-001` BLOCKING not closed.

**fix:** `observeSince = MIN(first outage.started_at, firstProbe.t)` (outages not pruned). Do not bump `probe_retention_days`. Test: 40d-old outage + 1h `started_at` → `pct_label === "30d"`.

### CV-APP-002 — BLOCKING (mega H2 under-scored)

**claim:** TCPView Yes-row: new/changed/dropped highlight **one cycle** on the Connections snapshot.

**evidence:** `snapshot()` always `applySnapshotDelta` + `computeAdapterRates` (module globals `lastConnRows`, `lastAdapterSample`). Sidecars: sniffer `fetchFlows` every **2s** `snapshot({ establishedOnly: true })`; Topology `lan-bridge.js:229` same. Next Connections paint: Listen/non-established → `delta: "new"`; dropped ghosts appended into sniffer `flows`. Tests only isolate `snapshot()`.

**attack:** Network tab sibling (Topology or Sniffer) breaks the shipped highlight contract. composer25 filed HIGH; grok46+grok45 BLOCKING → union BLOCKING.

**fix:** `snapshot({ trackDelta: false, trackAdapters: false })` for sidecar callers; only `api:connections:snapshot` tracks delta. Test: sidecar must not change next UI snapshot `delta`.

### CV-APP-003 — BLOCKING (mega M4 under-scored; grok46 HIGH escalated)

**claim:** `lan_devices_enabled=false` stops Devices work including on-demand ping/traceroute.

**evidence:** `listDevices`/`refreshDevices` return `devicesDisabledPayload()`. IPC `api:lan:devices:ping|traceroute` calls `pingDevice`/`tracerouteDevice` with only `isPrivateOrLocalIp`. UI hides buttons; sandboxed renderer/DevTools can still `execFile` ping/tracert on LAN. Public IPs still rejected.

**attack:** Settings master switch is UI-only for ICMP/tracert (CWE-285 / A01). grok46 HIGH (private-IP + local → not ship-BLOCKING); grok45+composer25 BLOCKING. Unresolved ship-critical → **BLOCKING**.

**fix:** If `lan_devices_enabled === false`, return `devicesDisabledPayload()` before spawn. Unit: disabled settings never call `pingHost`/`tracerouteHost`.

## Disagreements

| Fact | grok46 | grok45 | composer25 | Merge |
|------|--------|--------|------------|-------|
| 30d session clock | BLOCKING | BLOCKING | BLOCKING | **BLOCKING** |
| Shared Connections delta | BLOCKING | BLOCKING | HIGH | **BLOCKING** (union) |
| Ping/traceroute vs devices-off | HIGH | BLOCKING | BLOCKING | **BLOCKING** (union; ship-critical) |
| Cert wipe when HTTP skipped | MEDIUM | HIGH | MEDIUM | **HIGH** |
| `hostname_source` memory-only | MEDIUM | LOW | MEDIUM | **MEDIUM** |
| H7 Devices UI test | HIGH | HIGH | HIGH (borderline M) | **HIGH** |
| Security specialist PASS | rosy (narrative) | under-FAIL (narrative) | HIGH process | **HIGH** `CV-PROCESS-002` |
| Privilege / `_tick` product | Hold | Hold | Hold | Hold |
| Mega overall | FAIL (honest) | FAIL (honest) | FAIL (honest) | **FAIL** |

## Claims that held (not findings)

- Debounce / WAN-while-LAN-down / no public bind / Electron `contextIsolation`+sandbox / preload allowlist + `safeHandle` sender check.
- `checkHttp` 3-tuple + same-response cert; HTTP → `null` not `0`; `_applyProbe` copies `http_cert_days`; `_tick` control flow unchanged (product).
- Traceroute module on-demand, not netcheck, not `_tick`.
- `connections_resolve_dns` default false in `DEFAULT_SETTINGS`.
- Spark never labeled 30d. Privilege: Electron asInvoker default; Usage helper still UAC.
- Mega `npm test` 135/135: composer25 verified locally; grok46/grok45 assumed. Packaged rebuild: not run (instructed skip).

## Art routing

None (no cover/print artifacts).

## Return contract

- **Merge path:** `docs/reviews/CV_peer-gaps-impl_2026-08-12.md`
- **Open BLOCKING:** 4
- **Gate:** `CLEAR_FORBIDDEN`
- **Counts:** BLOCKING 4 · HIGH 7 · MEDIUM 7 · LOW 7
