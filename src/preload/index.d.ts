import type { AgentApi } from '../shared/agent'

declare global {
  interface Window {
    agentApi: AgentApi
  }
}
