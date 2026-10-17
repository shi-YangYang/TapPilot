const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tapPilot', Object.freeze({
  state: () => ipcRenderer.invoke('tappilot:state'),
  saveConfig: value => ipcRenderer.invoke('tappilot:save-config', value),
  testModel: () => ipcRenderer.invoke('tappilot:test-model'),
  setImprovement: value => ipcRenderer.invoke('tappilot:improvement-set', value),
  rollbackImprovement: () => ipcRenderer.invoke('tappilot:improvement-rollback'),
  devices: () => ipcRenderer.invoke('tappilot:devices'),
  wirelessInterfaces: () => ipcRenderer.invoke('tappilot:wireless-interfaces'),
  wirelessStart: value => ipcRenderer.invoke('tappilot:wireless-start', value),
  wirelessClose: () => ipcRenderer.invoke('tappilot:wireless-close'),
  wirelessCopy: () => ipcRenderer.invoke('tappilot:wireless-copy'),
  run: value => ipcRenderer.invoke('tappilot:run', value),
  demo: () => ipcRenderer.invoke('tappilot:demo'),
  cancel: () => ipcRenderer.invoke('tappilot:cancel'),
  emergencyStop: value => ipcRenderer.invoke('tappilot:emergency-stop', value),
  onEvent: listener => {
    if (typeof listener !== 'function') throw new TypeError('listener');
    const wrapped = (_event, value) => listener(value);
    ipcRenderer.on('tappilot:event', wrapped);
    return () => ipcRenderer.removeListener('tappilot:event', wrapped);
  }
}));
