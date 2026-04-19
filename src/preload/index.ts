import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { AgentApi, OrchestrationThreadStreamItem } from '../shared/agent'
import { AGENT_CHANNELS } from '../main/agent/ipc/channels'

const agentApi: AgentApi = {
  dispatchCommand: (input) => ipcRenderer.invoke(AGENT_CHANNELS.dispatchCommand, input),
  interruptTurn: (input) => ipcRenderer.invoke(AGENT_CHANNELS.interruptTurn, input),
  respondToApproval: (input) => ipcRenderer.invoke(AGENT_CHANNELS.respondToApproval, input),
  respondToUserInput: (input) => ipcRenderer.invoke(AGENT_CHANNELS.respondToUserInput, input),
  stopSession: (input) => ipcRenderer.invoke(AGENT_CHANNELS.stopSession, input),
  listProviders: () => ipcRenderer.invoke(AGENT_CHANNELS.listProviders),
  clearThread: (input) => ipcRenderer.invoke(AGENT_CHANNELS.clearThread, input),
  openWorkspaceFolder: () => ipcRenderer.invoke(AGENT_CHANNELS.openWorkspaceFolder),
  revealPath: (input) => ipcRenderer.invoke(AGENT_CHANNELS.revealPath, input),
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
      .then(
        ({
          snapshot
        }: {
          subscriptionId: string
          snapshot: OrchestrationThreadStreamItem
        }) => {
          if (disposed) {
            void ipcRenderer.invoke(AGENT_CHANNELS.unsubscribeThread, { subscriptionId })
            return
          }
          listener(snapshot)
        }
      )
      .catch((error) => {
        console.error('Failed to subscribe to thread', error)
      })

    return () => {
      disposed = true
      ipcRenderer.removeListener(channel, eventListener)
      void ipcRenderer.invoke(AGENT_CHANNELS.unsubscribeThread, { subscriptionId })
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
