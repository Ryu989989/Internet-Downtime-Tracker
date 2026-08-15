# Mega Review — security-auditor (peer-gaps 2026-08-12)

**Scope:** spec `docs/superpowers/specs/2026-08-12-peer-gaps-info-pass.md` — privilege honesty; ping/traceroute/rDNS/NetBIOS vs `monitor._tick`; private/local IP guards; IPC allowlist; traceroute spawn; reverse-DNS SSRF/leak; Devices disabled path; no public bind.  
**Skipped (locked, not findings):** GeoIP, WinDivert, Close Connection, sent/recv counters.  
**Graphify:** `graphify-out/graph.json` absent — continued from tokensave + targeted grep.  
**CI:** `npm test` not run (specialist; parent gate). electron-builder / relaunch not run (constraint).

## Verdict

**PASS** — Critical 0 · High 0 · Medium 1 · Low 2 · Info 2

Ship with the Medium in the current sprint. No release blockers.

## Scorecard

| Dimension | /10 | Top risk |
|-----------|-----|----------|
| Security (IPC / spawn / XSS) | 8 | Ping/traceroute IPC ignores `lan_devices_enabled` |
| Isolation (`_tick`) | 10 | No lan/usage/topology/sniffer/scan/traceroute on probe tick |
| Privilege honesty | 9 | Electron asInvoker; Usage still UAC helper |
| Network guards | 8 | Public ICMP/tracert blocked; loopback/link-local still allowed |
| Bind / Electron lockdown | 10 | `loadFile` + CSP; metrics/API `127.0.0.1` |

## Top fix first

Gate `api:lan:devices:ping` and `api:lan:devices:traceroute` on `lan_devices_enabled === false` the same way `listDevices` / `refreshDevices` already do — return `devicesDisabledPayload()` (or `{ok:false, error: warning}`) so Settings-off is an IPC policy, not only a UI hide.

## Attack checklist

| Attack | Result |
|--------|--------|
| Privilege honesty (non-elevated default; Usage helper required) | **Hold** |
| Ping / traceroute / rDNS / NetBIOS not on `monitor._tick` | **Hold** |
| Private/local IP guards (ping, traceroute, NBT/PTR) | **Hold** (public rejected) |
| IPC allowlist (preload ↔ `safeHandle`, sender check) | **Hold** |
| Traceroute spawn args (no `shell:true`, host last, `-d`/`-n`) | **Hold** |
| Reverse-DNS SSRF / leak | **Hold** (opt-in, settings-driven, IP-only PTR) |
| LAN devices disabled path | **Partial** — UI/list/refresh honest; ping/traceroute IPC not gated |
| Public bind forbidden | **Hold** |

## Findings

### Medium

**[MEDIUM] Ping/traceroute IPC ignores Devices master switch** — CWE-285 / OWASP A01  
- **Location:** `electron/main.js:861-866`; `electron/lan-devices.js:476-493`; contrast `electron/lan-bridge.js:67-71`, `148-151`  
- **Impact:** `lan_devices_enabled=false` stops ARP/NBT/PTR and paints the Connections-style warning (`web/app.js:2260-2269`). The new channels still spawn `ping`/`tracert` for any `isPrivateOrLocalIp` target. UI hides buttons; DevTools or XSS in the sandboxed renderer can still ICMP/traceroute the LAN.  
- **Fix:** In both handlers (or in `pingDevice`/`tracerouteDevice`), if settings `lan_devices_enabled === false`, return the disabled payload and do not spawn. Add a unit test that disabled settings short-circuit before `pingHost`/`tracerouteHost`.

### Low

**[LOW] `tracerouteHost` does not enforce private/local IP** — CWE-78 defense-in-depth  
- **Location:** `electron/traceroute.js:67-71` (guard only in `tracerouteDevice` `:490-492`)  
- **Impact:** Production IPC is wrapped. A future caller of `tracerouteHost` can `execFile` `tracert` against a public host (DNS disabled via `-d`, still outbound ICMP).  
- **Fix:** Call `isPrivateOrLocalIp` (or `net.isIP` + private ranges) inside `tracerouteHost` before `execFile`.

**[LOW] No in-flight cap on traceroute IPC** — CWE-400  
- **Location:** `electron/traceroute.js:77-80` (`timeout: 30_000`); `electron/main.js:864-866`  
- **Impact:** Repeated `lanDevicesTraceroute` from the renderer can stack many 30s `tracert` processes (local DoS / CPU). Ping is shorter (`netcheck.pingHost` ~timeoutS+2s) but also uncapped.  
- **Fix:** Single-flight mutex or reject if a traceroute is already running; keep hop/total timeouts.

### Info

**[INFO] Private allowlist includes loopback and `169.254.0.0/16`**  
- **Location:** `electron/port-scan.js:24-38` used by ping/traceroute/NBT (`lan-devices.js:421`, `479`, `490`)  
- **Impact:** `127.0.0.1` / `localhost` / `169.254.169.254` are valid Devices targets. ICMP/NBT is not HTTP IMDS; still wider than “LAN neighbor row” if XSS supplies the IP. Scan already used this helper.  
- **Fix (optional):** Deny loopback + `169.254.169.254` (and IPv6 `::1`) on ping/traceroute even if scan keeps them.

**[INFO] Connections PTR of public remotes (by design)**  
- **Location:** `electron/connections.js:418-442`; `electron/main.js:747-749`; default `connections_resolve_dns: false` (`electron/db.js` DEFAULT_SETTINGS)  
- **Impact:** When the user enables Resolve DNS, up to 8 `dns.reverse` queries per snapshot go to the OS resolver (destination IPs visible to that DNS). Not HTTP SSRF: IPs only (`net.isIP`), loopback skipped, renderer cannot set `resolveDns` (main copies the setting). Names are `escapeHtml`’d in `web/app.js:3256`.  
- **Fix:** None required. Hint already says reverse-DNS, default off, not GeoIP.

## Critical → High

**Critical:** none  
**High:** none

## Positive observations

- Electron prefs: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (`electron/main.js:164-169`). Dashboard `loadFile` only; `will-navigate` preventDefault; `setWindowOpenHandler` deny + https `openExternal`.
- Preload is a fixed `window.idt` allowlist (no `ipcRenderer` passthrough, no dynamic invoke). New channels `api:lan:devices:ping` / `traceroute` match preload `lanDevicesPing` / `lanDevicesTraceroute`. `safeHandle` requires `event.sender === mainWindow.webContents`.
- `monitor.js` requires only `netcheck` + `uptime-bar`. `_tick` copies `http_cert_days` from the existing `checkHttp` 3-tuple — no second HTTP fetch, no traceroute/pingDevice/NBT. Tests grep `monitor.js` for the new channel names (`electron/test/lan-security.test.js`, `security.test.js`).
- Traceroute: `execFile` (not `shell:true`), Windows `tracert -d -h N -w N <ip>`, Unix `-n`; hops/timeout coerced to numbers; host is last argv. IPC target must pass `isPrivateOrLocalIp` (`net.isIP` except `localhost`/`127.0.0.1`/`::1`). Public `8.8.8.8` / `1.1.1.1` rejected in `lan-devices.test.js`. NBT is `execFile("nbtstat", ["-A", ip])` after the same guard. `getLatestScanForIp` is parameterized SQL.
- Privilege: no `requestedExecutionLevel` / requireAdministrator in `package.json` nsis (electron-builder default asInvoker). Usage still `usageBridge.startElevated` + Settings UAC copy. Connections documented unelevated (`?` names; no sent/recv). README matrix matches. `conn-service` “Empty if none” is slightly weaker than “CIM may be blank without admin” — not a privilege-escalation bug.
- Disabled Devices: `devicesDisabledPayload` + `paintDevicesDisabled` uses `data.warning` (not “0 devices”). Refresh short-circuits before ARP/hostname lookups.
- Bind: `metrics-api.js` `BIND_HOST === "127.0.0.1"`; Settings tips `set-prom` / `set-http-api` say never `0.0.0.0`. CSP `connect-src 'none'`. No `shell:true` in `electron/`.
- XSS: PTR/NBT/service/resolved names go through `escapeHtml` / `tipCellAttr`; traceroute hops use `textContent`/`alert`, not `innerHTML`. Topology selected label uses SVG `textContent`.

## Recommendations

- Gate ping/traceroute (and consider WOL/scan/export) on `lan_devices_enabled`.
- Pre-existing, out of this pass: `scanDevice` allows `requireKnown: false` from the renderer (`electron/lan-bridge.js:271-272`) — keep known-device default; do not let ping grow the same bypass.
- Optional: mutex traceroute; tighten loopback/IMDS on Devices actions.

## Fable-judge claims

| Claim | Status | Evidence |
|-------|--------|----------|
| No `requestedExecutionLevel`; Electron unelevated | **verified** | Product grep empty; `package.json` nsis has no UAC level; `usage-bridge.js` header + `Start-Process -Verb RunAs` for helper only |
| Usage helper still required | **verified** | `main.js` `api:usage:enable` → `startElevated`; `web/index.html:717-718`; README matrix |
| Ping/traceroute/rDNS/NBT not on `_tick` | **verified** | `monitor.js` requires; tests `doesNotMatch` `tracerouteHost` / `pingDevice` / new channel names |
| Private IP guards on Devices ping/traceroute | **verified** | `isPrivateOrLocalIp`; tests reject `1.1.1.1` / `8.8.8.8` |
| IPC allowlist 1:1 + sender check | **verified** | `preload.js` / `registerIpc` / `safeHandle` |
| Traceroute spawn safe | **verified** | `traceroute.js` `execFile` + `-d`/`-n` + numeric hops/wait |
| rDNS not SSRF; default off; not renderer-overridable | **verified** | `resolveDns: !!settings.connections_resolve_dns`; `dns.reverse` after `net.isIP`; cap 8 |
| Devices-disabled UI warning | **verified** | payload + `paintDevicesDisabled` |
| Devices-disabled blocks ping/traceroute IPC | **failed** | Medium finding |
| No public bind | **verified** | `loadFile`; `BIND_HOST`; listen tests in `lan-security.test.js` |
| `npm test` exit 0 | **not run** | Specialist constraint; tests read not executed |
| Packaged rebuild / relaunch | **not run** | User constraint |
| Graphify blast radius | **assumed** | `graphify-out/graph.json` missing |
