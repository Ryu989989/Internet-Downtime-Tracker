"use strict";

const { probe: runProbe, getActiveAdapter } = require("./netcheck");

const ADAPTER_EVERY_N = 30;
const OUTAGE_TYPES = ["lan", "wan", "dns", "http"];

class Monitor {
  constructor(db, { probeFn = null, onState = null, onOutage = null } = {}) {
    this.db = db;
    this.probeFn = probeFn || null;
    this.onState = onState;
    this.onOutage = onOutage;
    this.state = {
      lan_ok: null,
      wan_ok: null,
      dns_ok: null,
      http_ok: null,
      gateway: null,
      latency_ms: null,
      lan_method: null,
      adapter: null,
      paused: false,
      last_probe_at: null,
      lan_fail_streak: 0,
      wan_fail_streak: 0,
      dns_fail_streak: 0,
      http_fail_streak: 0,
      open_lan_id: null,
      open_wan_id: null,
      open_dns_id: null,
      open_http_id: null,
      started_at: Date.now() / 1000,
      probe_suppressed: false,
    };
    this._timer = null;
    this._stopped = true;
    this._probeCount = 0;
    this._running = false;
    this._suppressProbes = false;
    this._suppressCooldownUntil = 0;
  }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._bootstrap().finally(() => this._scheduleNext());
  }

  stop() {
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  pause() {
    this.state.paused = true;
    this._emit();
  }

  resume() {
    this.state.paused = false;
    this._emit();
  }

  togglePause() {
    this.state.paused = !this.state.paused;
    this._emit();
    return this.state.paused;
  }

  /**
   * Suppress probe cycles (e.g. during Ookla speedtest) without flipping
   * user Pause. On release, ignore failure streaks for a short cool-down
   * so saturated-link blips do not open outages.
   */
  setProbeSuppress(active, { cooldownMs = 8000 } = {}) {
    if (active) {
      this._suppressProbes = true;
      this._suppressCooldownUntil = 0;
      this._resetFailStreaks();
      this.state.probe_suppressed = true;
    } else {
      this._suppressProbes = false;
      this._suppressCooldownUntil = Date.now() + Math.max(0, Number(cooldownMs) || 0);
      this._resetFailStreaks();
      this.state.probe_suppressed = false;
    }
    this._emit();
  }

  snapshot() {
    const settings = this.db.getSettings();
    const open = this.db.getOpenOutages();
    const tNow = Date.now() / 1000;
    let in_outage = open.length > 0;
    let uptime_streak_s = 0;
    if (!in_outage) {
      const lastClosed = this.db._get(
        `SELECT ended_at FROM outages WHERE ended_at IS NOT NULL
         ORDER BY ended_at DESC LIMIT 1`
      );
      const baseline =
        lastClosed && lastClosed.ended_at != null
          ? Math.max(lastClosed.ended_at, this.state.started_at)
          : this.state.started_at;
      uptime_streak_s = Math.max(0, tNow - baseline);
    }
    const domains = [...new Set(open.map((o) => o.type))];
    return {
      lan_ok: this.state.lan_ok,
      wan_ok: this.state.wan_ok,
      dns_ok: this.state.dns_ok,
      http_ok: this.state.http_ok,
      gateway: this.state.gateway,
      latency_ms: this.state.latency_ms,
      lan_method: this.state.lan_method,
      adapter: this.state.adapter,
      paused: this.state.paused,
      probe_suppressed: !!this.state.probe_suppressed,
      last_probe_at: this.state.last_probe_at,
      poll_interval_s: settings.poll_interval_s ?? 5,
      open_outages: open,
      failure_domain: domains.length > 1 ? "mixed" : domains[0] || null,
      monitor_started_at: this.state.started_at,
      in_outage,
      uptime_streak_s: Math.round(uptime_streak_s * 10) / 10,
    };
  }

  processResult(result, debounceFail = 2) {
    this._applyProbe(result, debounceFail, true);
  }

  _resetFailStreaks() {
    this.state.lan_fail_streak = 0;
    this.state.wan_fail_streak = 0;
    this.state.dns_fail_streak = 0;
    this.state.http_fail_streak = 0;
  }

  _emit() {
    if (!this.onState) return;
    try {
      this.onState({ ...this.state });
    } catch (err) {
      console.error("on_state callback failed", err);
    }
  }

  _notifyOutage(event) {
    if (!this.onOutage) return;
    try {
      this.onOutage(event);
    } catch (err) {
      console.error("on_outage callback failed", err);
    }
  }

  _openKey(type) {
    return `open_${type}_id`;
  }

  _streakKey(type) {
    return `${type}_fail_streak`;
  }

  _adoptOpenOutageIds() {
    for (const type of OUTAGE_TYPES) {
      const open = this.db.getOpenOutage(type);
      this.state[this._openKey(type)] = open ? open.id : null;
    }
  }

  async _runProbe() {
    if (this.probeFn) return this.probeFn();
    const s = this.db.getSettings();
    return runProbe({
      wanTargets: s.wan_targets,
      dnsResolver: s.dns_resolver,
      httpUrl: s.http_url,
    });
  }

  async _maybeRefreshAdapter() {
    if (this._probeCount % ADAPTER_EVERY_N !== 0 && this.state.adapter) return;
    try {
      this.state.adapter = await getActiveAdapter();
    } catch {
      /* keep prior */
    }
  }

  async _bootstrap() {
    try {
      const result = await this._runProbe();
      this.db.resumeOpenOutages(result);
      this._adoptOpenOutageIds();
      this._applyProbe(result, 2, false);
      this._probeCount = 1;
      await this._maybeRefreshAdapter();
    } catch (err) {
      console.error("initial probe failed", err);
      // Still adopt open IDs so a later success can close prior-session outages.
      this._adoptOpenOutageIds();
    }
  }

  _scheduleNext() {
    if (this._stopped) return;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const settings = this.db.getSettings();
    // Min 2s matches settings clamp; avoids timer storms under slow probes.
    const interval = Math.max(2000, Number(settings.poll_interval_s ?? 5) * 1000);
    this._timer = setTimeout(() => this._tick(), interval);
  }

  async _tick() {
    if (this._stopped) return;
    // Overlap: let the in-flight tick schedule the next one in `finally`.
    if (this._running) return;
    this._running = true;
    try {
      const settings = this.db.getSettings();
      const debounce = Number(settings.debounce_fail_count ?? 2);
      if (!this.state.paused && !this._suppressProbes) {
        try {
          const result = await this._runProbe();
          const inCooldown = Date.now() < this._suppressCooldownUntil;
          // During cool-down: update live status, apply successes only (no new outages).
          this._applyProbe(result, debounce, true, { successesOnly: inCooldown });
          this._probeCount += 1;
          if (this._probeCount % 60 === 0) this.db.pruneProbes();
          await this._maybeRefreshAdapter();
        } catch (err) {
          console.error("probe cycle failed", err);
        }
      }
    } finally {
      this._running = false;
      this._scheduleNext();
    }
  }

  _applyProbe(result, debounceFail = 2, countTowardDebounce = true, { successesOnly = false } = {}) {
    const now = Date.now() / 1000;
    const dnsOk = result.dns_ok == null ? null : !!result.dns_ok;
    const httpOk = result.http_ok == null ? null : !!result.http_ok;
    this.db.insertProbe(
      result.lan_ok,
      result.wan_ok,
      result.latency_ms,
      now,
      dnsOk,
      httpOk
    );

    this.state.lan_ok = result.lan_ok;
    this.state.wan_ok = result.wan_ok;
    this.state.dns_ok = dnsOk;
    this.state.http_ok = httpOk;
    this.state.gateway = result.gateway;
    this.state.latency_ms = result.latency_ms;
    this.state.lan_method = result.lan_method;
    this.state.last_probe_at = now;

    if (countTowardDebounce) {
      const hasDns = result.dns_ok != null;
      const hasHttp = result.http_ok != null;
      if (successesOnly) {
        if (result.lan_ok) this._updateLayer("lan", true, true, debounceFail, now);
        if (result.lan_ok && result.wan_ok) {
          this._updateLayer("wan", true, true, debounceFail, now);
        }
        if (hasDns && result.lan_ok && result.wan_ok && dnsOk) {
          this._updateLayer("dns", true, true, debounceFail, now);
        }
        if (hasHttp && result.lan_ok && result.wan_ok && dnsOk && httpOk) {
          this._updateLayer("http", true, true, debounceFail, now);
        }
      } else {
        this._updateLayer("lan", true, !!result.lan_ok, debounceFail, now);
        this._updateLayer("wan", !!result.lan_ok, !!result.wan_ok, debounceFail, now);
        if (hasDns) {
          this._updateLayer(
            "dns",
            !!(result.lan_ok && result.wan_ok),
            !!dnsOk,
            debounceFail,
            now
          );
        }
        if (hasHttp) {
          this._updateLayer(
            "http",
            !!(result.lan_ok && result.wan_ok && dnsOk),
            !!httpOk,
            debounceFail,
            now
          );
        }
      }
    }
    this._emit();
  }

  /**
   * Layered outage tracking: only evaluate `ok` when `prerequisite` is true.
   * When prerequisite fails, clear fail streak (do not open; leave open outages alone).
   */
  _updateLayer(type, prerequisite, ok, debounceFail, now) {
    const openKey = this._openKey(type);
    const streakKey = this._streakKey(type);
    if (!prerequisite) {
      this.state[streakKey] = 0;
      return;
    }
    if (ok) {
      this.state[streakKey] = 0;
      if (this.state[openKey] != null) {
        const id = this.state[openKey];
        const row = this.db._get("SELECT started_at FROM outages WHERE id=?", [id]);
        this.db.closeOutage(id, now);
        this.state[openKey] = null;
        const durationMs =
          row && row.started_at != null
            ? Math.max(0, Math.floor((now - row.started_at) * 1000))
            : null;
        this._notifyOutage({
          action: "close",
          type,
          id,
          ended_at: now,
          duration_ms: durationMs,
        });
      }
      return;
    }
    this.state[streakKey] += 1;
    if (this.state[openKey] == null && this.state[streakKey] >= debounceFail) {
      const id = this.db.openOutage(type, now);
      this.state[openKey] = id;
      this._notifyOutage({ action: "open", type, id, started_at: now });
    }
  }
}

module.exports = { Monitor, OUTAGE_TYPES };
