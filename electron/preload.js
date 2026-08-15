"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("idt", {
  getStatus: () => ipcRenderer.invoke("api:status"),
  getSummary: () => ipcRenderer.invoke("api:summary"),
  getSettings: () => ipcRenderer.invoke("api:settings"),
  updateSettings: (body) => ipcRenderer.invoke("api:settings:update", body),
  setPaused: (paused) => ipcRenderer.invoke("api:monitor:pause", !!paused),
  getOutages: (params) => ipcRenderer.invoke("api:outages", params || {}),
  updateOutageNotes: (id, notes) =>
    ipcRenderer.invoke("api:outages:notes", { id, notes }),
  exportOutages: (params) => ipcRenderer.invoke("api:export:outages", params || {}),
  exportReport: (params) => ipcRenderer.invoke("api:export:report", params || {}),
  getSystemLogs: (params) => ipcRenderer.invoke("api:system-logs:get", params || {}),
  scanSystemLogs: (params) => ipcRenderer.invoke("api:system-logs:scan", params || {}),
  speedtestStatus: () => ipcRenderer.invoke("api:speedtest:status"),
  speedtestHistory: (params) => ipcRenderer.invoke("api:speedtest:history", params || {}),
  speedtestRun: () => ipcRenderer.invoke("api:speedtest:run"),
  speedtestCancel: () => ipcRenderer.invoke("api:speedtest:cancel"),
  speedtestInstall: () => ipcRenderer.invoke("api:speedtest:install"),
  connectionsSnapshot: (params) =>
    ipcRenderer.invoke("api:connections:snapshot", params || {}),
  usageStatus: () => ipcRenderer.invoke("api:usage:status"),
  usageLive: () => ipcRenderer.invoke("api:usage:live"),
  usageEnable: () => ipcRenderer.invoke("api:usage:enable"),
  usageHistory: (params) => ipcRenderer.invoke("api:usage:history", params || {}),
  usageClear: () => ipcRenderer.invoke("api:usage:clear"),
  usageIgnore: (body) => ipcRenderer.invoke("api:usage:ignore", body || {}),
  usageExport: (params) => ipcRenderer.invoke("api:usage:export", params || {}),
  usageBlock: (body) => ipcRenderer.invoke("api:usage:block", body || {}),
  usageUnblock: (body) => ipcRenderer.invoke("api:usage:unblock", body || {}),
  lanDevices: () => ipcRenderer.invoke("api:lan:devices"),
  lanDevicesRefresh: () => ipcRenderer.invoke("api:lan:devices:refresh"),
  lanDevicesUpdate: (body) => ipcRenderer.invoke("api:lan:devices:update", body || {}),
  lanDevicesExport: (params) => ipcRenderer.invoke("api:lan:devices:export", params || {}),
  lanDevicesPing: (body) => ipcRenderer.invoke("api:lan:devices:ping", body || {}),
  lanDevicesTraceroute: (body) => ipcRenderer.invoke("api:lan:devices:traceroute", body || {}),
  lanWol: (body) => ipcRenderer.invoke("api:lan:wol", body || {}),
  lanTopology: () => ipcRenderer.invoke("api:lan:topology"),
  lanTopologyStop: () => ipcRenderer.invoke("api:lan:topology:stop"),
  lanSnifferStatus: () => ipcRenderer.invoke("api:lan:sniffer:status"),
  lanSnifferStart: (body) => ipcRenderer.invoke("api:lan:sniffer:start", body || {}),
  lanSnifferStop: (body) => ipcRenderer.invoke("api:lan:sniffer:stop", body || {}),
  lanSnifferEvents: (params) => ipcRenderer.invoke("api:lan:sniffer:events", params || {}),
  lanScan: (body) => ipcRenderer.invoke("api:lan:scan", body || {}),
  lanDiscovery: () => ipcRenderer.invoke("api:lan:discovery"),
  lanRouterNotify: (body) => ipcRenderer.invoke("api:lan:router-notify", body || {}),
  onStatusUpdate: (cb) => {
    const handler = (_event, data) => {
      try {
        cb(data);
      } catch (err) {
        console.error("onStatusUpdate handler failed", err);
      }
    };
    ipcRenderer.on("status:update", handler);
    return () => ipcRenderer.removeListener("status:update", handler);
  },
  onLayout: (cb) => {
    const handler = () => {
      try {
        cb();
      } catch (err) {
        console.error("onLayout handler failed", err);
      }
    };
    ipcRenderer.on("ui:layout", handler);
    return () => ipcRenderer.removeListener("ui:layout", handler);
  },
});
