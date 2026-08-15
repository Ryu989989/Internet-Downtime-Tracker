# Cross-verify: peer-gaps POST-IMPL re-CV (merged)

**Date:** 2026-08-12  
**Claims attacked:** prior FAIL merge `docs/reviews/CV_peer-gaps-impl_2026-08-12.md` (4 open BLOCKING) vs live code. Spec `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md`.  
**Reviewers:** grok46 (`cursor-grok-4.6-xhigh`) · grok45 (`cursor-grok-4.5-high`) · composer25 (`composer-2.5`)  
**Inputs:** `docs/reviews/CV_peer-gaps-impl_2026-08-12_re_grok46.md` · `_re_grok45.md` · `_re_composer25.md`  
**Isolated re-CV (at merge, pre-clock-fix):** grok45 **CLEAR_FORBIDDEN** (1 BLOCKING); grok46 + composer25 CLEAR_OK. Union then **FAIL**. grok45 did **not** originally pass.  
**Open BLOCKING (live):** 0  
**Gate:** **CLEAR_OK**  
**Tests:** `npm test` 142/142  
**EXE:** `dist/win-unpacked/Internet Downtime Tracker.exe` — not launched this stamp (docs-only).

Union: worst severity wins; any reviewer’s BLOCKING stays open until fixed. Isolated grok46+composer25 `CLEAR_OK` could not veto grok45 BLOCKING at merge. Sibling then fixed the clock; live union is **CLEAR_OK**.

## Per-reviewer counts (isolated, frozen at merge)

| reviewer | BLOCKING | HIGH | MEDIUM | LOW | Gate |
|----------|----------|------|--------|-----|------|
| grok46 | 0 | 1 | 2 | 3 | CLEAR_OK |
| grok45 | 1 | 0 | 1 | 0 | CLEAR_FORBIDDEN |
| composer25 | 0 | 0 | 1 | 0 | CLEAR_OK |

Do not rewrite grok45 as CLEAR_OK. Their BLOCKING (`CV-APP-001`, `db.summary` still `monitor.state.started_at`) was correct against the tree they reviewed.

## Merged counts (union, live)

| | BLOCKING | HIGH | MEDIUM | LOW |
|--|----------|------|--------|-----|
| at merge | **1** | 1 | 1 | 3 |
| live | **0** | **0** | **0** | 3 |

## Claimed-fixed BLOCKING (live)

| prior id | claim | live | note |
|----------|-------|------|------|
| CV-APP-001 | `observeSince` = MIN(first probe, first outage), not session `started_at` | **fixed (after merge)** | `historyObservationClocks()` → `db.summary` on `api:summary` and `api:export:report`. grok45 isolated record stays FAIL. |
| CV-APP-002 | `snapshot` `trackDelta` default false; IPC passes true | **fixed** | all three |
| CV-APP-003 | `lan_devices_enabled=false` blocks ping/traceroute before spawn | **fixed** | all three |
| CV-APP-004 | `http_cert_days` retained when HTTP skipped | **fixed** | all three |
| CV-PROCESS-001 | spec must not stamp CLEAR_OK while CV FAIL | **fixed** | all three |
| traceroute private-before-exec | `tracerouteHost` reject before `execFile` | **fixed** | all three (was MEDIUM) |
| `_tick` isolation | no lan/connections/snmp/sniffer/traceroute in `_tick` | **Hold/PASS** | product; greps aligned |

## Findings (open)

| id | track | slug | severity | claim | evidence_path | fix_owner | status | reviewer | sources |
|----|-------|------|----------|-------|---------------|-----------|--------|----------|---------|
| CV-APP-019 | product | internet-downtime-tracker | LOW | `pct_label === null` → UI string `"null observed"` | `web/app.js:1786-1787` | product:internet-downtime-tracker | open | grok46 | grok46 CV-APP-019 |
| CV-APP-012 | product | internet-downtime-tracker | LOW | Duplicated `formatHttpCertDays` | `web/app.js:230-242`; `electron/uptime-bar.js:42-54` | product:internet-downtime-tracker | open | grok46 | grok46 CV-APP-012 |
| CV-APP-016 | product | internet-downtime-tracker | LOW | Uncapped in-flight traceroute IPC (private + devices-on still spawn N) | `electron/traceroute.js:76-98`; `electron/main.js:872-873` | product:internet-downtime-tracker | open | grok46 | grok46 CV-APP-016 |

LOW optional. Do not re-open CV-APP-002/003/004/PROCESS-001.

## Closed findings

| id | sev (at merge) | closed as | evidence |
|----|----------------|-----------|----------|
| CV-APP-001 | BLOCKING (grok45) | **fixed after merge** | `electron/main.js:526-536` `historyObservationClocks()` = `observationStart({ firstProbeAt, firstOutageAt })`. `api:summary` `543-544`: `db.summary(null, { observeSince })`. `api:export:report` `667-668`: `db.summary(now, { observeSince })`. Neither passes `monitor.state.started_at`. `electron/test/security.test.js:305-306` `doesNotMatch` `observeSince: monitor.state.started_at`; `match` `db.summary(null, { observeSince })`. Folded grok45 CV-APP-001b (export MEDIUM), grok46 CV-APP-018, composer25 CV-APP-001-R. |
| CV-TEST-003 | HIGH (grok46) | **aligned** | `security.test.js:289-292` `_tick` grep includes `lan-devices` / `lan-bridge` / `traceroute` (same as `lan-security.test.js:41-44`). |
| CV-APP-009b | MEDIUM (grok46) | **intended fail-closed** | `traceroute.js:69-73` `net.isIP===6` → deny (ULA `fd00::/8` / link-local included). `traceroute.test.js:66-67` `fd12:3456:789a::1` `ok===false`. Not a defect. |
| CV-APP-002 | BLOCKING | fixed (pre-re-CV) | all three |
| CV-APP-003 | BLOCKING | fixed (pre-re-CV) | all three |
| CV-APP-004 | BLOCKING | fixed (pre-re-CV) | all three |
| CV-PROCESS-001 | BLOCKING | fixed (pre-re-CV) | all three |
| traceroute private-before-exec | MEDIUM | fixed (pre-re-CV) | all three |

### CV-APP-001 — closed after merge (was BLOCKING)

**isolated grok45 (do not restamp as pass):** `api:summary` computed MIN then ignored it (`observeSince: monitor.state.started_at`); export same. Union FAIL.

**live:** shared clock helper; both IPC paths pass it into `db.summary`:

```
electron/main.js:526-536  historyObservationClocks() → observeSince: observationStart({ firstProbeAt, firstOutageAt })
electron/main.js:543-544  api:summary → db.summary(null, { observeSince })
electron/main.js:667-668  api:export:report → db.summary(now, { observeSince })
```

`db.js:1223-1224` documents session `started_at` is not history. `security.test.js:305-306` regression-locks the old call shape.

## Disagreements

| Fact | grok46 | grok45 | composer25 | Merge at review | Live |
|------|--------|--------|------------|-----------------|------|
| `db.summary` still `started_at` | MEDIUM (CV-APP-018); 30d **label** fixed → CLEAR_OK | **BLOCKING** (CV-APP-001); export MEDIUM (001b) | MEDIUM (CV-APP-001-R); label contract held → CLEAR_OK | **BLOCKING** (union; grok45 wins) | **fixed after merge** — grok45 isolated FAIL stands |
| Export report `started_at` | same MEDIUM as summary | MEDIUM | (absorbed in 001-R) | folded into **CV-APP-001** | same helper |
| `security.test.js` `_tick` grep | HIGH | not re-audited | not re-audited | **HIGH** | **aligned** |
| IPv6 traceroute fail-close | MEDIUM | not raised | not raised | **MEDIUM** | **intended** (ULA fail-closed) |
| Prior 4 BLOCKING minus clock | fixed | 002/003/PROCESS fixed; 001 open | all four “fixed” | 002/003/004/PROCESS **fixed**; 001 **open** | 001 **fixed after merge** |

## Art routing

None.

## Return contract

- **Merge path:** `docs/reviews/CV_peer-gaps-impl_2026-08-12_re.md`
- **Open BLOCKING:** 0
- **Gate:** `CLEAR_OK`
- **Counts (live):** BLOCKING 0 · HIGH 0 · MEDIUM 0 · LOW 3
- **grok45 isolated:** CLEAR_FORBIDDEN / CV-APP-001 BLOCKING — valid then; closed after merge, not rewritten as original pass
- **Live clock:** `historyObservationClocks()` MIN(first probe, first outage) → `api:summary` + `api:export:report` `db.summary({ observeSince })`
