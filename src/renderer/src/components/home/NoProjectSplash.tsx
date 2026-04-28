import type { ProviderSummary } from '../../../../shared/agent'

function sortProviders(rows: ProviderSummary[]): ProviderSummary[] {
  const rank = (id: string): number => (id === 'codex' ? 0 : id === 'opencode' ? 1 : 99)
  return [...rows].sort((a, b) => rank(a.id) - rank(b.id))
}

function providerStateLabel(provider: ProviderSummary): string {
  switch (provider.status) {
    case 'available':
      return 'Ready'
    case 'missing':
      return 'Missing'
    case 'error':
    default:
      return 'Error'
  }
}

function formatProviderDetail(provider: ProviderSummary): string | null {
  const detail = provider.detail?.trim()
  if (!detail) return null
  return detail
}

export function NoProjectSplash({
  providers,
  errorMessage,
  mode = 'welcome'
}: {
  providers: ProviderSummary[] | null
  errorMessage: string | null
  mode?: 'welcome' | 'empty-chat'
}): React.JSX.Element {
  const ordered = providers === null ? null : sortProviders(providers)
  const isEmptyChat = mode === 'empty-chat'

  return (
    <div
      className={`no-project-splash${isEmptyChat ? ' no-project-splash--empty-chat' : ''}`}
      role="region"
      aria-label={isEmptyChat ? 'Connected providers' : 'Welcome'}
    >
      {!isEmptyChat ? (
        <div className="no-project-splash-brand" aria-hidden="true">
          Cobel
        </div>
      ) : null}
      <section className="no-project-splash-providers" aria-label="AI providers">
        {errorMessage ? (
          <p className="no-project-splash-error">{errorMessage}</p>
        ) : ordered === null ? (
          <p className="no-project-splash-muted">Checking providers…</p>
        ) : ordered.length === 0 ? (
          <p className="no-project-splash-muted">No CLI providers were discovered yet.</p>
        ) : (
          <ul className="no-project-splash-list">
            {ordered.map((p) => {
              const detail = formatProviderDetail(p)
              return (
              <li key={p.id} className="no-project-splash-row">
                <span className="no-project-splash-name">{p.name}</span>
                <span className={`no-project-splash-status no-project-splash-status--${p.status}`}>
                  {providerStateLabel(p)}
                </span>
                {detail ? (
                  <span className="no-project-splash-detail">{detail}</span>
                ) : null}
              </li>
            )})}
          </ul>
        )}
      </section>
    </div>
  )
}
