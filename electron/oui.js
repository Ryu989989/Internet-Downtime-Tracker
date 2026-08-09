"use strict";

/** Compact OUI → vendor (common prefixes only; unknown → null). */
const OUI = {
  "000C29": "VMware",
  "00155D": "Microsoft Hyper-V",
  "001C42": "Parallels",
  "0050F2": "Microsoft",
  "080027": "VirtualBox",
  "0A0027": "VirtualBox",
  "525400": "QEMU/KVM",
  "B827EB": "Raspberry Pi",
  "DCA632": "Raspberry Pi",
  "E45F01": "Raspberry Pi",
  "28CD4C": "Apple",
  "3C22FB": "Apple",
  "A4C138": "Apple",
  "F0D1A9": "Apple",
  "001A11": "Google",
  "F4F5E8": "Google",
  " intermediate0C9": "Amazon",
  "34D270": "Amazon",
  "001B63": "Apple",
  "ACBC32": "Apple",
  "001E58": "D-Link",
  "1C7EE5": "D-Link",
  "001346": "Netgear",
  "A040A0": "Netgear",
  "001018": "Broadcom",
  "00259C": "Cisco-Linksys",
  "001E13": "Cisco",
  "FCFBFB": "Cisco",
  "00E04C": "Realtek",
  "52:54:00": "QEMU",
  "00:15:5D": "Microsoft",
  "DC:A6:32": "Raspberry Pi",
  "B8:27:EB": "Raspberry Pi",
};

function normalizeMac(mac) {
  if (mac == null) return null;
  const hex = String(mac)
    .toUpperCase()
    .replace(/[^0-9A-F]/g, "");
  if (hex.length < 6) return null;
  return hex.slice(0, 12);
}

function formatMac(mac) {
  const hex = normalizeMac(mac);
  if (!hex || hex.length < 12) return null;
  return hex.match(/.{1,2}/g).join(":");
}

function lookupOui(mac) {
  const hex = normalizeMac(mac);
  if (!hex || hex.length < 6) return null;
  const key = hex.slice(0, 6);
  return OUI[key] || null;
}

module.exports = { OUI, normalizeMac, formatMac, lookupOui };
