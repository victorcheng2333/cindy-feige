import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, Snapshot } from './model';
const bridge: Bridge = {
  command: command => ipcRenderer.invoke('cat:command', command),
  subscribe: listener => {
    const receive = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) => listener(snapshot);
    ipcRenderer.on('cat:state', receive);
    return () => ipcRenderer.removeListener('cat:state', receive);
  },
};
contextBridge.exposeInMainWorld('cat', bridge);
window.addEventListener('DOMContentLoaded', () => ipcRenderer.send('cat:ready'), { once: true });
