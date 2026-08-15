"use strict";

/**
 * Scheduled Ookla speed-test runner. Factored out of main.js so the gating
 * logic is unit-testable without pulling in Electron.
 */

function createSpeedtestScheduler({ db, monitor, speedtest, usageBridge, userDataPath }) {
  let scheduler = null;

  async function runSpeedTestAndStore() {
    if (monitor) monitor.setProbeSuppress(true);
    if (usageBridge) await usageBridge.setSuppress(true);
    try {
      const result = await speedtest.runSpeedTest(userDataPath());
      const saved = db.insertSpeedTest({
        tested_at: result.tested_at,
        download_mbps: result.download_mbps,
        upload_mbps: result.upload_mbps,
        ping_ms: result.ping_ms,
        jitter_ms: result.jitter_ms,
        packet_loss: result.packet_loss,
        server_name: result.server_name,
        server_id: result.server_id,
        server_location: result.server_location,
        isp: result.isp,
        result_url: result.result_url,
        raw_json: result.raw_json,
      });
      return { test: saved, ok: true };
    } catch (err) {
      if (err && err.code === "CANCELLED") {
        return { ok: false, cancelled: true, error: err.message };
      }
      throw err;
    } finally {
      if (monitor) monitor.setProbeSuppress(false, { cooldownMs: 8000 });
      if (usageBridge) await usageBridge.setSuppress(false);
    }
  }

  function stopSpeedtestScheduler() {
    if (scheduler) {
      clearInterval(scheduler);
      scheduler = null;
    }
  }

  function startSpeedtestScheduler() {
    stopSpeedtestScheduler();
    if (!db) return;
    const intervalMin = Number(db.getSettings().speedtest_interval_min || 0);
    if (intervalMin <= 0) return;
    const intervalMs = Math.max(1, intervalMin) * 60_000;
    const tick = async () => {
      if (!monitor || monitor.state.paused || monitor.state.probe_suppressed || monitor._suppressProbes) return;
      try {
        await runSpeedTestAndStore();
      } catch (err) {
        // swallow in scheduler; log only when possible
        try { console.error("scheduled speed test failed", err); } catch {}
      }
    };
    scheduler = setInterval(tick, intervalMs);
    // stagger first run by 30s so boot does not immediately saturate
    setTimeout(tick, 30_000).unref?.();
  }

  return { runSpeedTestAndStore, startSpeedtestScheduler, stopSpeedtestScheduler };
}

module.exports = { createSpeedtestScheduler };
