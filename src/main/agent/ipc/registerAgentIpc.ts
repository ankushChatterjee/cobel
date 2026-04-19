import {
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
  type WebFrameMain
} from 'electron'
import { basename } from 'node:path'
import type { RespondToApprovalInput, RespondToUserInputInput } from '../../../shared/agent'
import type { AgentBackend } from '../AgentBackend'
import { AGENT_CHANNELS } from './channels'

const subscriptions = new Map<string, () => void>()
const webContentsSubscriptions = new WeakMap<WebContents, Set<string>>()
const subscriptionWebContents = new Map<string, WebContents>()

export function registerAgentIpc(backend: AgentBackend): void {
  removeAgentIpcHandlers()

  ipcMain.handle(AGENT_CHANNELS.dispatchCommand, async (event, input) => {
    validateSender(event)
    return backend.dispatchCommand(input)
  })

  ipcMain.handle(AGENT_CHANNELS.listProviders, async (event) => {
    validateSender(event)
    return backend.listProviders()
  })

  ipcMain.handle(AGENT_CHANNELS.clearThread, async (event, input) => {
    validateSender(event)
    assertThreadInput(input)
    await backend.clearThread(input)
  })

  ipcMain.handle(AGENT_CHANNELS.openWorkspaceFolder, async (event) => {
    validateSender(event)
    const result = await dialog.showOpenDialog({
      title: 'Open workspace folder',
      properties: ['openDirectory', 'createDirectory']
    })
    const path = result.filePaths[0]
    return result.canceled || !path ? null : { path, name: basename(path) }
  })

  ipcMain.handle(AGENT_CHANNELS.revealPath, async (event, input: { path?: unknown }) => {
    validateSender(event)
    if (!input || typeof input.path !== 'string' || input.path.trim().length === 0) {
      throw new Error('path is required.')
    }
    const error = await shell.openPath(input.path)
    if (error) throw new Error(error)
  })

  ipcMain.handle(
    AGENT_CHANNELS.subscribeThread,
    async (event, input: { threadId?: unknown; subscriptionId?: unknown }) => {
      validateSender(event)
      if (!input || typeof input.threadId !== 'string') throw new Error('threadId is required.')
      if (typeof input.subscriptionId !== 'string') {
        throw new Error('subscriptionId is required.')
      }
      const { subscriptionId } = input
      const webContents = event.sender
      disposeSubscription(subscriptionId)
      let skippedInitialSnapshot = false
      const unsubscribe = backend.subscribeThread({ threadId: input.threadId }, (item) => {
        if (!skippedInitialSnapshot && item.kind === 'snapshot') {
          skippedInitialSnapshot = true
          return
        }
        if (!webContents.isDestroyed())
          webContents.send(AGENT_CHANNELS.threadEvent(subscriptionId), item)
      })
      subscriptions.set(subscriptionId, unsubscribe)
      trackWebContentsSubscription(webContents, subscriptionId)
      return { subscriptionId, snapshot: backend.getThreadSnapshot(input.threadId) }
    }
  )

  ipcMain.handle(
    AGENT_CHANNELS.unsubscribeThread,
    async (event, input: { subscriptionId?: unknown }) => {
      validateSender(event)
      if (!input || typeof input.subscriptionId !== 'string') return
      disposeSubscription(input.subscriptionId)
    }
  )

  ipcMain.handle(AGENT_CHANNELS.interruptTurn, async (event, input) => {
    validateSender(event)
    assertThreadInput(input)
    await backend.interruptTurn(input)
  })

  ipcMain.handle(AGENT_CHANNELS.respondToApproval, async (event, input) => {
    validateSender(event)
    assertThreadInput(input)
    if (typeof input.requestId !== 'string') throw new Error('requestId is required.')
    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(String(input.decision))) {
      throw new Error('decision is invalid.')
    }
    await backend.respondToApproval(input as unknown as RespondToApprovalInput)
  })

  ipcMain.handle(AGENT_CHANNELS.respondToUserInput, async (event, input) => {
    validateSender(event)
    assertThreadInput(input)
    if (typeof input.requestId !== 'string') throw new Error('requestId is required.')
    if (!input.answers || typeof input.answers !== 'object')
      throw new Error('answers are required.')
    await backend.respondToUserInput(input as unknown as RespondToUserInputInput)
  })

  ipcMain.handle(AGENT_CHANNELS.stopSession, async (event, input) => {
    validateSender(event)
    assertThreadInput(input)
    await backend.stopSession(input)
  })
}

export function validateSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedFrame(event.senderFrame)) throw new Error('Untrusted IPC sender.')
}

export function isTrustedFrame(frame: WebFrameMain | null): boolean {
  if (!frame) return false
  try {
    const url = new URL(frame.url)
    if (url.protocol === 'file:') return true
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    }
    return false
  } catch {
    return false
  }
}

export function disposeAllAgentIpcSubscriptions(): void {
  for (const subscriptionId of subscriptions.keys()) disposeSubscription(subscriptionId)
}

export function removeAgentIpcHandlers(): void {
  ipcMain.removeHandler(AGENT_CHANNELS.dispatchCommand)
  ipcMain.removeHandler(AGENT_CHANNELS.listProviders)
  ipcMain.removeHandler(AGENT_CHANNELS.clearThread)
  ipcMain.removeHandler(AGENT_CHANNELS.openWorkspaceFolder)
  ipcMain.removeHandler(AGENT_CHANNELS.revealPath)
  ipcMain.removeHandler(AGENT_CHANNELS.subscribeThread)
  ipcMain.removeHandler(AGENT_CHANNELS.unsubscribeThread)
  ipcMain.removeHandler(AGENT_CHANNELS.interruptTurn)
  ipcMain.removeHandler(AGENT_CHANNELS.respondToApproval)
  ipcMain.removeHandler(AGENT_CHANNELS.respondToUserInput)
  ipcMain.removeHandler(AGENT_CHANNELS.stopSession)
}

function disposeSubscription(subscriptionId: string): void {
  const unsubscribe = subscriptions.get(subscriptionId)
  if (!unsubscribe) return
  unsubscribe()
  subscriptions.delete(subscriptionId)
  const webContents = subscriptionWebContents.get(subscriptionId)
  const subscriptionIds = webContents ? webContentsSubscriptions.get(webContents) : undefined
  subscriptionIds?.delete(subscriptionId)
  subscriptionWebContents.delete(subscriptionId)
}

function trackWebContentsSubscription(webContents: WebContents, subscriptionId: string): void {
  subscriptionWebContents.set(subscriptionId, webContents)
  const existing = webContentsSubscriptions.get(webContents)
  if (existing) {
    existing.add(subscriptionId)
    return
  }

  const subscriptionIds = new Set([subscriptionId])
  webContentsSubscriptions.set(webContents, subscriptionIds)
  webContents.once('destroyed', () => {
    for (const id of subscriptionIds) disposeSubscription(id)
    subscriptionIds.clear()
  })
}

function assertThreadInput(
  input: unknown
): asserts input is { threadId: string; [key: string]: unknown } {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof (input as { threadId?: unknown }).threadId !== 'string'
  ) {
    throw new Error('threadId is required.')
  }
}
