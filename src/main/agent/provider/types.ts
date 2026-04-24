import { EventEmitter } from 'node:events'
import type {
  ChatAttachment,
  ProviderApprovalDecision,
  ProviderId,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderSummary,
  RespondToUserInputInput,
  RuntimeMode
} from '../../../shared/agent'

export interface StartSessionInput {
  threadId: string
  cwd?: string
  model?: string
  runtimeMode: RuntimeMode
  resumeCursor?: unknown
}

export interface SendTurnInput {
  threadId: string
  input: string
  attachments?: ChatAttachment[]
  model?: string
}

export interface GenerateThreadTitleInput {
  cwd?: string
  input: string
  model?: string
  useStructuredOutput?: boolean
}

export interface ProviderAdapter {
  readonly id: ProviderId
  readonly supportsStructuredOutput: boolean
  getSummary(): Promise<ProviderSummary>
  startSession(input: StartSessionInput): Promise<ProviderSession>
  sendTurn(input: SendTurnInput): Promise<{ turnId: string; resumeCursor?: unknown }>
  generateThreadTitle(input: GenerateThreadTitleInput): Promise<string | null>
  rollbackConversation(input: { threadId: string; numTurns: number }): Promise<void>
  interruptTurn(input: { threadId: string; turnId?: string }): Promise<void>
  respondToApproval(input: {
    threadId: string
    requestId: string
    decision: ProviderApprovalDecision
  }): Promise<void>
  respondToUserInput(input: RespondToUserInputInput): Promise<void>
  stopSession(input: { threadId: string }): Promise<void>
  readThread(input: { threadId: string }): Promise<unknown>
  streamEvents(listener: (event: ProviderRuntimeEvent) => void): () => void
}

export class ProviderEventBus {
  private readonly emitter = new EventEmitter()

  emit(event: ProviderRuntimeEvent): void {
    this.emitter.emit('event', event)
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function createEventId(prefix = 'evt'): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
}
