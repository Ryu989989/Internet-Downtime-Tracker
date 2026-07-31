"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { tcpConnect } = require("../netcheck");

describe("netcheck", () => {
  it("tcpConnect times out on closed port", async () => {
    const [ok, lat] = await tcpConnect("127.0.0.1", 1, 500);
    assert.equal(ok, false);
    assert.equal(lat, null);
  });
});
