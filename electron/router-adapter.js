"use strict";

/**
 * Vendor factory. Optional writes: setClientBlocked / setGuestWifi only (no reboot/firmware).
 */

const asuswrt = require("./asuswrt");
const nighthawk = require("./nighthawk");
const unifi = require("./unifi");
const omada = require("./omada");

const VENDORS = {
  asuswrt,
  nighthawk,
  unifi,
  omada,
};

function createAdapter(vendor) {
  const key = String(vendor || "")
    .trim()
    .toLowerCase();
  return VENDORS[key] || null;
}

function vendorWriteSupport(vendor) {
  const a = createAdapter(vendor);
  return {
    setClientBlocked: !!(a && typeof a.setClientBlocked === "function"),
    setGuestWifi: !!(a && typeof a.setGuestWifi === "function"),
  };
}

/** wifi_samples.source: asuswrt → asus, nighthawk → nighthawk, unifi|omada as-is */
function wifiSampleSource(vendor) {
  const key = String(vendor || "")
    .trim()
    .toLowerCase();
  if (key === "asuswrt") return "asus";
  if (key === "nighthawk") return "nighthawk";
  if (key === "unifi") return "unifi";
  if (key === "omada") return "omada";
  return null;
}

module.exports = { createAdapter, wifiSampleSource, vendorWriteSupport, VENDORS };
