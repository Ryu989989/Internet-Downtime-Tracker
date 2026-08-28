# MEGA_REVIEW_20260828-wifi-drop-diagnostics — test-engineer

**Scope:** Wi-Fi drop diagnostics test coverage vs `docs/superpowers/specs/2026-08-28-wifi-drop-diagnostics.md`. Diff `5271d43..be74a4e` (`electron/test`, `package.json`, new `wifi-chronicle` / `wifi-nearby` tests). Read-only. No product edits, no git mutation.
**Date:** 2026-08-28
**CI:** `npm test` → **267/269 pass**, 2 fail, exit 0 from the runner still reports fail count 2. Failures are the **pre-existing Linux-runner** cases (not this diff): `electron/test/connections.test.js:251` Win32_Service CIM (`0 !== 1`); `electron/test/speedtest.test.js:105` Windows path-traversal (`false !== true`). This-pass files (chronicle/nearby/alerts/system-logs/usage-db/router-poll/ui/lan-security/monitor/cross-platform/security/overview-wifi) **119/119 pass**.
**Verdict: FAIL (Do not ship — test lane)** — 0 Critical product-test lies; **5 High** spec-required honesty / pipeline / anti-feature holes remain.

---

## Scorecard

| Dimension | /10 | Top risk |
|-----------|-----|----------|
| Testing quality | 6 | Parsers, greps, prune, host_nic timer existence are locked; verdict *priority* and live wiring are not |
| Probe isolation | 8 | `monitor.js` greps for Get-WinEvent / system-logs / wifi-chronicle / wifi-nearby / iw scan / show networks / wlanreport; `lan-bridge` only as `require("./lan-bridge")` |
| Money / auth / data-loss | 8 | `probe_retention_days === 14` + `pruneProbes` deletes `wifi_events` not `outages` |
| Honest metrics | 8 | `% → rssi: null`, Overview `rssiToPct` grepped, nearby netsh does not invent dBm |
| UI contracts | 5 | Overview chips + Scan disclaimer grepped; History badge (`wifiVerdictBadgeHtml`) and `scanNearby` payload are not |
| Verdict / chronicle pipeline | 4 | Pure `correlateVerdict` happy paths exist; ingest, `liveWifiVerdict`, snapshot merge, competing priority untested |

**Overall (tests):** 6/10

---

## Top fix first

Add one `correlateVerdict` matrix that actually competes (sleep beats ISP and this-PC-Wi-Fi; `routerWanOk===false` beats disconnect; unknown despite disconnect when ISP-up is unproven), one lan-bridge test for `onOutageEvent` ingest debounce + `wifiVerdictForOutage`/`liveWifiVerdict`, and lock `OUTAGE_TYPES` / `openOutage("wifi")` plus History badge + host-nic `checkWifiAlerts` greps. Keep it to ≤10 tests (grouped below).

---

## Coverage matrix (named review targets)

| Target | Status | Evidence |
|--------|--------|----------|
| `wifi-alerts.test.js` in `npm test` | **Covered** | `package.json:12` lists `electron/test/wifi-alerts.test.js` (and chronicle + nearby) |
| Grep gates on `monitor.js` | **Partial** | `lan-security.test.js:43-49`: Get-WinEvent, system-logs, wifi-chronicle, wifi-nearby, iw scan, show networks, wlanreport. `lan-bridge` only via `require("./lan-bridge")` (`:50-61`), **not** substring `lan-bridge`. `wifi-nearby.test.js:86-89` repeats nearby/`iw scan`/`show networks`. `security.test.js:302-304` is a shorter copy (no system-logs / iw scan / show networks / wlanreport). Product `monitor.js` currently matches none of the tokens |
| No `%→dBm` / `rssiToPct` in Overview paint | **Covered** | `ui.test.js:83-86` `paintAdapterLine` slice: `finiteOrNull(a.rssi)`, no `rssiToPct`; `:72-73` `"adapter-signal-nodbm"` / `never estimated from %`; `:97` whole `app.js` `doesNotMatch /rssiToPct/`. `cross-platform.test.js:252-273` Signal `85%` → `rssi: null` |
| No `type === "wifi"` outage insert | **Missing** | No test greps `OUTAGE_TYPES`, `openOutage("wifi")`, or `type === "wifi"` insert. Live: `monitor.js:17` and `db.js:191` are `lan\|wan\|dns\|http` only; `db.js:1466-1468` throws on invalid type — **assumed**, not gated |
| `parseNetsh` extra fields + rssi null on `%` | **Covered** | `cross-platform.test.js:183-324`: state/radio/auth/cipher, disconnected, explicit dBm vs `%`, prefer connected block, `emptyAdapter` / `fillWifiGaps`, `getActiveAdapter` copies fields |
| Roam coalesce 8003+8001 | **Partial** | Happy path only: `wifi-chronicle.test.js:75-98` (different BSSID, 8s). No same-BSSID / `>15s` / reverse order |
| `correlateVerdict` priority + unknown copy | **Partial** | Four cases `wifi-chronicle.test.js:101-153`. Unknown blob matches `/unproven/i` and `/router poll\|other devices/i`. Sleep / ISP cases **do not compete** with other codes (see High 1) |
| `insertWifiEvent` dedup | **Covered** | `usage-db.test.js:181-211`: empty/null kind skip; same `at`/`kind`/`source`/`event_id` within 0.4s no-op; different kind inserts |
| Prune `wifi_events` not outages | **Covered** | `usage-db.test.js:81-118`: retention 14; old wifi_events/samples gone; fresh kept; outage row survives; `pruneProbes` source greps `DELETE FROM wifi_events` and `doesNotMatch /DELETE FROM outages/` |
| `HOST_NIC_INTERVAL_MS` | **Covered** | `router-poll.test.js:230` `=== 30000`; start/stop/reset/shutdown; `applyIntegrationSettings` starts host NIC when router poll off (`:249-256`) |
| `persistHostNic` not in `pollRouterOnce` | **Covered** | `router-poll.test.js:210-227` poll with wifi adapter → 0 host_nic samples; persist path still works `:183-208` |
| `liveAdapterSnapshot` in incident | **Partial** | `monitor.test.js:281-317` incident has ssid/bssid/band/channel/rssi/tx/rx/signal; **not** mac/description (spec list). `adapterRefreshEveryN` wifi→`QUALITY_EVERY_N`, else 30 |
| Nearby IPC + disclaimer | **Partial** | IPC: `wifi-nearby.test.js:92-97`, `lan-security.test.js:19,31`. UI: `ui.test.js:91-97` `nearbyWifiRun` + `not a site survey`. **No** `scanNearby()` call; `DISCLAIMER` / hidden-SSID sentence unasserted on payload |
| UI greps chips / badge / nearby | **Partial** | Chips: `ui.test.js:43-70` BSSID/rate/state/verdict ids + tips. Nearby: `:91-97`. Badge: **no** `wifiVerdictBadgeHtml` / `wifi-verdict-badge` |
| Host-nic roam insert | **Covered** (conditional) | `router-poll.test.js:258-298` two `persistHostNic` different BSSID → one `host_nic` roam. Wrapped in `existsSync(wifi-chronicle.js) ? it : it.skip` — runs on this tree, would **skip** if the module file vanished |

**Locked skips (not findings):** heatmaps, monitor mode, Npcap, fake SNR, `wlanreport` HTML, Native WLAN helper, WAN-while-LAN-down, roaming-aggressiveness writes, widget SSID, CoreWLAN/`wdutil`, retention bump. `%→dBm` and `wifi` outage type are product skips **and** grep gates — missing tests for those anti-features **are** findings.

**Already green (do not re-ask):** `wifi-alerts.test.js` on the npm script; netsh extra fields + `% → rssi null`; insertWifiEvent empty-kind + 1s dedup; prune wifi_events vs outages; HOST_NIC 30s + pollRouterOnce does not persist host_nic; monitor isolation greps except `lan-bridge` substring; Overview chip ids; nearby IPC channel names.

---

## Findings

### Critical

None. Debounce / WAN-while-LAN-down tests were not weakened. This-pass files pass. The two `npm test` failures are pre-existing and out of lane.

### High

1. **`correlateVerdict` priority is not actually tested** — `electron/test/wifi-chronicle.test.js:101-153`; spec Module APIs / `electron/wifi-chronicle.js:227-272`.
   **Impact:** Sleep case has only `{kind:"sleep"}` (no disconnect/roam) and `routerWanOk: true` / no `wanOutage`, so ISP and `this_pc_wifi` would not fire anyway — it does not prove sleep wins. ISP case sets **both** `wanOutage` (no LAN) **and** `routerWanOk: false`; spec is OR (`wanOutage` with LAN up **or** `routerWanOk===false`). `this_pc_wifi` is only disconnect + `routerWanOk: true` — not roam, not `peersOnlineDuring===true`. Unknown has **no** WLAN events; a regression that labels LAN+disconnect as `this_pc_wifi` without router/peers proof still passes. Mislabeling ISP vs this-PC-Wi-Fi is the honesty contract for this pass.
   **Fix:** One matrix test: (a) sleep + disconnect + `routerWanOk: false` + `wanOutage` → `sleep`; (b) LAN + disconnect + `routerWanOk: false` → `isp` not `this_pc_wifi`; (c) `wanOutage` + LAN up + `routerWanOk: null` → `isp`; (d) LAN + roam + `peersOnlineDuring: true` + `routerWanOk: null` → `this_pc_wifi`; (e) LAN + disconnect + both null → `unknown` with ISP-up unproven copy.

2. **WLAN ingest path untested** — no hits in `electron/test/**` for `ingestWlanChronicle` / `onOutageEvent`; impl `electron/lan-bridge.js:1422-1512`.
   **Impact:** Spec: `onOutageEvent` when `kind===outage_open` and `type==="lan"` ingest window `[started_at-60, now]`, debounce 10s, `scanWindowsLogs` → `eventsToChronicle` → `insertWifiEvent`. Chronicle unit tests can be green while Windows events never land in `wifi_events`. Debounce and “WAN open does not ingest” can invert without CI.
   **Fix:** Call `onOutageEvent("outage_open", {type:"lan", started_at})` then `ingestWlanChronicle()` → `{skipped:true}`; WAN open then ingest → not skipped. Optionally stub `scanWindowsLogs` and assert inserted kinds.

3. **Live verdict never attached in tests** — no hits for `liveWifiVerdict` / `wifiVerdictForOutage` / `mergeOutageSnapshot`; impl `electron/lan-bridge.js:1378-1420`, `electron/main.js:190-191,543-553,897-904`.
   **Impact:** Spec: `status.wifi_verdict` from `liveWifiVerdict()`; History stores `wifi_verdict` on `snapshot_json` at open after ingest. UI greps `wifi_verdict` (`ui.test.js:81`) so Overview/History strings can remain while `main.js` drops `liveWifiVerdict` or merge. `routerWanOkForVerdict` / `peersOnlineDuring` (exclude this-host MAC) untested.
   **Fix:** Fixture: open LAN outage + `insertWifiEvent` disconnect + router health `wan_ok: true` → `wifiVerdictForOutage` / `liveWifiVerdict` → `this_pc_wifi`; grep `main.js` for `liveWifiVerdict` and `mergeOutageSnapshot`.

4. **No lock that outage domains exclude `wifi`** — spec grep gate “No `type === "wifi"` outage insert”; `electron/monitor.js:17,678`; `electron/db.js:191,1464-1468`. Zero test matches for `OUTAGE_TYPES` / `openOutage("wifi")`.
   **Impact:** Adding `"wifi"` to either `OUTAGE_TYPES` set (or inserting that type) is the explicit inversion this pass forbids. History/uptime would treat Wi-Fi as a fifth domain. CI would stay green.
   **Fix:** `assert.deepEqual([...OUTAGE_TYPES], ["lan","wan","dns","http"])` (or Set equality) in monitor + db; `assert.throws(() => db.openOutage("wifi"))`; `doesNotMatch` monitor `_updateLayer` / `openOutage` path for `"wifi"`.

5. **Host-NIC timer does not assert `checkWifiAlerts`** — `electron/lan-bridge.js:1076-1083` (`persistHostNic` then `checkWifiAlerts`); tests `router-poll.test.js:229-256` only check `running` / interval. `wifi-alerts.test.js:183-191` fires alerts via `pollRouterOnce`, not the always-on host timer.
   **Impact:** Spec: timer tick always samples **and** evaluates alerts so RSSI alerts work with `router_poll_enabled: false`. Removing `.then(() => checkWifiAlerts(now))` leaves host_nic samples (tested) but silent alerts when router poll is off — the reason the timer is always-on.
   **Fix:** Grep `startHostNicPoll` body for `persistHostNic` then `checkWifiAlerts`, or drive one timer tick with a weak host_nic sample and `router_poll_enabled: false` and assert a fire/digest.

### Medium

6. **`detectHostNicRoam` SSID contract incomplete** — `wifi-chronicle.test.js:50-72`; spec: roam iff both BSSIDs present, normalized unequal, **SSIDs equal or either missing**. Same-SSID roam + unchanged BSSID are covered. Missing SSID still roaming, and **different SSID → null** (network change, not roam), are not. `wifi-chronicle.js:144-166`.

7. **Coalesce 8003+8001 negative cases missing** — only different BSSID within 15s (`wifi-chronicle.test.js:75-98`; `wifi-chronicle.js:168-207`). Same BSSID reconnect, `dt > 15`, or 8001-then-8003 would still pass today if someone coalesced any pair.

8. **History badge untested** — spec Wave 1 “History badge”; UI `web/app.js:1450-1456,1564` `wifiVerdictBadgeHtml`. `ui.test.js` greps Overview `wifiVerdictChip` (`:53,67,79`) and `wifi_verdict` (`:81`) but never `wifiVerdictBadgeHtml` / `wifi-verdict-badge` / `outageWifiVerdict`. Dropping the History control keeps Overview chips green.

9. **`scanNearby` behavior and non-tick isolation are monitor-only** — parsers + IPC grep (`wifi-nearby.test.js:51-97`). `scanNearby` (`wifi-nearby.js:235-261`) has `setRunCmdForTest` but no test; payload `DISCLAIMER` (hidden SSIDs / not a survey) unasserted. `lan-bridge.js` is not grepped for `scanNearby` / `wifi-nearby` / `iw scan` / `show networks` — a 30s host-nic scan would violate “user-triggered / not on `_tick`” without failing CI.

10. **Incident snapshot omits spec `mac` / `description`** — `monitor.test.js:281-317` sets `mac` and `state` on live adapter but does not assert `incident.adapter.mac` / `.description` (or state/auth/cipher). Spec incident list: ssid/bssid/band/channel/rssi/signal/tx_mbps/rx_mbps/**mac/description**. Reverting those two keys would not fail.

11. **`wifi-chronicle.js` purity untested** — spec: pure, no I/O, no `monitor`. File has zero `require(` (good). No grep that it does not `require("./monitor")` / `fs` / `child_process`. A later I/O import would not fail CI.

### Low

12. **Spec grep token `lan-bridge` is require-only** — `lan-security.test.js:50-61`. Coupling via `require("./lan-bridge")` is locked; a non-require mention would not fail. `security.test.js:302-320` omits system-logs / iw scan / show networks / wlanreport (covered in lan-security).

13. **`hasWifiChronicle` skip hides a deleted module** — `router-poll.test.js:258-259`. Not a spec locked skip. If `wifi-chronicle.js` is removed, roam integration **skips** instead of failing; ingest/verdict already have no tests (High 2–3).

14. **`classifyWlanEvent` only 8003 + 42** — fail `11002/11006`, connect `8001/8000/8002`, roam `12013`, resume `107` live in `wifi-chronicle.js:3-7,98-106` but are only asserted on `system-logs.classifyEvent` (`system-logs.test.js:25-36`). The two classifiers can drift (12013 is connect in system-logs, roam-if-bssid in chronicle — intentional, still untested on the chronicle side).

15. **Host-NIC `unref` untested** — `lan-bridge.js:1091`. Spec asks `unref` the timer. Low process-lifetime leak if dropped.

### Info

- `package.json:12` now includes `wifi-alerts.test.js`, `wifi-chronicle.test.js`, `wifi-nearby.test.js`.
- Known Linux failures (connections CIM, speedtest path traversal) reproduced; **not** caused by this diff.
- `eventsToGaps` correctly filters to disconnect/connect only (`system-logs.js:146-149`); fail/sleep gap tests exist (`system-logs.test.js:115-135`).
- UniFi/Omada spark allowlist grepped (`ui.test.js:87-88` `WIFI_ROUTER_SRC`).

---

## Missing money / auth / data-loss / probe-isolation (explicit)

| Class | Present | Missing (this pass) |
|-------|---------|---------------------|
| **Money / billing honesty** | Retention 14 + prune vs outages (`usage-db.test.js:81-118`) | — |
| **Auth / privilege honesty** | Nearby UI “not a site survey”; system-logs non-Windows warning | `scanNearby` warning when unelevated / empty BSS; Event Log empty → honest warning on ingest |
| **Data-loss** | `wifi_events` pruned with probes; outages kept | — |
| **Probe isolation** | monitor.js greps (almost full spec list); nearby not in `_tick`; host_nic not in `pollRouterOnce` | ingest not on `_tick` (untested); nearby not on host-nic timer (untested); `lan-bridge` substring |
| **Diagnostic honesty** | `% → rssi null`; unknown evidence regex; sleep≠gap | Competing verdict priority; unknown despite disconnect without ISP-up proof; no `wifi` outage type |

---

## Suggested tests (≤10)

1. **`correlateVerdict` competing matrix** (High 1) — sleep wins vs ISP+this_pc_wifi; ISP OR branches; roam+peers; unknown despite disconnect.
2. **`detectHostNicRoam` SSID edges** (Medium 6) — missing SSID still roam; different SSID → null. Fold into chronicle file.
3. **Coalesce negatives** (Medium 7) — same BSSID and `dt=16` stay disconnect+connect. Same file as 1–2.
4. **`onOutageEvent` ingest debounce** (High 2) — LAN open skips second ingest; WAN open does not set debounce.
5. **`wifiVerdictForOutage` / `liveWifiVerdict`** (High 3) — LAN + disconnect + `wan_ok` true → this_pc_wifi; grep main `liveWifiVerdict` + `mergeOutageSnapshot`.
6. **No `wifi` outage type** (High 4) — db+monitor `OUTAGE_TYPES`; `openOutage("wifi")` throws.
7. **Host-NIC tick alerts + nearby not in lan-bridge** (High 5 + Medium 9) — grep `startHostNicPoll` for `checkWifiAlerts`; `lan-bridge.js` `doesNotMatch` `scanNearby`/`wifi-nearby`/`iw scan`/`show networks`.
8. **History badge** (Medium 8) — `ui.test.js` grep `wifiVerdictBadgeHtml` and `wifi-verdict-badge`.
9. **`scanNearby` disclaimer** (Medium 9) — stub `setRunCmdForTest`, assert `disclaimer` matches hidden SSID / not a survey, netsh `%` → `rssi: null`.
10. **Incident mac/description** (Medium 10) — extend existing `monitor.test.js` liveAdapterSnapshot case; optionally grep `wifi-chronicle.js` has no `require(`.

Tests 1–3 are one file; 4–5+7 one lan-bridge file; 6/8/9/10 are small greps or extensions. Still ≤10 `it()`s if grouped.

---

## Verdict

**FAIL / Do not ship (test lane).** Parser, grep-gate, prune, host_nic interval, and Overview-chip tests are real and passing. They do not gate the live chronicle ingest, status/history verdict attachment, competing verdict priority, or the “no wifi outage type” anti-feature. Those are the regressions this pass is supposed to prevent.

Blockers: High 1–5. Medium 6–11 should land in the same test pass (use the ≤10 list).

**Ready to merge:** No

---

## Fable-judge claims

| Claim | Status | Evidence |
|-------|--------|----------|
| `wifi-alerts.test.js` is in `npm test` | **verified** | `package.json:12` |
| `npm test` this-pass files pass | **verified** | 119/119 on the listed test files |
| Full `npm test` 267 pass / 2 fail | **verified** | connections CIM + speedtest path traversal; pre-existing |
| monitor.js grep gates complete | **failed** (partial) | Missing substring `lan-bridge`; other tokens locked in `lan-security.test.js:43-49` |
| No `%→dBm` / `rssiToPct` in Overview paint | **verified** | `ui.test.js:83-86,97` |
| No `type === "wifi"` outage insert | **failed** | No test; impl currently lan/wan/dns/http only (`monitor.js:17`, `db.js:191`) — assumed |
| parseNetsh extra fields + rssi null on `%` | **verified** | `cross-platform.test.js:224-273` |
| Roam coalesce 8003+8001 different BSSID ≤15s | **verified** (happy path) | `wifi-chronicle.test.js:75-98` |
| `correlateVerdict` priority + unknown copy | **failed** (partial) | Unknown copy verified `:139-152`; priority competition not |
| `insertWifiEvent` dedup | **verified** | `usage-db.test.js:181-211` |
| Prune `wifi_events` not outages | **verified** | `usage-db.test.js:81-118` |
| `HOST_NIC_INTERVAL_MS === 30000` | **verified** | `router-poll.test.js:230` |
| `persistHostNic` not in `pollRouterOnce` | **verified** | `router-poll.test.js:210-227` |
| `liveAdapterSnapshot` full field list | **failed** (partial) | radio fields yes; mac/description no — `monitor.test.js:303-313` |
| Nearby IPC + disclaimer | **failed** (partial) | IPC + UI “not a site survey”; `scanNearby`/`DISCLAIMER` untested |
| UI chips / badge / nearby | **failed** (partial) | chips+nearby yes; History badge no |
| ingest / liveWifiVerdict wiring | **failed** | no test references |
| Packaged rebuild / relaunch | **n/a** | Out of scope |
| Locked spec skips | **n/a** | Not filed |

MEGA_REVIEW_STATUS: FAIL

**Counts:** Critical 0 · High 5 · Medium 6 · Low 4 · Info 0
