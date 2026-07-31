"use strict";

const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "node_modules", "chart.js", "dist", "chart.umd.js");
const destDir = path.join(__dirname, "..", "web", "vendor");
const dest = path.join(destDir, "chart.umd.min.js");

if (!fs.existsSync(src)) {
  console.warn("chart.js not installed yet; skip vendor copy");
  process.exit(0);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log("vendored Chart.js -> web/vendor/chart.umd.min.js");
