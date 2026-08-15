# MEGA_REVIEW_20260812-peer-gaps — test-engineer

**Scope:** Peer-gaps info pass test coverage vs `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md`. Read-only. No product edits, no electron-builder, no relaunch.  
**Date:** 2026-08-12  
**CI:** `npm test` → **135/135 pass**, exit 0, 854ms  
**Verdict: FAIL (Do not ship — test lane)** — 0 Critical product-test lies; **5 High** spec-required / data-loss / probe-isolation holes remain.

TokenSave’d ~27720 tokens (context scout).

---

## Scorecard

| Dimension | /10 | Top risk |
|-----------|-----|----------|
| Testing quality | 6 | Spec-required `probe().http_cert_days` + incomplete `_tick` greps; no retention/prune data-loss lock |
| Probe isolation | 6 | Debounce / WAN-while-LAN / new IPC names grepped; `usage-bridge`/`connections`/`snmp-topology`/`sniffer`/`scan` not |
| Money / auth / data-loss | 5 | HTTP API token covered; **no** `probe_retention_days === 14` or `pruneProbes` vs outages |
| Honest metrics | 7 | 14d spark ≠ 30d and &lt;30d label exist; null `observeSince` → `"30d"` untested |
| UI contracts | 5 | Topology/`hist-type` tips locked; Devices/Connections/Usage headers + disabled warning not |

**Overall (tests):** 6/10

---

## Top fix first

Add one netcheck test that calls `probe()` (LAN-down → no HTTP/cert; HTTPS path → `http_cert_days` from the 3-tuple, single `checkHttp`), one monitor test that `_applyProbe` copies `http_cert_days` onto `snapshot()`, complete `monitor.js` isolation greps to the spec module list, and lock `DEFAULT_SETTINGS.probe_retention_days === 14` plus `pruneProbes` not deleting outages.

---

## Coverage matrix (named review targets)

| Target | Status | Evidence |
|--------|--------|----------|
| `checkHttp` 3-tuple / certDays | **Partial** | HTTP → `null` + HTTPS days: `electron/test/netcheck.test.js:85-135`. Timeout 3-tuple: `electron/test/export.test.js:50-57`. **No** `probe()` import; **no** request-count for “same response / no second fetch”. |
| Uptime-bar honest labels | **Partial** | 40d → `pct_label "30d"`, spark `"14d"`/`"24h"` not 30d: `electron/test/uptime-bar.test.js:13-32`. 10.2d → `"10d"`: `:35-44`. **No** null `observeSince`, `&lt;1d`, exactly 30d. |
| Connections delta / rDNS off-by-default | **Partial** | `snapshot()` with no `resolveDns` → 0 lookups: `electron/test/connections.test.js:196-220`. Cap/cache/timeout + delta new/dropped/state-changed 1 cycle: `:230-321`. **No** `getSettings().connections_resolve_dns === false`. |
| lan-devices category / hostname / enabled warning | **Partial** | OUI category, NBT then PTR + rate-limit, public IP skip, `devicesDisabledPayload` warning: `electron/test/lan-devices.test.js:343-446`. **No** `paintDevicesDisabled` / `data.warning` UI grep. |
| traceroute private-only | **Partial** | `tracerouteDevice({ip:"8.8.8.8"})` rejects: `lan-devices.test.js:460-462`. Parse + hop cap + not in netcheck: `traceroute.test.js:30-61`. **`tracerouteHost` itself has no private guard/test**; no private success path for `tracerouteDevice`. |
| SNMP LLDP mapping | **Covered** | sysName + IP → IP-keyed layout, no sysName edge id, stubs + counted warning, drop `8.8.8.8`, private seed fail: `electron/test/snmp-topology.test.js:29-118`. |
| `_tick` coupling greps | **Partial** | `monitor.js` grepped for `tracerouteHost` / `pingDevice` / new channels / `require("./lan-devices\|lan-bridge\|traceroute")`: `lan-security.test.js:34-41`, `security.test.js:284-288`. **Missing** spec list: usage-bridge, connections, snmp-topology, sniffer, scan. |
| `ui.test` data-tip headers | **Partial** | Only `hist-type`, `topo-nb`, `topo-conns`: `electron/test/ui.test.js:37,88-89`. New-pass `dev-cat`, `conn-service`, `stat-30d`, `http-cert`, Devices/Connections/Usage `<th data-tip>` unasserted. |

**Already green (do not re-ask):** debounce open-after-2 / close-on-success / WAN suppressed while LAN down — `electron/test/monitor.test.js:40-72`, `security.test.js:204-217`. HTTP API 401 without token — `lan-security.test.js:64-91`.

---

## Findings

### Critical

None. Debounce, WAN-while-LAN-down, and HTTP API token tests exist and were not weakened. `npm test` is 135/135.

### High

1. **`probe().http_cert_days` and layered HTTP skip untested** — `electron/test/netcheck.test.js` (no `probe` import); `electron/netcheck.js:486-504`.  
   **Impact:** Spec Wave-2 contract is `checkHttp` 3-tuple **and** `probe().http_cert_days`. A 2-tuple destructure in `probe()` silently zeros cert. LAN-down still calling `checkHttp` for cert would break probe isolation / extra `_tick` network. Neither regression fails CI.  
   **Fix:** One test: mock/stub LAN-down → `http_ok` false, `http_cert_days` null, `checkHttp` not invoked; HTTPS `httpUrl` → numeric `http_cert_days` from one request.

2. **Monitor never asserts `http_cert_days` copy into state/snapshot** — `electron/test/monitor.test.js:12-22,281-289`; `electron/monitor.js:222,243,425`.  
   **Impact:** Parent-owned snapshot field can drop without failing tests; Overview pills stay empty. `makeResult()` omits the field.  
   **Fix:** `_applyProbe`/`processResult` with `http_cert_days: 12` → `state` + `snapshot().http_cert_days === 12`; omit/`null` stays `null`. Do not change `_tick` control flow in the test double.

3. **`_tick` isolation greps miss the spec module list** — `electron/test/lan-security.test.js:24-41`; `electron/test/security.test.js:273-288`; spec “Grep / test contract”.  
   **Impact:** Adding `require("./snmp-topology")` / `./connections` / `./usage-bridge` / `./packet-sniffer` / `./port-scan` to `monitor.js` does not fail CI. `main.js` `monitor._tick[\s\S]{0,80|120}` never matches real coupling (`_tick` lives in `monitor.js`). New channel names **are** grepped (good).  
   **Fix:** Grep `monitor.js` (and keep channel names) for `usage-bridge`, `connections`, `snmp-topology`, `packet-sniffer`, `port-scan` / `tracerouteHost` (already). Drop or replace the adjacency regex on `main.js`.

4. **Data-loss: no lock that retention stays 14d or that prune cannot delete outages** — `electron/db.js:19,927-935`; no hits in `electron/test/**` for `probe_retention_days` / `pruneProbes`.  
   **Impact:** Spec: do not raise `probe_retention_days`; outages are **not** pruned (30d % is outage overlap). Bumping default to 30 rewrites the full sql.js DB every prune. `DELETE FROM outages` inside `pruneProbes` would wipe history and forge 0% downtime. Usage prune is tested (`usage-db.test.js` `pruneUsage`); probe/outage prune is not.  
   **Fix:** `assert.equal(DEFAULT_SETTINGS.probe_retention_days, 14)`; insert outage + old probe → `pruneProbes()` deletes probe only.

5. **Devices disabled UI warning untested** — payload: `lan-devices.test.js:411-416`; UI: `web/app.js:2257-2271`. `ui.test.js` only greps `refreshDevicesPanel` (`:73`).  
   **Impact:** Spec: show `data.warning` when `lan_devices_enabled=false` (Connections pattern). Backend can be correct while UI returns to “0 devices”.  
   **Fix:** `ui.test.js` grep `paintDevicesDisabled`, `data.warning`, `devicesDisabledBanner` / `state-error`.

### Medium

6. **`connections_resolve_dns` default false not asserted on settings** — `electron/db.js:27`; `electron/test/usage-db.test.js:103-108` defaults omit this key; `connections.test.js:197` only checks the constant name. Behavioral skip when `snapshot()` omits `resolveDns` is covered (`:218-220`). IPC uses `!!settings.connections_resolve_dns` (`electron/main.js:749`).  
   **Fix:** `getSettings().connections_resolve_dns === false` next to other safe defaults.

7. **Honest 30d: null / `&lt;1d` / 30.0d unlabeled** — `electron/uptime-bar.js:23-24` (`pctWindowLabel`: `days == null` → `"30d"`); tests only 10.2d and 40d (`uptime-bar.test.js:13-44`). UI fallback `observedWindowLabel` treats null as `"Observed"` (`web/app.js:1767-1772`) but `paintUptimeBar30` prefers `uptime_bar.pct_label` (`:1784-1788`).  
   **Fix:** Assert null/`firstProbeAt` path is not `"30d"` unless observed ≥ 30; add `&lt;1d` and 30.0d.

8. **`tracerouteHost` not private-only; no private success for `tracerouteDevice`** — `electron/traceroute.js:67-71` (no `isPrivateOrLocalIp`); reject is wrapper-only (`lan-devices.js:487-493`; test `:460-462`). A future IPC that calls `tracerouteHost` directly traces public IPs.  
   **Fix:** Reject public in `tracerouteHost` **or** test that every IPC path goes through `tracerouteDevice`; add private-IP success with mocked `tracert`.

9. **“No second HTTP from `_tick` / same-response cert” not locked** — HTTPS test (`netcheck.test.js:112-134`) does not count requests. `monitor.js` has no grep that `_tick`/`_runProbe` does not call `checkHttp` twice.  
   **Fix:** Count `https` requests in the cert fixture; grep `monitor.js` for `checkHttp`/`https.request` (expect none — probe owns it).

10. **Usage `wireChartTip` / new table `data-tip` headers not in `ui.test.js`** — `web/app.js:3444` (`wireChartTip` on usage trend); headers in `web/index.html` (`dev-cat`, `conn-service`, `stat-30d`, `http-cert`, usage/log/speed `<th data-tip>`). Only three header greps: `ui.test.js:37,88-89`. Tooltip pass can regress unlabeled columns.  
    **Fix:** Grep `wireChartTip(usageTrendChart`; assert `data-tip="dev-cat"`, `conn-service`, `stat-30d`, `http-cert`, and Devices/Connections/Usage `<th scope="col" … data-tip`.

11. **Weak `main.js` `_tick` adjacency assertions** — `lan-security.test.js:32-33`, `security.test.js:282-283`. False confidence; merge with High 3.

### Low

12. **`tracerouteDevice` private success + `MAX_HOPS` wiring untested** (public fail only).  
13. **`formatHttpCertDays` HTTPS `0` / bad URL** — HTTP `0` → `N/A (HTTP URL)` covered (`uptime-bar.test.js:50-52`).  
14. **IPv6 public traceroute** — `isPrivateOrLocalIp` allows `fc`/`fd`/`fe80` (`port-scan.js:29-31`); traceroute tests are IPv4-only.

### Info

- `npm test` script lists all 17 test files including new `uptime-bar` / `traceroute` / `snmp-topology` (`package.json:12`).  
- LLDP tests correctly use sysName `to` vs IP-keyed layout (`snmp-topology.test.js:16-27,66-70`).  
- `fail_reason` absence locked (`uptime-bar.test.js:48-70`).

---

## Missing money / auth / data-loss / probe-isolation (explicit)

| Class | Present | Missing (this pass) |
|-------|---------|---------------------|
| **Money / billing honesty** | Usage cap/alert tests (`usage-control.test.js`); honest 14d spark ≠ 30d | Retention default 14; 30d label when `observeSince` null |
| **Auth** | HTTP API Bearer 401/200 (`lan-security.test.js:64-91`); helper token-file (`usage-control.test.js`) | `connections_resolve_dns` default false on `getSettings()` (privacy) |
| **Data-loss** | `encodeSnapshotJson` size; persist-failure queries (`security.test.js`); usage `pruneUsage` | **`pruneProbes` vs `outages`**; probe retention bump |
| **Probe isolation** | Debounce; WAN while LAN down; DNS/HTTP need lower layers (`monitor.test.js:84`); overlapping `_tick`; `tracerouteHost`/`pingDevice`/new channels not in `monitor.js`; `tracerouteDevice` public reject; SNMP public seed | **`probe()` not called from tests**; incomplete module greps; second HTTP; `tracerouteHost` public |

---

## Verdict

**FAIL / Do not ship (test lane).** Product units for the eight named areas mostly exist and 135 tests pass, but spec-required `probe().http_cert_days`, monitor cert copy, full `_tick` module greps, retention/prune data-loss, and Devices disabled UI are not gated. Add Highs 1–5 before treating tests as a merge gate.

Blockers: High 1–5. Medium 6–11 should land in the same test pass (still ≤10 new tests if grouped).

---

## Fable-judge claims

| Claim | Status | Evidence |
|-------|--------|----------|
| `npm test` 135 pass, exit 0 | **verified** | Ran `npm test` in repo root; `tests 135` / `pass 135` / `fail 0` / exit 0 |
| Debounce open-after-N / close-on-success | **verified** | `electron/test/monitor.test.js:40-58` present and passing |
| WAN suppressed while LAN down | **verified** | `monitor.test.js:60-72`; `security.test.js:204-217` |
| Spec `probe().http_cert_days` tested | **failed** | `grep probe(` in `electron/test` — no `probe()` call; `netcheck.test.js` does not import `probe` |
| Spec monitor.js greps cover lan-devices / lan-bridge / usage-bridge / connections / snmp-topology / sniffer / scan / traceroute | **failed** | Only traceroute/lan-devices/lan-bridge/new channels; not usage-bridge/connections/snmp-topology/sniffer/scan |
| `probe_retention_days` default 14 locked | **failed** | No test mentions `probe_retention_days` |
| `pruneProbes` does not delete outages | **failed** | `pruneProbes` untested; implementation deletes `probes` only (`db.js:933`) — **assumed** in product, **unverified** by tests |
| rDNS off unless toggle | **verified** (function default) / **assumed** (settings default) | `connections.test.js:218-220`; settings default untested |
| LLDP sysName vs IP layout | **verified** | `snmp-topology.test.js:29-72` |
| ui.test locks new data-tip headers | **failed** | Only `hist-type`, `topo-nb`, `topo-conns` |
| Packaged rebuild / relaunch | **n/a** | Explicitly out of scope |
| Graphify blast radius | **assumed** | Used tokensave_context; `graphify-out/graph.json` not required for this lane |

MEGA_REVIEW_STATUS: FAIL

**Counts:** Critical 0 · High 5 · Medium 6 · Low 3 · Info 0
