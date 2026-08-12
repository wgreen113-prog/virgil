const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('virgil', {
  getVersion:   () => ipcRenderer.invoke('get-app-version'),
  minimize:     () => ipcRenderer.invoke('window-minimize'),
  maximize:     () => ipcRenderer.invoke('window-maximize'),
  close:        () => ipcRenderer.invoke('window-close'),
  pickFiles:    () => ipcRenderer.invoke('pick-files'),
  pickOutput:   () => ipcRenderer.invoke('pick-output'),
  openFolder:   (p) => ipcRenderer.invoke('open-folder', p),
  getDefaultOutput: () => ipcRenderer.invoke('get-default-output'),
  checkTools:   () => ipcRenderer.invoke('check-tools'),
  detectSystem: () => ipcRenderer.invoke('detect-system'),
  installTools: () => ipcRenderer.invoke('install-tools'),
  processVideo: (opts) => ipcRenderer.invoke('process-video', opts),
  remergeAudio: (opts) => ipcRenderer.invoke('remerge-audio', opts),
  cancelProcess: () => ipcRenderer.invoke('cancel-process'),
  probeTracks:  (filePath) => ipcRenderer.invoke('probe-tracks', filePath),
  onInstallProgress: (cb) => ipcRenderer.on('install-progress', (_, d) => cb(d)),
  onProcessProgress: (cb) => ipcRenderer.on('process-progress', (_, d) => cb(d)),
  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch)
})
