// src/preload.cjs — 렌더러에 열어 주는 것은 이 목록뿐이다
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relay', {
    settings: () => ipcRenderer.invoke('relay:settings'),
    set: (patch) => ipcRenderer.invoke('relay:set', patch),
    consent: (yes) => ipcRenderer.invoke('relay:consent', !!yes),
    sources: () => ipcRenderer.invoke('relay:sources'),
    choose: (id) => ipcRenderer.invoke('relay:choose', id),
    request: (raw) => ipcRenderer.invoke('relay:request', String(raw)),
    reset: () => ipcRenderer.invoke('relay:reset'),
    onLog: (fn) => ipcRenderer.on('relay:log', (_e, entry) => fn(entry)),
});
