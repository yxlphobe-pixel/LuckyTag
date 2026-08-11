import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type DashboardSnapshot, type LuckyTagApi } from '@shared/contracts'

const api: LuckyTagApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot),
  saveConfig: (config) => ipcRenderer.invoke(IPC_CHANNELS.saveConfig, config),
  saveAgentConfiguration: (input) => ipcRenderer.invoke(IPC_CHANNELS.saveAgentConfiguration, input),
  probeAgentRuntime: (runtime) => ipcRenderer.invoke(IPC_CHANNELS.probeAgentRuntime, runtime),
  testAgentConfiguration: () => ipcRenderer.invoke(IPC_CHANNELS.testAgentConfiguration),
  chooseLocalFolder: () => ipcRenderer.invoke(IPC_CHANNELS.chooseLocalFolder),
  syncKnowledge: () => ipcRenderer.invoke(IPC_CHANNELS.syncKnowledge),
  probeConnections: () => ipcRenderer.invoke(IPC_CHANNELS.probeConnections),
  authenticate: (kind) => ipcRenderer.invoke(IPC_CHANNELS.authenticate, kind),
  disconnectOpenAuth: () => ipcRenderer.invoke(IPC_CHANNELS.disconnectOpenAuth),
  startWorker: () => ipcRenderer.invoke(IPC_CHANNELS.startWorker),
  stopWorker: () => ipcRenderer.invoke(IPC_CHANNELS.stopWorker),
  runOnce: () => ipcRenderer.invoke(IPC_CHANNELS.runOnce),
  previewDimaRequirement: (input) => ipcRenderer.invoke(IPC_CHANNELS.previewDimaRequirement, input),
  createDimaRequirement: (input) => ipcRenderer.invoke(IPC_CHANNELS.createDimaRequirement, input),
  openDimaRequirement: (url) => ipcRenderer.invoke(IPC_CHANNELS.openDimaRequirement, url),
  revealRuntimeFolder: () => ipcRenderer.invoke(IPC_CHANNELS.revealRuntimeFolder),
  onSnapshotUpdated: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: DashboardSnapshot): void => callback(snapshot)
    ipcRenderer.on(IPC_CHANNELS.snapshotUpdated, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.snapshotUpdated, listener)
  }
}

contextBridge.exposeInMainWorld('luckyTag', Object.freeze(api))
