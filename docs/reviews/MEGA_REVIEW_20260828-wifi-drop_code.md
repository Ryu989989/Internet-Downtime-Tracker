# MEGA_REVIEW 20260828 wifi-drop — code-reviewer

**Range:** `5271d43030f6bcbef9478cad8fc60b19fad4a7b3` → `be74a4e6cd6038133fe349bba22176d2b57647ca`  
**Spec:** `docs/superpowers/specs/2026-08-28-wifi-drop-diagnostics.md` (locked). Skip items not filed.  
**Checkout:** read-only. Diff inspected via `git diff` / `git show`. Working tree not mutated.

## Verdict

**FAIL**

## Scorecard (/10)

| Axis | Score | Notes |
|------|------:|-------|
| Plan alignment | 8 | Wave 1+2 surface area is present; two wiring bugs invert spec intent |
| Architecture / parent coupling | 9 | `monitor.js` stays clean; chronicle/nearby/system-logs stay off `_tick` |
| Edge cases | 5 | Host-nic timer shares router RF cache; History recomputes live |
| Honest labels | 7 | `%` vs dBm paint is careful; netsh `Signal … dBm` still fills `%` |
| Tests | 6 | Parsers/DB/isolation strong; no test for host-nic `checkWifiAlerts` or History fallback |
| **Overall** | **6** | Merge blocked on the two Highs |

**Top fix:** Stop the always-on host-nic timer from treating leftover `lastWifiByMac` router rows as fresh RF samples (`electron/lan-bridge.js` `startHostNicPoll` → `checkWifiAlerts`).

## Strengths

- Chronicle-first split is real: `electron/wifi-chronicle.js` is pure; `electron/wifi-nearby.js` is on-demand; `electron/monitor.js` still only `require`s `netcheck` / copy helpers. Grep gates hold (no `system-logs`, `wifi-chronicle`, `wifi-nearby`, `lan-bridge`, `Get-WinEvent`, `iw scan`, `show networks`, `wlanreport`).
- Incident snapshot uses `liveAdapterSnapshot` (ssid/bssid/band/channel/rssi/signal/tx/rx/mac/description plus state/radio/auth/cipher). `OUTAGE_TYPES` remains `lan|wan|dns|http`.
- Host NIC: `HOST_NIC_INTERVAL_MS = 30000`, started from `applyIntegrationSettings` even when router poll is off, stopped on `shutdown` / `resetRouterPollForTest`, timer `unref`d. `persistHostNic` removed from `pollRouterOnce` (tested).
- `parseNetshWlanInterfaces` prefers a `State: connected` block; Signal `85%` → `signal: 85`, `rssi: null`; RSSI/`dBm` path exists; Overview paint has no `rssiToPct`.
- Verdict pure function: sleep → isp → this_pc_wifi → unknown; unknown evidence is the locked ISP-up unproven sentence. Fail events do not open system-log gaps; Kernel-Power 42 is sleep.
- `wifi_events` schema/index, insert skip-empty-kind, 1s dedup, prune with probes, `probe_retention_days` stays 14.
- UniFi/Omada device spark: `WIFI_ROUTER_SRC` adds `unifi`/`omada`. Nearby BSS is Scan-tab click + disclaimer, not `_tick`.
- Tests added to `npm test`: `wifi-alerts`, `wifi-chronicle`, `wifi-nearby`. Isolation assertions duplicated in `lan-security` / `security`.

## Findings

### Critical

None.

### High

1. **Host-nic timer re-evaluates stale router RSSI as new samples (false `wifi_weak`)**  
   - **File:** `electron/lan-bridge.js:1076-1083`, `718-726`, `645-660`, `1031-1058`, `1122-1129`  
   - **What's wrong:** Spec says the 30s timer does `persistHostNic` then `checkWifiAlerts`, and `pollRouterOnce` keeps **router-client** alerts. The timer calls the same `checkWifiAlerts()`, which always iterates **all** of `lastWifiByMac`. That map is the last router-poll client cache (`recordWifiMetric`); `persistHostNic` only `set`s the host MAC on top. `syncRouterPoll` when poll is turned off clears `lastPollWifiClients` but **not** `lastWifiByMac`.  
   - **Why it matters:** (a) Router poll off: leftover client RSSI is treated as a new weak sample every 30s forever → streaks hit `debounce_n` and `wifi_weak` toasts/webhooks fire with no new measurement. (b) Router poll on: the 30s tick increments the same client streaks between polls, so alerts fire faster than the poll interval. This is a regression from moving `checkWifiAlerts` onto an always-on timer.  
   - **How to fix:** On the host-nic tick, pass **only** the host_nic sample just written (or filter `source === "host_nic"`). Keep full-map `checkWifiAlerts` inside `pollRouterOnce`. Clear `lastWifiByMac` / streaks for router sources in `syncRouterPoll` when poll stops. Add a test: poll once with a weak client, disable poll, tick host-nic `debounce_n` times, assert **no** new fire for that client.

2. **History live-computes verdict with current WAN/peers, not the outage window**  
   - **File:** `electron/main.js:887-904`, `electron/lan-bridge.js:1341-1409`  
   - **What's wrong:** Spec stores `wifi_verdict` on `snapshot_json` after ingest (that path in `maybeNotifyOutage` is fine). The History IPC then **recomputes** `wifiVerdictForOutage(row)` for every LAN row missing `snapshot_json.wifi_verdict`. That helper uses **latest** `getRouterHealth().wan_ok` and **current** `lan_devices` `online` flags (`peersOnlineDuring`), not samples from `[started_at, ended_at]`.  
   - **Why it matters:** Every pre-upgrade LAN outage (and any row whose merge lost the patch) can show **This PC Wi-Fi** or **ISP / WAN** because the router is up and phones are online *now*. That is a false diagnosis, worse than no badge. It also does per-row `listWifiEvents` + `listOutages` + `listLanDevices` (up to `limit` 500).  
   - **How to fix:** Trust snapshot only for closed rows. Live-compute only for `ended_at == null` (and even then, Overview already has `status.wifi_verdict`). Do not invent a badge from current topology for historical rows.

### Medium

3. **`Signal: -55 dBm` is also stored/shown as `-55%`**  
   - **File:** `electron/netcheck.js:572-614`, test `electron/test/cross-platform.test.js:259-262`  
   - **What's wrong:** `parseExplicitDbm` correctly sets `rssi` from a `dBm` token, but `signal: firstNumber(f.signal)` still copies `-55`. Overview `paintAdapterLine` will show both **RSSI −55 dBm** and **Signal −55%**. Spec: never `% → dBm`, and Signal percent vs explicit dBm must stay distinct.  
   - **Why it matters:** Dishonest percent chip on the one path this pass added to *support* dBm.  
   - **How to fix:** If the Signal field matches `dBm`, set `signal: null`. If an `RSSI` field is a percent (`%` or value in 0–100 without `dBm`), do not write `rssi`. Extend the existing parser test.

4. **`scanWindowsLogs` returns an uncapped `events` array over IPC**  
   - **File:** `electron/system-logs.js:429-458`, `351-359` (cache), IPC `electron/main.js:952-956`  
   - **What's wrong:** Spec: “`events` (normalized, **capped**) for ingest.” Gaps are capped (`MAX_GAPS`); `events` is the full `normalizeRawEvents` list. Each QUERY_SPEC already pulls up to 400 WinEvents; four specs × EventData × 800-char messages now ride `api:system-logs:get/scan`. The System Logs UI only renders `gaps`.  
   - **Why it matters:** Large Event Log windows can stall the renderer / IPC; ingest does not need that payload on the UI channel.  
   - **How to fix:** Cap ingest/UI events (e.g. 500, newest or window-clipped). Prefer not putting full `events` on the System Logs IPC; keep them in-process for `ingestWlanChronicle`.

5. **Chronicle ingest clobbers the System Logs scan cache with a ~60s window**  
   - **File:** `electron/lan-bridge.js:1421-1448`, `electron/system-logs.js:373-458`  
   - **What's wrong:** `ingestWlanChronicle` calls `scanWindowsLogs({ from: started_at-60, to: now, refresh: true })`, which always assigns `cache = result`.  
   - **Why it matters:** Opening a LAN outage replaces a 7-day System Logs cache with ~60 seconds of events. Next System Logs visit cache-misses and re-runs a 45s PowerShell scan.  
   - **How to fix:** Scan without writing the UI cache (flag), or snapshot/restore `cache` around ingest.

6. **Host-nic tick never refreshes `lastWifiMetrics` (Prometheus host series)**  
   - **File:** `electron/lan-bridge.js:1051-1053` vs `895-950`, `99-125`  
   - **What's wrong:** `lastWifiMetrics` is only rebuilt at the end of `pollRouterOnce`. Previously `persistHostNic` ran in that function *before* the snapshot, so host_nic appeared in `/metrics`. After the split, poll-off (or poll-on host) host RSSI is not published.  
   - **Why it matters:** Metrics lie about this PC’s radio when router poll is disabled — the case this pass made first-class.  
   - **How to fix:** After a successful `persistHostNic`, rebuild `lastWifiMetrics` from `lastWifiByMac` (host-only when poll is off).

7. **No integration coverage for the two High paths**  
   - **File:** missing in `electron/test/router-poll.test.js` / `electron/test/ui.test.js`  
   - **What's wrong:** Chronicle unit tests and persistHostNic roam tests exist. Nothing asserts host-nic `checkWifiAlerts` sample filtering, `syncRouterPoll` cache clear, History-only-snapshot badges, or `ingestWlanChronicle` → `mergeOutageSnapshot`.  
   - **Why it matters:** Both Highs would have been caught by a single focused test each.  
   - **How to fix:** Add those tests as part of the High fixes.

### Low

8. **SSID compare in `detectHostNicRoam` is case-sensitive**  
   - **File:** `electron/wifi-chronicle.js:148-166`  
   - Spec: roam if SSIDs equal or either missing. `Home` vs `HOME` returns null (missed roam). Normalize case (and trim) before compare.

9. **Chronicle debounce is stamped before a successful scan**  
   - **File:** `electron/lan-bridge.js:1421-1428`  
   - Failed `scanWindowsLogs` still sets `lastChronicleIngestAt`, so a LAN flap within 10s skips ingest. Set the timestamp only after `ok: true` (or on skip after success).

10. **Overview adapter chips lost compact CSS**  
    - **File:** `web/styles.css:629-635` (removed `.adapter-line .meta-chip` min-width/padding/font-size)  
    - This pass added BSSID/rate/state/verdict chips and dropped the tighter chip rules. Chips wrap more on a 400px tray. Restore `.adapter-line .meta-chip { min-width: 0; padding: 0.28rem 0.5rem; font-size: 0.8rem; }` (or equivalent) beside the new badge rules.

11. **`classifyWlanEvent` uses numeric `Reason` as `reason_text`**  
    - **File:** `electron/wifi-chronicle.js:123-130`  
    - EventData `Reason: "3"` becomes both code and text; the 800-char message is ignored. Prefer message / `ReasonText` when `Reason` is numeric.

### Info (not findings against the lock)

- **Module APIs vs Wave 2 ownership:** spec’s netcheck section lists `parseNetshWlanNetworks` / `parseIwScan`; Wave 2 file table puts them in `electron/wifi-nearby.js`. Implementation follows Wave 2. Fine.
- **Windows 8002 → `connect`:** matches locked `classifyEvent` even though OS 8002 is a failed association. Plan issue, not a code miss.
- **WLAN 12013:** in `QUERY_SPECS` and `CONNECT_IDS` (gap close) vs chronicle `roam` when BSSID present. Spec did not list 12013 under `classifyEvent`; gap-close as connect is reasonable.
- Locked skips (heatmaps, monitor mode, Npcap, `%→dBm` conversion, fake SNR, wlanreport HTML, Native WLAN helper, `type==="wifi"` outage, WAN-while-LAN-down probe change, roaming-aggressiveness writes, widget SSID, CoreWLAN/wdutil, retention bump) were not filed.

## Plan checklist (locked)

| Requirement | Status |
|-------------|--------|
| No `type==="wifi"` outage insert | Pass (`OUTAGE_TYPES`) |
| WAN skipped while LAN down | Unchanged |
| Windows RSSI null unless dBm / RSSI field | Pass for `%`; see Medium 3 for dBm-as-% |
| Host NIC ~30s always-on; not only inside router poll | Pass |
| `persistHostNic` removed from `pollRouterOnce` | Pass |
| Incident adapter = `liveAdapterSnapshot` | Pass |
| `wifi_events` + prune with probes; retention 14 | Pass |
| Verdict sleep → isp → this_pc_wifi → unknown | Pass (pure fn) |
| Unknown evidence: ISP-up unproven | Pass |
| `monitor.js` must not require system-logs / wifi-chronicle / wifi-nearby / lan-bridge; no Event Log / iw scan / show networks on `_tick` | Pass |
| Nearby BSS user-triggered, Scan tab | Pass |
| UniFi/Omada spark | Pass (`WIFI_ROUTER_SRC`) |

## Recommendations

1. Fix High 1 and High 2 in one pass; they are localized (`lan-bridge` alert samples + `main` History mapping).
2. Add router-poll tests for “poll off does not keep firing on last client RSSI” and a History IPC test that a closed LAN row without `snapshot.wifi_verdict` stays unlabeled.
3. Optionally persist `routerWanOk` / `peersOnlineDuring` *into* `wifi_verdict.evidence` at merge time so even the stored badge explains *which* signal was used.

## Assessment

**Ready to merge?** With fixes.

**Reasoning:** The chronicle/netsh/db/nearby/monitor split matches the lock and is tested at the parser boundary. Shipping as-is would false-fire Wi-Fi alerts from a stale router cache and stamp live topology onto old History rows. Those two Highs are small diffs; after they land (plus the dBm-as-% parser hole), this is mergeable.
