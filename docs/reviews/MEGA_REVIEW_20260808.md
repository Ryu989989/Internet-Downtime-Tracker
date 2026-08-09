# MEGA_REVIEW_20260808 — Usage + Connections (A∪B∪C)

**Scope:** Connections tab, elevated ETW Usage helper, Control (alerts/caps/firewall), IPC, sql.js usage tables, README matrix, tests.  
**Date:** 2026-08-08  
**CI:** `npm test` → **81/81 pass** (exit 0)  
**Verdict: PASS (Ship)** — Criticals found in first pass were fixed; no open Criticals remain.

---

## Scorecard

| Dimension | /10 | Top risk |
|-----------|-----|----------|
| Correctness | 8 | Helper must be built (`dotnet publish`); Usage empty until UAC |
| Security | 8 | Local named-pipe + token file (same-user threat); Control behind master toggle |
| Architecture | 9 | No `monitor._tick` coupling; dedicated IPC + tab polling |
| Tests | 8 | Unit coverage for shaping/rollups/control/IPC surface; manual UAC/Firewall |
| Performance | 7 | 5s rollup + 30s sql.js debounce; ignore skips bytes; upsert only on change |
| UX / privilege honesty | 9 | Disclaimers; Connections no-admin; Usage degraded without helper |

**Overall:** 8/10

---

## Invariants (regression)

| Invariant | Status |
|-----------|--------|
| Debounce open-after-N / close-on-success | Verified (monitor tests) |
| WAN suppressed while LAN down | Verified (monitor/security tests) |
| No public bind | Verified (loadFile + IPC) |
| Electron lockdown (contextIsolation, no nodeIntegration, sandbox, preload allowlist) | Verified |
| Outage types lan\|wan\|dns\|http | Unchanged |
| Ookla-only speed | Unchanged |
| **No usage/connections in `monitor._tick`** | Verified (grep + security test) |
| **Connections without elevation** | Verified (PowerShell snapshot only) |
| **Usage claims only when helper elevated+connected** | Verified (UI gating + enable path) |
| **Control behind `network_control_enabled`** | Verified (`assertControlAllowed` + UI gate) |

---

## Findings (post-fix merge)

### Critical — fixed before PASS
1. Usage trend used wrong field (`buckets` vs `series`) → fixed `ensureUsageTrend(hist.series || …)`.
2. Cap hits re-fired every 5s (toast/auto-block spam) → cooldown via `usage_alert_state` keys `cap:…`.

### High — fixed
3. Ignored apps still rolled bytes → skip in `processLiveUsageApps`.
4. Block buttons always shown → gated on `network_control_enabled`.
5. `usage_monitoring` could stick true without helper → enable/settings revert unless `connected`.
6. Missing IPC security surface tests → added in `security.test.js`.
7. `sanitizeExePath` allowed UNC/device paths → drive + `.exe` only.

### Medium (accepted / residual)
- Named pipe ACL tightened to **current user SID** + LocalSystem (was BuiltinUsers). Token passed via `--token-file` + icacls-hardened file (not on cmdline). Same-user malware residual remains; DPAPI still future.
- Caps/alerts Settings form UI writes `usage_*_json` (MiB fields); raw multi-app JSON beyond one app row still limited.
- Auto-block only if caps set `auto_block` + master toggle + cooldown (no silent default).
- After reboot, helper not auto-UAC; UI tells user to re-Enable (honest).

### Low
- Helper `bin/`/`publish/` gitignored; build helper before Usage.
- Connections enumerates remote IPs — disclosed in panel lead.

---

## Cross-verify deltas (Grok 4.5 × Composer 2.5)

| Claim | Grok synthesis | Composer adversarial | Resolution |
|-------|----------------|----------------------|------------|
| Probe isolation | Holds | Holds (`monitor.js` clean) | **Agree — SURVIVE** |
| sql.js blowup from 5s rollup | Moderate risk | Attack rejected (30s debounce + prune) | **Composer wins** — residual High mitigated by skip-upsert/ignore |
| Chart wiring | Critical | High (same bug) | **Agree — FIXED** |
| Cap spam | Critical | — | **FIXED** |
| Billing / privilege lies | Honest | Honest | **Agree — SURVIVE** |
| WinDivert / always-on service | Out of scope | Out of scope | **Agree** |
| Security IPC tests | High gap | High gap | **FIXED** |
| Auto-block foot-gun | High | High | **Mitigated** (cooldown + explicit caps + master toggle + Settings form) |

---

## Fable-judge claims

| Claim | Result |
|-------|--------|
| `npm test` exit 0 (81 tests) | **verified** |
| No `monitor._tick` usage/connections coupling | **verified** |
| Connections works without admin | **verified** (code path) |
| Usage requires elevated helper | **verified** (code + UI) |
| Control master toggle default off | **verified** (DEFAULT_SETTINGS) |
| Manual UAC / Firewall / live ETW under load | **assumed** (Windows interactive; not automated) |
| Packaged `dist/` rebuild | **deferred** (not claiming dist ship this gate) |

---

## Ship verdict

**PASS — Ship** with residual Mediums documented. No open Criticals.

**Manual checklist (operator):**
1. `dotnet publish -c Release -o publish` in `helper/IdtUsageHelper`
2. Connections tab: Refresh, Established-only, auto-refresh while visible; Overview stale banner unchanged
3. Usage: Enable → UAC → live rates under load; Disable path clears monitoring flag on failed elevate
4. Settings: network control on → Block/Unblock with confirm; off → UI shows enable hint
5. Speed test: probes + usage suppress during run

---

## Top leftover gaps (non-blocking)

- Multi-app caps/alerts rows beyond the single Settings form row (JSON still accepted by DB)
- DPAPI for token file
- `list_blocks` so Unblock appears for rules already present
- Stamp `mega-review.ok` if committing ≥2 product files via hook
