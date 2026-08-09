"use strict";

const dgram = require("dgram");
const { normalizeMac, formatMac } = require("./oui");

function buildMagicPacket(mac) {
  const hex = normalizeMac(mac);
  if (!hex || hex.length < 12) throw new Error("Invalid MAC");
  const macBuf = Buffer.from(hex.slice(0, 12), "hex");
  const parts = [Buffer.alloc(6, 0xff)];
  for (let i = 0; i < 16; i++) parts.push(macBuf);
  return Buffer.concat(parts);
}

/**
 * Send Wake-on-LAN magic packet (UDP 9 broadcast).
 * @param {{ mac: string, broadcast?: string, port?: number }} opts
 */
function wake(opts = {}) {
  const mac = formatMac(opts.mac);
  if (!mac) return Promise.resolve({ ok: false, error: "Invalid MAC" });
  const packet = buildMagicPacket(mac);
  const broadcast = opts.broadcast || "255.255.255.255";
  const port = Number(opts.port) || 9;
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    sock.once("error", (err) => {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error: err.message, tip: "BIOS/NIC must allow Wake-on-LAN." });
    });
    sock.bind(() => {
      try {
        sock.setBroadcast(true);
      } catch {
        /* ignore */
      }
      sock.send(packet, 0, packet.length, port, broadcast, (err) => {
        try {
          sock.close();
        } catch {
          /* ignore */
        }
        if (err) {
          resolve({ ok: false, error: err.message, tip: "BIOS/NIC must allow Wake-on-LAN." });
          return;
        }
        resolve({
          ok: true,
          mac,
          broadcast,
          port,
          tip: "BIOS/NIC must allow WOL; magic packet sent once.",
        });
      });
    });
  });
}

module.exports = { buildMagicPacket, wake, normalizeMac, formatMac };
