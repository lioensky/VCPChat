const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // A generic file reader
  readFile: (relativePath) => ipcRenderer.invoke('fs:readFile', relativePath),
  
  // A generic directory lister
  listDir: (relativePath) => ipcRenderer.invoke('fs:listDir', relativePath),

  // A generic file writer
  writeFile: (relativePath, content) => ipcRenderer.invoke('fs:writeFile', relativePath, content),

  // Ensure a directory exists (create if missing)
  ensureDir: (relativePath) => ipcRenderer.invoke('fs:ensureDir', relativePath),

  // A more specific, combined data fetcher for efficiency
  getVChatData: () => ipcRenderer.invoke('vchat:getData')
});