"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  notify,
  detectChannel,
  buildChannelPayload,
  setPostJsonForTest,
  setEmailTransporterForTest,
  clearDigestForTest,
  buildEmailTransporterKey,
  pendingDigestCount,
  flushDigest,
} = require("../notify-webhooks");

describe("notify-webhooks channel payloads", () => {
  let posted = [];
  let emails = [];

  it("flushes queued quiet-hours digests", async () => {
    setPostJsonForTest((url, body) => {
      posted.push({ url, body });
      return { ok: true, status: 200 };
    });
    await notify({
      urls: '["https://example.com/hook"]',
      event: "down",
      title: "Down",
      body: { layer: "wan" },
      quietHours: { start_hour: 0, end_hour: 23, enabled: true },
    });
    assert.equal(pendingDigestCount(), 1);
    const flushed = await flushDigest({ urls: '["https://example.com/hook"]', settings: {} });
    assert.equal(flushed.flushed, 1);
    assert.equal(pendingDigestCount(), 0);
    assert.equal(posted.length, 1);
    assert.equal(posted[posted.length - 1].body.event, "digest");
  });

  beforeEach(() => {
    posted = [];
    emails = [];
    setPostJsonForTest(async (url, body) => {
      posted.push({ url, body });
      return { ok: true, status: 200 };
    });
    setEmailTransporterForTest(async (mail) => {
      emails.push(mail);
      return { ok: true };
    });
  });

  afterEach(() => {
    clearDigestForTest();
  });

  it("detects channel from URL", () => {
    assert.equal(detectChannel("https://discord.com/api/webhooks/1/2"), "discord");
    assert.equal(detectChannel("https://hooks.slack.com/services/x/y/z"), "slack");
    assert.equal(detectChannel("https://ntfy.sh/alerts"), "ntfy");
    assert.equal(detectChannel("https://api.telegram.org/bot123/sendMessage"), "telegram");
    assert.equal(detectChannel("https://example.com/webhook"), "generic");
  });

  it("builds Discord payload", () => {
    const p = buildChannelPayload("discord", { event: "down", title: "WAN down", body: { host: "1.1.1.1" } });
    assert.equal(p.content, "WAN down");
    assert.ok(Array.isArray(p.embeds));
    assert.equal(p.embeds[0].title, "down");
  });

  it("builds Slack payload", () => {
    const p = buildChannelPayload("slack", { event: "up", title: "WAN up", body: {} });
    assert.equal(p.text, "WAN up");
    assert.ok(Array.isArray(p.blocks));
  });

  it("builds ntfy payload with topic", () => {
    const p = buildChannelPayload("ntfy", { event: "test", title: "T", body: {}, url: "https://ntfy.sh/alerts", settings: {} });
    assert.equal(p.topic, "alerts");
    assert.equal(p.title, "T");
  });

  it("builds Telegram payload", () => {
    const p = buildChannelPayload("telegram", { event: "note", title: "N", body: { a: 1 }, settings: { telegram_chat_id: "42" } });
    assert.equal(p.chat_id, "42");
    assert.ok(p.text.includes("N"));
  });

  it("sends to Discord URL with proper schema", async () => {
    await notify({
      urls: '["https://discord.com/api/webhooks/1/token"]',
      event: "down",
      title: "WAN down",
      body: { layer: "wan" },
    });
    assert.equal(posted.length, 1);
    assert.ok(posted[0].url.includes("discord.com"));
    assert.equal(posted[0].body.content, "WAN down");
    assert.ok(posted[0].body.embeds);
  });

  it("sends to Slack URL with blocks", async () => {
    await notify({
      urls: '["https://hooks.slack.com/services/x/y/z"]',
      event: "up",
      title: "Recovered",
      body: { layer: "wan" },
    });
    assert.equal(posted.length, 1);
    assert.ok(posted[0].body.blocks);
  });

  it("sends to ntfy with topic from URL", async () => {
    await notify({
      urls: '["https://ntfy.sh/owntopic"]',
      event: "test",
      title: "Alert",
      body: { msg: "hello" },
    });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].body.topic, "owntopic");
  });

  it("sends Telegram using settings, not URL list", async () => {
    await notify({
      urls: "[]",
      event: "monitor_down",
      title: "Monitor down: gw",
      body: { monitor_id: "gw" },
      settings: { telegram_bot_token: "bot123", telegram_chat_id: "99" },
    });
    assert.equal(posted.length, 1);
    assert.ok(posted[0].url.includes("api.telegram.org/botbot123/sendMessage"));
    assert.equal(posted[0].body.chat_id, "99");
  });

  it("sends email when SMTP configured", async () => {
    await notify({
      urls: "[]",
      event: "down",
      title: "Alert",
      body: { x: 1 },
      settings: { email_smtp_host: "smtp.example.com", email_smtp_port: "587", email_smtp_user: "a", email_smtp_pass: "p", email_from: "a@b", email_to: "c@d" },
    });
    assert.equal(emails.length, 1);
    assert.equal(emails[0].to, "c@d");
    assert.equal(emails[0].subject, "Alert");
  });

  it("blocks email to SSRF hosts", async () => {
    await notify({
      urls: "[]",
      event: "down",
      title: "Bad",
      body: {},
      settings: { email_smtp_host: "127.0.0.1", email_to: "x@y" },
    });
    assert.equal(emails.length, 0);
    assert.equal(posted.length, 0);
  });

  it("falls back to generic payload for unknown URLs", async () => {
    await notify({
      urls: '["https://example.com/hook"]',
      event: "down",
      title: "Down",
      body: { layer: "wan" },
    });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].body.event, "down");
    assert.equal(posted[0].body.title, "Down");
  });

  it("omits Telegram parse_mode when unset", () => {
    const p = buildChannelPayload("telegram", { event: "up", title: "T", body: {}, settings: { telegram_chat_id: "1" } });
    assert.equal(p.chat_id, "1");
    assert.equal("parse_mode" in p, false);
  });

  it("includes Telegram parse_mode when configured", () => {
    const p = buildChannelPayload("telegram", { event: "up", title: "T", body: {}, settings: { telegram_chat_id: "1", telegram_parse_mode: "HTML" } });
    assert.equal(p.parse_mode, "HTML");
  });

  it("email transporter cache key includes password", () => {
    const a = buildEmailTransporterKey({ email_smtp_host: "smtp.example.com", email_smtp_port: 587, email_smtp_user: "a", email_smtp_pass: "p1" });
    const b = buildEmailTransporterKey({ email_smtp_host: "smtp.example.com", email_smtp_port: 587, email_smtp_user: "a", email_smtp_pass: "p2" });
    assert.notEqual(a, b);
  });
});
