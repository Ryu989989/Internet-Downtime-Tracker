# Cross-verify: peer-gaps POST-IMPL (isolated grok46)

**Date:** 2026-08-12  
**Reviewer:** grok46 (`cursor-grok-4.6-xhigh`)  
**Claims attacked:** `docs/reviews/MEGA_REVIEW_20260812.md` FAIL/7 High; spec `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md`; product vs privilege, `_tick`, 30d label, shared connections delta, ping/traceroute vs `lan_devices_enabled`.  
**Did not read:** `CV_peer-gaps-impl_*`. No product edits. No rebuild/relaunch. `npm test` not re-run.  
**Open BLOCKING:** 3  
**Gate:** FAIL / CLEAR_FORBIDDEN

## Mega-review honesty

**Not fake-PASS.** Merge **FAIL / Do not ship** matches product. Specialist union (code FAIL H2 · security PASS M1 · test FAIL H5 → merged 7 High) is arithmetically honest. Line cites for H1–H7 match live code. Privilege Hold and `_tick` product Hold are correct.

**Under-FAIL (severity), not over-FAIL (verdict):** mega H1 (30d session clock) and H2 (shared `lastConnRows`) are **spec live-contract / Yes-row breaks** and leftover plan `CV-APP-001`. They are **BLOCKING**, not High. Security specialist **PASS** while ping/traceroute IPC ignores `lan_devices_enabled` (CWE-285) is rosy; merge kept it Medium (**M4**) — should be **HIGH**. H3–H7 are real **test** Highs (product already implements those behaviors).

**Status schism:** spec **Done** claims `triple CV CLEAR_OK` and “all CV findings implemented” while mega is FAIL and 30d/delta still wrong.

## Per-reviewer counts

| reviewer | BLOCKING | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| grok46 | 3 | 6 | 8 | 6 |

## Mega 7 Highs — real in code?

| Mega | Real? | This review |
|------|-------|-------------|
| H1 30d session clock `main.js:529-539` | **Yes (product)** | **BLOCKING** `CV-APP-001` |
| H2 `applySnapshotDelta` always; Topology/sniffer `establishedOnly` | **Yes (product)** | **BLOCKING** `CV-APP-002` |
| H3 `probe().http_cert_days` untested | **Yes (tests)**; product `netcheck.js:492-504` copies 3rd tuple | HIGH `CV-TEST-001` |
| H4 `_applyProbe` copy untested | **Yes (tests)**; product `monitor.js:425` copies | HIGH `CV-TEST-002` |
| H5 `_tick` greps miss module list | **Yes (tests)**; product `_tick` is probe/prune/adapter/quality only | HIGH `CV-TEST-003` |
| H6 no `probe_retention_days===14` / `pruneProbes` vs outages lock | **Yes (tests)**; product default 14, `DELETE FROM probes` only | HIGH `CV-TEST-004` |
| H7 Devices disabled UI untested | **Yes (tests)**; product `paintDevicesDisabled` exists | HIGH `CV-TEST-005` |

## Attack checklist (requested BLOCKING candidates)

| Attack | Result |
|--------|--------|
| Privilege (unelevated default) | **Hold** — no `requestedExecutionLevel` in `package.json` nsis/win; Usage `Start-Process -Verb RunAs` only |
| `monitor._tick` LAN/usage/topology/sniffer/scan/traceroute | **Hold (product)** — `monitor.js` requires netcheck + uptime-bar; `_tick` 364–405 probe/prune/adapter/quality. Greps incomplete → H5 |
| 30d mislabel | **BLOCKING** — `%` is 30d outage window; label clock is `monitor.state.started_at` |
| Shared connections delta | **BLOCKING** — `applySnapshotDelta` + `lastAdapterSample` process-global |
| Ping/traceroute vs `lan_devices_enabled` | **HIGH** (mega under-scored as M4) — list/refresh gated; IPC spawn not |

## Findings

| id | track | slug | severity | claim | evidence_path | fix_owner | status | reviewer |
|----|-------|------|----------|-------|---------------|-----------|--------|----------|
| CV-PROCESS-001 | process | null | BLOCKING | Spec **Done** stamps `CLEAR_OK` + all findings implemented | `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md:5` vs mega FAIL | process | open | grok46 |
| CV-APP-001 | product | internet-downtime-tracker | BLOCKING | Honest 30d uses observation history, not session start | `electron/main.js:529-539`; `electron/db.js:1185-1230,1343-1373`; `web/app.js:123,1767-1790` | product:internet-downtime-tracker | open | grok46 |
| CV-APP-002 | product | internet-downtime-tracker | BLOCKING | Connections 1-cycle delta isolated from Topology/sniffer | `electron/connections.js:91,445-513`; `electron/lan-bridge.js:33,229`; `electron/packet-sniffer.js:126-128` | product:internet-downtime-tracker | open | grok46 |
| CV-APP-003 | product | internet-downtime-tracker | HIGH | Devices master switch blocks ping/traceroute IPC | `electron/main.js:861-866`; `electron/lan-devices.js:476-493`; contrast `lan-bridge.js:67-71,148-151` | product:internet-downtime-tracker | open | grok46 |
| CV-TEST-001 | app | internet-downtime-tracker | HIGH | Spec `probe().http_cert_days` + LAN-down skip `checkHttp` tested | `electron/test/netcheck.test.js` (no `probe` import); `electron/netcheck.js:486-504` | app | open | grok46 |
| CV-TEST-002 | app | internet-downtime-tracker | HIGH | `_applyProbe`/`snapshot().http_cert_days` asserted | `electron/test/monitor.test.js:12-22`; `electron/monitor.js:425` | app | open | grok46 |
| CV-TEST-003 | app | internet-downtime-tracker | HIGH | `monitor.js` greps cover spec module list | `electron/test/lan-security.test.js:24-41`; `electron/test/security.test.js:273-288` | app | open | grok46 |
| CV-TEST-004 | app | internet-downtime-tracker | HIGH | Retention 14 + `pruneProbes` does not delete outages | no `probe_retention_days`/`pruneProbes` in `electron/test/**`; `electron/db.js:19,927-935` | app | open | grok46 |
| CV-TEST-005 | app | internet-downtime-tracker | HIGH | Devices-disabled UI shows `data.warning` | `web/app.js:2257-2271`; `electron/test/ui.test.js` no `paintDevicesDisabled` | app | open | grok46 |
| CV-APP-004 | product | internet-downtime-tracker | MEDIUM | Cert days wiped when HTTP not probed | `electron/monitor.js:425`; `electron/netcheck.js:484-504` | product:internet-downtime-tracker | open | grok46 |
| CV-APP-005 | product | internet-downtime-tracker | MEDIUM | Adapter chips omit session bytes (NetWorx Yes) | `web/app.js:3146-3158` vs `computeAdapterRates` `rx_bytes`/`tx_bytes` | product:internet-downtime-tracker | open | grok46 |
| CV-APP-006 | product | internet-downtime-tracker | MEDIUM | `hostname_source` memory-only; “passive cache” after restart | `electron/lan-devices.js:318-320,457-467`; `db.js` `lan_devices` has no `hostname_source` | product:internet-downtime-tracker | open | grok46 |
| CV-APP-007 | app | internet-downtime-tracker | MEDIUM | `connections_resolve_dns` default false not on `getSettings()` test | `electron/db.js:27`; `electron/test/usage-db.test.js` defaults omit key | app | open | grok46 |
| CV-APP-008 | app | internet-downtime-tracker | MEDIUM | null / `<1d` / 30.0d `pct_label` untested | `electron/uptime-bar.js:23-24`; `uptime-bar.test.js:13-44` | app | open | grok46 |
| CV-APP-009 | product | internet-downtime-tracker | MEDIUM | `tracerouteHost` not private-only | `electron/traceroute.js:67-71` vs wrapper `lan-devices.js:490-492` | product:internet-downtime-tracker | open | grok46 |
| CV-APP-010 | app | internet-downtime-tracker | MEDIUM | Same-response cert / no second HTTP from `_tick` unlocked | `electron/test/netcheck.test.js:112-134` no request count | app | open | grok46 |
| CV-APP-011 | app | internet-downtime-tracker | MEDIUM | UI contracts for Overview/Devices/Connections/Usage missing | `electron/test/ui.test.js` only `hist-type`/`topo-nb`/`topo-conns` | app | open | grok46 |
| CV-APP-012 | product | internet-downtime-tracker | LOW | Duplicated `formatHttpCertDays` | `web/app.js:230-242`; `electron/uptime-bar.js:35-47` | product:internet-downtime-tracker | open | grok46 |
| CV-APP-013 | product | internet-downtime-tracker | LOW | rDNS timeout caches `null` for session | `electron/connections.js:429-437` | product:internet-downtime-tracker | open | grok46 |
| CV-APP-014 | product | internet-downtime-tracker | LOW | Neighbor disclaimer omits “not a switch fabric” | `electron/lan-devices.js:312-316` vs `snmp-topology.js` stubs | product:internet-downtime-tracker | open | grok46 |
| CV-APP-015 | product | internet-downtime-tracker | LOW | Settings privilege: CIM/NBT emptiness unelevated | Settings copy vs no `requestedExecutionLevel` | product:internet-downtime-tracker | open | grok46 |
| CV-APP-016 | product | internet-downtime-tracker | LOW | Uncapped in-flight traceroute IPC | `electron/traceroute.js:77-80`; `electron/main.js:864-866` | product:internet-downtime-tracker | open | grok46 |
| CV-APP-017 | app | internet-downtime-tracker | LOW | IPv6 public traceroute untested | `port-scan.js` `fc`/`fd`/`fe80`; traceroute tests IPv4-only | app | open | grok46 |

---

### CV-PROCESS-001 — BLOCKING

**claim:** Spec **Done** includes mega-review + triple CV `CLEAR_OK` + all findings implemented.

**evidence:** Spec L5 past-tense Done vs `MEGA_REVIEW_20260812.md` `MEGA_REVIEW_STATUS: FAIL` and open H1/H2. Review gate 4 still says mega → CV → implement findings.

**attack:** Status schism. A later agent can treat the pass as closed while Overview 30d and Connections delta remain wrong.

**fix:** Strip `CLEAR_OK` / “all findings implemented” from spec until this CV gate is actually green.

### CV-APP-001 — BLOCKING (mega H1 under-scored)

**claim:** Honest 30d: number = `windows["30d"]`; if observation window (`observeSince` / **first probe**) < 30d, label actual days — not session uptime.

**evidence:** `api:summary` sets `observeSince = monitor.state.started_at` (process start, `monitor.js:97`). `summary()` loads `firstProbe = MIN(timestamp)` then **does not return it**; `observeStart` uses caller `observeSince` so first probe never reaches `honestUptimeBar`. `windows["30d"]` denominator stays 30d outage overlap. UI `paintUptimeBar30` prefers `uptime_bar.pct_label`; tooltip `stat-30d` promises “30d only if observed ≥ 30d”. After restart of a 40d DB: `"<1d observed"` + 30d `%`. Spark captions stay honest (24h / 14d).

**attack:** Forged Overview metric. Plan `CV-APP-001` BLOCKING not closed. Mega “Partial” + High is the wrong gate.

**fix:** `observeSince = MIN(first outage.started_at, firstProbe.t)` (outages not pruned). Do not bump `probe_retention_days`. Test: 40d-old outage + 1h `started_at` → `pct_label === "30d"`.

### CV-APP-002 — BLOCKING (mega H2 under-scored)

**claim:** TCPView Yes-row: new/changed/dropped highlight **one cycle** on the Connections snapshot.

**evidence:** `snapshot()` always `applySnapshotDelta` + `computeAdapterRates` (module globals `lastConnRows`, `lastAdapterSample`). No `trackDelta`/`trackAdapters` opts. Sidecars: sniffer `fetchFlows` every **2s** `snapshot({ establishedOnly: true })`; Topology `lan-bridge.js:229` same. Next Connections paint: Listen/non-established → `delta: "new"`; dropped ghosts appended into sniffer `flows`. Tests only isolate `snapshot()`.

**attack:** Network tab sibling (Topology or Sniffer) breaks the shipped highlight contract continuously when sniffer is on; one Topology visit is enough.

**fix:** `snapshot({ trackDelta: false, trackAdapters: false })` for sidecar callers; only `api:connections:snapshot` tracks delta. Test: sidecar must not change next UI snapshot `delta`.

### CV-APP-003 — HIGH (mega M4 under-scored; not BLOCKING)

**claim:** `lan_devices_enabled=false` stops Devices work including on-demand ping/traceroute.

**evidence:** `listDevices`/`refreshDevices` return `devicesDisabledPayload()`. IPC `api:lan:devices:ping|traceroute` calls `pingDevice`/`tracerouteDevice` with only `isPrivateOrLocalIp`. UI hides buttons (`paintDevicesDisabled`); sandboxed renderer/DevTools can still `execFile` ping/tracert on LAN. Public IPs still rejected.

**attack:** Settings master switch is UI-only for ICMP/tracert (CWE-285). Local + private-IP gated → High, not ship-BLOCKING like 30d/delta.

**fix:** If `lan_devices_enabled === false`, return `devicesDisabledPayload()` before spawn. Unit: disabled settings never call `pingHost`/`tracerouteHost`.

## Claims that held (not findings)

- Debounce / WAN-while-LAN-down / no public bind / Electron `contextIsolation`+sandbox / preload allowlist + `safeHandle` sender check.
- `checkHttp` 3-tuple + same-response cert; HTTP → `null` not `0`; `_applyProbe` copies `http_cert_days`; `_tick` control flow unchanged.
- Traceroute module on-demand, not netcheck, not `_tick`.
- `connections_resolve_dns` default false in `DEFAULT_SETTINGS`.
- Spark never labeled 30d. Privilege: Electron asInvoker default; Usage helper still UAC.
- Mega `npm test` 135/135: **assumed** (not re-run). Packaged rebuild: not run (instructed skip).

## Disagreements with mega

| Fact | Mega | grok46 | Why |
|------|------|--------|-----|
| 30d session clock | High | **BLOCKING** | Spec live contract + leftover plan BLOCKING; Overview lie after restart |
| Shared delta | High | **BLOCKING** | Yes-row 1-cycle broken by Topology/sniffer always-on globals |
| Ping/traceroute vs devices-off | Medium | **HIGH** | IPC policy hole; still private-IP + local |
| Privilege / `_tick` product | Hold | Hold | Confirmed |
| H3–H7 | High | High | Real CI holes; product already correct |
| Overall | FAIL | **FAIL** | Honest; would still FAIL after severity fix |

## Art routing

None (no cover/print artifacts).
