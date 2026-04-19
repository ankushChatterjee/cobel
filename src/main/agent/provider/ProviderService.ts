import { EventEmitter } from 'node:events'
import type {
  ProviderId,
  ProviderRuntimeEvent,
  ProviderSummary,
  RespondToApprovalInput,
  RespondToUserInputInput,
  StopSessionInput
} from '../../../shared/agent'
import type { ProviderAdapter, SendTurnInput, StartSessionInput } from './types'
import type { ModelInfo } from './codex/codex-api-types'

export class ProviderService {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>()
  private readonly emitter = new EventEmitter()
  private readonly unsubscribers: Array<() => void> = []

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter)
    this.unsubscribers.push(adapter.streamEvents((event) => this.emitter.emit('event', event)))
  }

  async listProviders(): Promise<ProviderSummary[]> {
    const summaries = await Promise.all(
      [...this.adapters.values()].map((adapter) => adapter.getSummary())
    )
    return summaries
  }

  async listModels(provider: ProviderId): Promise<ModelInfo[]> {
    const adapter = this.adapters.get(provider)
    if (!adapter) return []
    const maybeListModels = (adapter as unknown as { listModels?: () => Promise<ModelInfo[]> })
      .listModels
    if (typeof maybeListModels !== 'function') return []
    return maybeListModels.call(adapter)
  }

  async startSession(input: StartSessionInput & { provider: ProviderId }): Promise<unknown> {
    return this.getAdapter(input.provider).startSession(input)
  }

  async sendTurn(
    input: SendTurnInput & { provider: ProviderId }
  ): Promise<{ turnId: string; resumeCursor?: unknown }> {
    return this.getAdapter(input.provider).sendTurn(input)
  }

  async interruptTurn(
    provider: ProviderId,
    input: { threadId: string; turnId?: string }
  ): Promise<void> {
    await this.getAdapter(provider).interruptTurn(input)
  }

  async respondToApproval(provider: ProviderId, input: RespondToApprovalInput): Promise<void> {
    await this.getAdapter(provider).respondToApproval(input)
  }

  async respondToUserInput(provider: ProviderId, input: RespondToUserInputInput): Promise<void> {
    await this.getAdapter(provider).respondToUserInput(input)
  }

  async stopSession(provider: ProviderId, input: StopSessionInput): Promise<void> {
    await this.getAdapter(provider).stopSession(input)
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    this.emitter.removeAllListeners()
  }

  private getAdapter(provider: ProviderId): ProviderAdapter {
    const adapter = this.adapters.get(provider)
    if (!adapter) throw new Error(`Provider is not registered: ${provider}`)
    return adapter
  }
}
