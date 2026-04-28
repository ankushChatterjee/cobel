import { EventEmitter } from 'node:events'
import type {
  ModelCatalog,
  ModelInfo,
  ProviderId,
  ProviderRuntimeEvent,
  ProviderSummary,
  RespondToApprovalInput,
  RespondToUserInputInput,
  StopSessionInput
} from '../../../shared/agent'
import type {
  GenerateThreadTitleInput,
  ProviderAdapter,
  SendTurnInput,
  StartSessionInput
} from './types'

export class ProviderService {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>()
  private readonly emitter = new EventEmitter()
  private readonly unsubscribers: Array<() => void> = []
  private readonly providerSummaries = new Map<ProviderId, ProviderSummary>()
  private initializationPromise: Promise<void> | null = null

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter)
    this.unsubscribers.push(adapter.streamEvents((event) => this.emitter.emit('event', event)))
  }

  async initialize(): Promise<void> {
    if (this.initializationPromise) return this.initializationPromise
    this.initializationPromise = Promise.all(
      [...this.adapters.values()].map(async (adapter) => {
        const summary = await this.resolveAdapterSummary(adapter)
        this.providerSummaries.set(adapter.id, summary)
      })
    ).then(() => undefined)
    return this.initializationPromise
  }

  async listProviders(): Promise<ProviderSummary[]> {
    await this.initialize()
    return [...this.adapters.keys()]
      .map((id) => this.providerSummaries.get(id))
      .filter((summary): summary is ProviderSummary => Boolean(summary))
  }

  async listModels(provider: ProviderId): Promise<ModelInfo[]> {
    await this.initialize()
    const adapter = this.adapters.get(provider)
    if (!adapter) return []
    const summary = this.providerSummaries.get(provider)
    if (summary && summary.status !== 'available') return []
    const maybeListModels = (adapter as unknown as { listModels?: () => Promise<ModelInfo[]> })
      .listModels
    if (typeof maybeListModels !== 'function') return []
    try {
      return await maybeListModels.call(adapter)
    } catch {
      return []
    }
  }

  async listModelCatalog(): Promise<ModelCatalog> {
    const providers = await this.listProviders()
    const entries = await Promise.all(
      [...this.adapters.keys()].map(async (id) => {
        const models = await this.listModels(id)
        return [id, models] as const
      })
    )
    const modelsByProvider: Partial<Record<ProviderId, ModelInfo[]>> = {}
    for (const [id, models] of entries) {
      modelsByProvider[id] = models
    }
    return { providers, modelsByProvider }
  }

  async startSession(input: StartSessionInput & { provider: ProviderId }): Promise<unknown> {
    return this.getAdapter(input.provider).startSession(input)
  }

  async sendTurn(
    input: SendTurnInput & { provider: ProviderId }
  ): Promise<{ turnId: string; resumeCursor?: unknown }> {
    return this.getAdapter(input.provider).sendTurn(input)
  }

  async generateThreadTitle(
    input: GenerateThreadTitleInput & { provider: ProviderId }
  ): Promise<string | null> {
    const adapter = this.getAdapter(input.provider)
    return adapter.generateThreadTitle({
      ...input,
      useStructuredOutput: adapter.supportsStructuredOutput
    })
  }

  async interruptTurn(
    provider: ProviderId,
    input: { threadId: string; turnId?: string }
  ): Promise<void> {
    await this.getAdapter(provider).interruptTurn(input)
  }

  async rollbackConversation(
    provider: ProviderId,
    input: { threadId: string; numTurns: number }
  ): Promise<void> {
    await this.getAdapter(provider).rollbackConversation(input)
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

  /** Closes all OpenCode child processes (used on app quit). */
  async disposeOpenCodeSessions(): Promise<void> {
    const openCode = this.adapters.get('opencode') as
      | { disposeAllSessions?: () => Promise<void> }
      | undefined
    if (openCode && typeof openCode.disposeAllSessions === 'function') {
      await openCode.disposeAllSessions()
    }
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    this.emitter.removeAllListeners()
  }

  private async resolveAdapterSummary(adapter: ProviderAdapter): Promise<ProviderSummary> {
    try {
      return await adapter.resolveCLI()
    } catch (error) {
      return {
        id: adapter.id,
        name: adapter.id === 'opencode' ? 'OpenCode' : 'Codex',
        status: 'error',
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private getAdapter(provider: ProviderId): ProviderAdapter {
    const adapter = this.adapters.get(provider)
    if (!adapter) throw new Error(`Provider is not registered: ${provider}`)
    return adapter
  }
}
