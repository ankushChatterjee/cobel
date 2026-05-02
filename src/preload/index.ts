import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  AgentApi,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationThreadStreamItem
} from '../shared/agent'
import { AGENT_CHANNELS } from '../main/agent/ipc/channels'

const agentApi: AgentApi = {
  dispatchCommand: (input) => ipcRenderer.invoke(AGENT_CHANNELS.dispatchCommand, input),
  interruptTurn: (input) => ipcRenderer.invoke(AGENT_CHANNELS.interruptTurn, input),
  respondToApproval: (input) => ipcRenderer.invoke(AGENT_CHANNELS.respondToApproval, input),
  respondToUserInput: (input) => ipcRenderer.invoke(AGENT_CHANNELS.respondToUserInput, input),
  stopSession: (input) => ipcRenderer.invoke(AGENT_CHANNELS.stopSession, input),
  listProviders: () => ipcRenderer.invoke(AGENT_CHANNELS.listProviders),
  listModelCatalog: () => ipcRenderer.invoke(AGENT_CHANNELS.listModelCatalog),
  clearThread: (input) => ipcRenderer.invoke(AGENT_CHANNELS.clearThread, input),
  getCheckpointDiff: (input) => ipcRenderer.invoke(AGENT_CHANNELS.getCheckpointDiff, input),
  getCheckpointWorktreeDiff: (input) =>
    ipcRenderer.invoke(AGENT_CHANNELS.getCheckpointWorktreeDiff, input),
  getWorkspaceDiff: (input) => ipcRenderer.invoke(AGENT_CHANNELS.getWorkspaceDiff, input),
  openWorkspaceFolder: () => ipcRenderer.invoke(AGENT_CHANNELS.openWorkspaceFolder),
  openAttachmentFiles: () => ipcRenderer.invoke(AGENT_CHANNELS.openAttachmentFiles),
  importAttachmentFiles: (input) => ipcRenderer.invoke(AGENT_CHANNELS.importAttachmentFiles, input),
  revealPath: (input) => ipcRenderer.invoke(AGENT_CHANNELS.revealPath, input),
  appendDebugTrace: (input) => ipcRenderer.invoke(AGENT_CHANNELS.appendDebugTrace, input),
  getShellSnapshot: (): Promise<OrchestrationShellSnapshot> =>
    ipcRenderer.invoke(AGENT_CHANNELS.getShellSnapshot),

  subscribeThread: (input, listener) => {
    let disposed = false
    const subscriptionId = `sub:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
    const channel = AGENT_CHANNELS.threadEvent(subscriptionId)
    const eventListener = (_event: IpcRendererEvent, item: OrchestrationThreadStreamItem): void => {
      listener(item)
    }

    ipcRenderer.on(channel, eventListener)

    ipcRenderer
      .invoke(AGENT_CHANNELS.subscribeThread, { ...input, subscriptionId })
      .then(({ snapshot }: { subscriptionId: string; snapshot: OrchestrationThreadStreamItem }) => {
        if (disposed) {
          void ipcRenderer.invoke(AGENT_CHANNELS.unsubscribeThread, { subscriptionId })
          return
        }
        listener(snapshot)
      })
      .catch((error) => {
        console.error('Failed to subscribe to thread', error)
      })

    return () => {
      disposed = true
      ipcRenderer.removeListener(channel, eventListener)
      void ipcRenderer.invoke(AGENT_CHANNELS.unsubscribeThread, { subscriptionId })
    }
  },

  subscribeShell: (listener) => {
    let disposed = false
    const subscriptionId = `shell:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
    const channel = AGENT_CHANNELS.shellEvent(subscriptionId)
    const eventListener = (_event: IpcRendererEvent, item: OrchestrationShellStreamItem): void => {
      listener(item)
    }

    ipcRenderer.on(channel, eventListener)

    ipcRenderer
      .invoke(AGENT_CHANNELS.subscribeShell, { subscriptionId })
      .then(({ snapshot }: { subscriptionId: string; snapshot: OrchestrationShellSnapshot }) => {
        if (disposed) {
          void ipcRenderer.invoke(AGENT_CHANNELS.unsubscribeShell, { subscriptionId })
          return
        }
        listener({ kind: 'snapshot', snapshot })
      })
      .catch((error) => {
        console.error('Failed to subscribe to shell', error)
      })

    return () => {
      disposed = true
      ipcRenderer.removeListener(channel, eventListener)
      void ipcRenderer.invoke(AGENT_CHANNELS.unsubscribeShell, { subscriptionId })
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('agentApi', agentApi)
  } catch (error) {
    console.error(error)
  }
} else {
  ;(window as unknown as { agentApi: AgentApi }).agentApi = agentApi
}
