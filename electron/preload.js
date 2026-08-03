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
