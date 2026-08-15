# Cross-verify: peer-gaps POST-IMPL re-CV (grok46)

**Date:** 2026-08-12  
**Claims attacked:** prior FAIL merge `docs/reviews/CV_peer-gaps-impl_2026-08-12.md` (4 open BLOCKING) vs live code after product fixes. Spec `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md`.  
**Reviewer:** grok46 (`cursor-grok-4.6-xhigh`)  
**Isolation:** did not read `CV_peer-gaps-impl_2026-08-12_re_*`. No product edits. No rebuild/relaunch. No `npm test`.  
**Open BLOCKING:** 0  
**Gate:** CLEAR_OK

Honest: the four ship-BLOCKING product bugs are closed in live source. Leftovers below are HIGH/MEDIUM/LOW only. Prefer FAIL if any of those four still lied — they do not.

## Per-reviewer counts

| reviewer | BLOCKING | HIGH | MEDIUM | LOW |
|----------|----------|------|--------|-----|
| grok46 | 0 | 1 | 2 | 3 |

## Claimed-fixed BLOCKING (live)

| prior id | claim | live verdict | evidence |
|----------|-------|--------------|----------|
| CV-APP-001 | `observeSince` = MIN(first probe, first outage), not session `started_at` | **fixed** | `main.js:529-545`: `observationStart({ firstProbeAt, firstOutageAt })` → `observe_since`; `honestUptimeBar(sum, { firstProbeAt, firstOutageAt })` — no `started_at`. `uptime-bar.js:12-20` MIN of those clocks; comment: session is not history. UI `app.js:1783-1788` prefers `uptime_bar.pct_label`. Test: 40d `firstOutageAt` + 1h `observeSince` → `pct_label === "30d"` (`uptime-bar.test.js:46-55`). `windows["30d"]` still 30d outage overlap (spec). |
| CV-APP-002 | `snapshot` `trackDelta` default false; IPC passes true | **fixed** | `connections.js:471-475` `!!opts.trackDelta` / `!!opts.trackAdapters` (default false). `main.js:753-758` `api:connections:snapshot` passes both true. Sidecars `lan-bridge.js:34-38,234-237` pass both false. `packet-sniffer.js` has no `snapshot(`. Test `connections.test.js:324-375` sidecar without flags must not steal UI delta/adapters. |
| CV-APP-003 | `lan_devices_enabled=false` blocks ping/traceroute before spawn | **fixed** | `lan-devices.js:527-550`: `lanDevicesEnabled()` then return `devicesDisabledProbe` **before** `pingHost` / `tracerouteHost`. IPC `main.js:869-873` → those wrappers. `lanBridge.init` then `registerIpc` (`main.js:911-912`); getter `() => settings()` → `db.getSettings()` (bool-coerced). Test `lan-devices.test.js:481-498` fail-if-spawn. |
| CV-APP-004 (was HIGH; listed as claimed-fixed #4) | `http_cert_days` retained when HTTP skipped | **fixed** | `netcheck.js:484-504`: skip `checkHttp` unless lan+wan+dns; skipped → `http_cert_days` null. `monitor.js:425-430`: assign only if non-null; else **clear only when** lan+wan+dns (HTTP ran, no cert). LAN/WAN/DNS fail → keep last days. Test `monitor.test.js:330-338` retain on `makeResult(false,false)`; `netcheck.test.js:140-171` LAN-down skip (0 HTTP/HTTPS). |
| CV-PROCESS-001 | spec `CLEAR_OK` while mega/CV FAIL | **fixed** | Spec L5: **FAIL** until product fixes; do not stamp `CLEAR_OK` / “all findings implemented”. |

## Also checked

| item | verdict | evidence |
|------|---------|----------|
| `tracerouteHost` private-before-`execFile` | **fixed** (CV-APP-009) | `traceroute.js:69-88` `tracerouteTargetAllowed` then args/`execFile`. Public `8.8.8.8` / `2001:…` rejected; test `traceroute.test.js:56-67` override must not run. Hostnames non-IP fail `isPrivateOrLocalIp` (`port-scan.js:24-28`). |
| `_tick` isolation | **Hold** (product) | `monitor.js:8-9,364-405`: `_runProbe` / prune / adapter / `pingBurst` only. No lan-devices / lan-bridge / connections / snmp / sniffer / scan / `tracerouteHost`. Cert copy is `_applyProbe` only. `lan-security.test.js:24-56` greps spec module list + `require("./…")`. |

## Findings

| id | track | slug | severity | claim | evidence_path | fix_owner | status | reviewer |
|----|-------|------|----------|-------|---------------|-----------|--------|----------|
| CV-APP-001 | product | internet-downtime-tracker | BLOCKING | Honest 30d label = MIN(first probe, first outage) | `electron/main.js:529-545`; `electron/uptime-bar.js:12-26,96-114`; `web/app.js:1775-1788` | product:internet-downtime-tracker | **fixed** | grok46 |
| CV-APP-002 | product | internet-downtime-tracker | BLOCKING | Connections delta isolated; default `trackDelta` false | `electron/connections.js:471-517`; `electron/main.js:753-758`; `electron/lan-bridge.js:34-38,234-237` | product:internet-downtime-tracker | **fixed** | grok46 |
| CV-APP-003 | product | internet-downtime-tracker | BLOCKING | Devices-off blocks ping/traceroute before spawn | `electron/lan-devices.js:387-390,527-550`; `electron/main.js:869-873,911-912` | product:internet-downtime-tracker | **fixed** | grok46 |
| CV-PROCESS-001 | process | null | BLOCKING | Spec must not stamp CLEAR_OK while CV FAIL | `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md:5` | process | **fixed** | grok46 |
| CV-APP-004 | product | internet-downtime-tracker | HIGH | Cert days wiped when HTTP skipped | `electron/monitor.js:425-430`; `electron/netcheck.js:484-504` | product:internet-downtime-tracker | **fixed** | grok46 |
| CV-TEST-003 | app | internet-downtime-tracker | HIGH | `security.test.js` `_tick` module grep still omits `lan-devices` / `lan-bridge` / `traceroute` (`lan-security.test.js` has them) | `electron/test/security.test.js:289-301` vs `electron/test/lan-security.test.js:41-50` | app | open | grok46 |
| CV-APP-018 | product | internet-downtime-tracker | MEDIUM | `api:summary` / `api:export:report` still pass `monitor.state.started_at` into `db.summary()` (streak cap only; 30d **label** uses MIN) | `electron/main.js:535,658-660`; `electron/db.js:1223-1246` | product:internet-downtime-tracker | open | grok46 |
| CV-APP-009b | product | internet-downtime-tracker | MEDIUM | `tracerouteHost` fail-closes **all** IPv6 (`net.isIP===6`), including ULA `fd00::/8` / link-local (private-before-exec still holds) | `electron/traceroute.js:69-73`; `electron/test/traceroute.test.js:66-67` | product:internet-downtime-tracker | open | grok46 |
| CV-APP-019 | product | internet-downtime-tracker | LOW | `pct_label === null` → UI string `"null observed"` | `web/app.js:1786-1787` | product:internet-downtime-tracker | open | grok46 |
| CV-APP-012 | product | internet-downtime-tracker | LOW | Duplicated `formatHttpCertDays` | `web/app.js:230-242`; `electron/uptime-bar.js:42-54` | product:internet-downtime-tracker | open | grok46 |
| CV-APP-016 | product | internet-downtime-tracker | LOW | Uncapped in-flight traceroute IPC (private + devices-on still spawn N) | `electron/traceroute.js:76-98`; `electron/main.js:872-873` | product:internet-downtime-tracker | open | grok46 |

Incidental (not re-litigated as BLOCKING): CV-TEST-001/002/004/005 look landed (`netcheck.test.js` `probe`; `monitor.test.js` `_applyProbe`; `usage-db.test.js` retention/prune; `ui.test.js` `paintDevicesDisabled`). Adapter chips now show `rx_bytes`/`tx_bytes` (`web/app.js:3154-3164`).

## Disagreements

None (isolated). Split-brain `summary({ observeSince: started_at })` vs bar MIN: **not** escalated — `summary()` uses `observeSince` only for `uptime_streak_s`; Overview 30d `%` + `pct_label` do not.

## Art routing

None.

## Return contract

- **Path:** `docs/reviews/CV_peer-gaps-impl_2026-08-12_re_grok46.md`
- **Open BLOCKING:** 0
- **Gate:** `CLEAR_OK`
- **Art FAIL ids:** none
