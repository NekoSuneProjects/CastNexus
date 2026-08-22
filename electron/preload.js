"use strict";

const { contextBridge, ipcMain } = require("electron");

contextBridge.exposeInMainWorld("appAPI", {
  settings: {
    get: (key) => window.ipcRenderer?.invoke("store:get", key),
    set: (key, value) => window.ipcRenderer?.invoke("store:set", key, value),
    getAll: () => window.ipcRenderer?.invoke("store:getAll"),
  },
});

// For the renderer to access ipcRenderer safely
const { ipcRenderer } = require("electron");
Object.defineProperty(window, "ipcRenderer", {
  value: ipcRenderer,
  writable: false,
});
