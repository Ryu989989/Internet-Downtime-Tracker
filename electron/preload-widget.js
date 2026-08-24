"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("idtWidget", {
  getStatus: () => ipcRenderer.invoke("api:status"),
  getSettings: () => ipcRenderer.invoke("api:settings"),
  openDashboard: () => ipcRenderer.invoke("api:widget:openDashboard"),
  widgetBoundsChanged: (bounds) => ipcRenderer.invoke("api:widget:bounds", bounds || {}),
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
  onWidgetPrefs: (cb) => {
    const handler = (_event, data) => {
      try {
        cb(data);
      } catch (err) {
        console.error("onWidgetPrefs handler failed", err);
      }
    };
    ipcRenderer.on("widget:prefs", handler);
    return () => ipcRenderer.removeListener("widget:prefs", handler);
  },
});
