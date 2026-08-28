# MEGA_REVIEW 20260828 wifi-drop — security-auditor

**Scope:** spec `docs/superpowers/specs/2026-08-28-wifi-drop-diagnostics.md` vs `5271d43030f6bcbef9478cad8fc60b19fad4a7b3..be74a4e6cd6038133fe349bba22176d2b57647ca`.  
**Focus:** IPC (`api:lan:wifi:nearby` and any new channels), spawn/execFile (netsh, iw, Get-WinEvent, powershell), XSS in Overview/History/Scan (verdict chips, nearby BSS table, system logs), privilege honesty (unelevated; nearby/Event Log may be empty), sandbox/contextIsolation unchanged, no secrets, no command injection from SSID/BSSID/event XML, prune of `wifi_events` (not outages), CSP.  
**Skipped (locked, not findings):** WAN-while-LAN-down, `wifi` outage type, heatmaps, `%→dBm`, Native WLAN helper, `wlanreport`.  
**Intentional non-findings:** Electron asInvoker unelevated; empty nearby scan on Linux without Wi-Fi (honest, not a vuln).  
**CI:** `npm test` not run (read-only specialist). Packaged rebuild / relaunch not run.

## Verdict

**PASS** — Critical 0 · High 0 · Medium 0 · Low 1 · Info 3

No release blockers. Ready to merge from a security standpoint.

## Scorecard

| Dimension | /10 | Top residual |
|-----------|-----|----------------|
| IPC allowlist / sender | 10 | Nearby is main-window `safeHandle` only; widget deny |
| Spawn / execFile | 9 | argv `spawn` (no `shell:true`); no nearby in-flight cap |
| XSS (Overview / History / Scan) | 9 | `textContent` / `escapeHtml` on SSID, BSSID, verdict, log reason |
| Command injection (SSID/BSSID/XML) | 10 | Those strings never enter argv or `-Command` |
| Privilege honesty | 9 | asInvoker; fail-closed warnings; empty scan is honest |
| Electron lockdown / CSP | 10 | `contextIsolation`+`sandbox` unchanged; CSP unchanged |
| Data-loss (prune) | 10 | `wifi_events` pruned with probes; `outages` not deleted |

## Attack checklist

| Attack | Result |
|--------|--------|
| New IPC not on preload ↔ `safeHandle` 1:1 | **Hold** — `lanWifiNearby` ↔ `api:lan:wifi:nearby` only |
| Widget / foreign `webContents` invoking nearby | **Hold** — `WIDGET_IPC_CHANNELS` does not include it; `senderAllowed` |
| Renderer-supplied args to netsh/iw | **Hold** — handler ignores args; argv is a fixed list (+ OS iface name) |
| `shell:true` / string-concat spawn | **Hold** — no `shell:true` under `electron/` |
| SSID/BSSID/event XML → command injection (CWE-78) | **Hold** — parse-only; stored via bound SQL |
| XSS via evil SSID / Event Log reason / verdict label | **Hold** — escaped or `textContent` |
| Secrets (`key=clear`, profile keys, PSK) | **Hold** — `netsh wlan show networks mode=bssid` only |
| Privilege escalation / requireAdministrator | **Hold** — nsis stays default asInvoker |
| Empty nearby / Event Log treated as a vuln | **Not a vuln** — spec + catch warnings |
| `monitor._tick` coupling (Get-WinEvent / iw scan / nearby) | **Hold** — `monitor.js` has no matches |
| Prune deletes outages | **Hold** — `DELETE FROM wifi_events` only among new statements |
| CSP / sandbox / contextIsolation regression | **Hold** — unchanged |
| `wlanreport` HTML | **Hold** — not present (locked skip) |

## Findings

### Critical

None.

### High

None.

### Medium

None.

### Low

**[LOW] Nearby BSS IPC has no single-flight / rate limit** — CWE-400 / OWASP A04  
- **Location:** `electron/main.js:1136`; `electron/wifi-nearby.js:184-232`, `235-261`; `web/app.js:3910-3950`  
- **Impact:** `api:lan:wifi:nearby` always spawns `netsh` (20s) or `iw` (25s) with no mutex. The Scan button is not disabled while a scan runs. A sandboxed renderer with DevTools (or a future XSS) can stack many radio scans. `iw scan` can briefly disrupt association on some drivers. Same class as the existing traceroute in-flight gap; nearby is more radio-costly.  
- **Fix:** Reject or coalesce if a scan is already running; disable `#nearbyWifiRun` until the invoke settles. Optional: cap stderr the same way stdout is capped at 2MB (`wifi-nearby.js:203-211` vs unbounded `stderr` at `213-215`).

### Info

**[INFO] System-log IPC now ships `events[]` + `EventData` to the renderer** — CWE-200  
- **Location:** `electron/system-logs.js:212-226`, `447-457`; `electron/main.js:952-956`; UI only paints `data.gaps` in `web/app.js:2514-2574`  
- **Impact:** Ingest in `lan-bridge.js` needs classified events in-process. `api:system-logs:get|scan` reuses `getOrScan` and therefore also returns up to 400 events with 800-char messages and EventData (SSID/BSSID/reason). Not Wi-Fi passwords. Extra OS telemetry in the renderer vs the previous gaps-only payload.  
- **Fix (optional):** Strip `events` from the IPC result; keep the array only for `ingestWlanChronicle`.

**[INFO] Linux iface name is passed to `iw` argv without an allowlist** — CWE-88 defense-in-depth  
- **Location:** `electron/wifi-nearby.js:243-252` (`spawn("iw", ["dev", iface, "scan"])` at `189`)  
- **Impact:** No shell, so this is not CWE-78. `iface` comes from `getActiveAdapter()` (same pattern as existing `iw dev <name> link` in `electron/netcheck.js:744`). A weird kernel name starting with `-` could be parsed as an `iw` flag; realistic IFNAMSIZ names do not.  
- **Fix (optional):** Accept only `/^[A-Za-z0-9._:-]{1,15}$/` before passing `dev`.

**[INFO] Nearby XSS escaping is not locked in UI tests**  
- **Location:** product is safe (`web/app.js:3930-3935`); test `electron/test/ui.test.js:91-98` only checks the Scan disclaimer and `/api/lan/wifi/nearby`  
- **Impact:** An evil AP SSID of `<img onerror=…>` is escaped today. A later innerHTML regression would not fail `ui.test.js`.  
- **Fix (optional):** Assert `runNearbyWifi` / nearby row builder contains `escapeHtml(r.ssid` and `escapeHtml(r.bssid`.

## Positive observations

- **IPC:** Only one new channel. `safeHandle("api:lan:wifi:nearby", async () => wifiNearby.scanNearby())` takes no renderer body. Preload is a fixed `idt` allowlist (`electron/preload.js:54`). Widget channels stay `{api:status, api:settings, api:widget:*}` (`electron/main.js:56-61`).
- **Spawn:** Windows nearby is `spawn("netsh", ["wlan", "show", "networks", "mode=bssid"])` — no `key=clear`, no `show profiles`. Linux is `iw` argv. Timeouts 20s/25s; stdout kill at 2MB. Failure returns `{ok:false, warning}` including “may need privileges” (`electron/wifi-nearby.js:254-260`). Event Log remains `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <script>` with dates from `toISOString()` after `Number()` clamp (`electron/system-logs.js:234-238`, `351-360`, `389-390`); `QUERY_SPECS` JSON is single-quote-escaped (`301`). Chronicle ingest is not on `_tick`: lan `outage_open` + 10s debounce (`electron/lan-bridge.js:48`, `1503-1508`, `1422-1426`).
- **Injection:** SSID/BSSID/reason are parsed then bound in `insertWifiEvent` (`electron/db.js:2353-2366`) with length caps (ssid 64, reason_text 800). `classifyWlanEvent` / `flattenEventData` never call spawn. `[xml]$e.ToXml()` is OS EventRecord XML, not a user file (`electron/system-logs.js:326-335`).
- **XSS:** Overview SSID/BSSID/rate/state/verdict use `textContent` / `classList` (`web/app.js:1929`, `1968`, `1989-2003`). History badge and snapshot evidence use `escapeHtml` (`1450-1456`, `1558`). Nearby table escapes ssid/bssid/channel/signal/security (`3930-3935`); meta/warnings are `textContent` (`3941-3949`). System log source/reason escaped (`2524-2525`); scan errors escaped (`2585-2586`). `escapeHtml` covers `& < > " '` (`326-333`). Verdict evidence from `correlateVerdict` is fixed copy, not SSID.
- **Privilege:** No `requestedExecutionLevel` / `requireAdministrator` in `package.json` nsis (`77-80`) — electron-builder default asInvoker. Usage helper remains the only UAC path. Empty `iw`/`Get-WinEvent` is a warning, not a fake map. Spec copy on Scan/System logs matches.
- **Lockdown:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` unchanged (`electron/main.js:325-330`). `loadFile` + `will-navigate` preventDefault + `setWindowOpenHandler` deny. CSP unchanged: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'` (`web/index.html:6-8`).
- **Prune:** `pruneProbes` adds `DELETE FROM wifi_events WHERE at < ?` (`electron/db.js:1765`) and still has no `DELETE FROM outages`. Test lock: `electron/test/usage-db.test.js:81-117`. Retention default 14 unchanged.
- **Isolation greps:** `electron/monitor.js` does not match `Get-WinEvent`, `system-logs`, `wifi-chronicle`, `wifi-nearby`, `iw scan`, `show networks`, `lan-bridge`, `wlanreport` (confirmed). Tests in `lan-security.test.js:43-49`, `security.test.js:302-304`, `wifi-nearby.test.js:85-89`.

## Ready to merge?

**Yes.** Security residual is one Low (nearby scan stacking) plus optional Info hardening. Do not treat unelevated empty nearby/Event Log as a blocker.

## Fable-judge claims

| Claim | Status | Evidence |
|-------|--------|----------|
| New IPC `api:lan:wifi:nearby` on `safeHandle` + preload 1:1 | **verified** | `electron/main.js:1136`; `electron/preload.js:54` |
| No renderer args into netsh/iw | **verified** | handler `async () => scanNearby()`; argv literals |
| No `shell:true` | **verified** | grep `electron/` empty |
| SSID/BSSID/XML not interpolated into spawn | **verified** | parsers + bound `insertWifiEvent`; PS dates from ISO |
| XSS escaped on verdict / nearby / system logs | **verified** | `web/app.js` as cited |
| sandbox / contextIsolation / CSP unchanged | **verified** | `electron/main.js:325-330`; `web/index.html:6-8`; diff does not touch prefs |
| asInvoker unelevated; no requireAdministrator | **verified** | no `requestedExecutionLevel`; nsis block has no `requestedExecutionLevel` |
| Empty nearby / Event Log is honest | **verified** | warnings; Linux `iw` ENOENT/EPERM → `ok:false` |
| No secrets (`key=clear` / show profiles) | **verified** | grep empty |
| `wifi_events` pruned; outages not | **verified** | `db.js:1762-1767`; usage-db test |
| Nearby / Event Log not on `monitor._tick` | **verified** | `monitor.js` grep empty |
| `wlanreport` / Native WLAN helper / `%→dBm` / `wifi` type | **skipped** | locked; not in diff as features |
| `npm test` exit 0 | **not run** | specialist constraint |
