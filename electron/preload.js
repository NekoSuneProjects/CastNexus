"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// IMPORTANT: contextBridge clones only *own enumerable* properties.
// `ipcRenderer` is an EventEmitter whose methods live on its prototype, so
// exposing the object wholesale yields an empty `{}` in the renderer and every
// call fails with "invoke is not a function". Wrap each method explicitly.
const api = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    const wrapped = (_event, ...args) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld("ipcRenderer", api);

contextBridge.exposeInMainWorld("appAPI", {
  settings: {
    get: (key) => ipcRenderer.invoke("store:get", key),
    set: (key, value) => ipcRenderer.invoke("store:set", key, value),
    getAll: () => ipcRenderer.invoke("store:getAll"),
  },
});
