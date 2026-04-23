import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { OrchestrationCheckpointSummary } from '../../../../shared/agent'

interface DiffTurnPagerProps {
  summaries: OrchestrationCheckpointSummary[]
  selectedTurn: OrchestrationCheckpointSummary | null
  latest: OrchestrationCheckpointSummary | null
  onSelectTurn: (turnId: string | null) => void
}

export function DiffTurnPager({
  summaries,
  selectedTurn,
  latest,
  onSelectTurn
}: DiffTurnPagerProps): React.JSX.Element {
  const selectedTurnIndex = selectedTurn
    ? summaries.findIndex((summary) => summary.turnId === selectedTurn.turnId)
    : -1
  const previousTurn = selectedTurnIndex > 0 ? summaries[selectedTurnIndex - 1] : null
  const nextTurn =
    selectedTurnIndex >= 0 && selectedTurnIndex < summaries.length - 1
      ? summaries[selectedTurnIndex + 1]
      : null
  const label =
    selectedTurn && selectedTurn === latest
      ? `Latest turn, turn ${selectedTurn.checkpointTurnCount}`
      : selectedTurn
        ? `Turn ${selectedTurn.checkpointTurnCount}`
        : 'Select turn'

  return (
    <div className="diff-turn-pager" aria-label={label}>
      <button
        type="button"
        className="diff-turn-page-button"
        onClick={() => {
          if (previousTurn) onSelectTurn(previousTurn.turnId)
        }}
        disabled={!previousTurn}
        aria-label="Previous turn"
        title="Previous turn"
      >
        <ChevronLeft size={12} strokeWidth={1.9} aria-hidden="true" />
      </button>
      <span className="diff-turn-page-number" aria-hidden="true">
        {selectedTurn?.checkpointTurnCount ?? summaries.length}
      </span>
      <button
        type="button"
        className="diff-turn-page-button"
        onClick={() => {
          if (nextTurn) onSelectTurn(nextTurn.turnId)
        }}
        disabled={!nextTurn}
        aria-label="Next turn"
        title="Next turn"
      >
        <ChevronRight size={12} strokeWidth={1.9} aria-hidden="true" />
      </button>
    </div>
  )
}
