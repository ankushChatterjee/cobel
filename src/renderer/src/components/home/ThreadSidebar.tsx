import { KeyboardEvent, PointerEvent } from 'react'
import type { OrchestrationProposedPlan } from '../../../../shared/agent'
import { MarkdownMessage } from './MarkdownMessage'
import { derivePlanTitle } from './threadUtils'
import type { SidebarTabId } from './types'

export function ThreadSidebar({
  open,
  tabs,
  activeTabId,
  onSelectTab,
  onClose,
  resizeLabel,
  resizeMin,
  resizeMax,
  resizeValue,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onResizeKeyDown,
  renderContent
}: {
  open: boolean
  tabs: Array<{ id: SidebarTabId; label: string; plan?: OrchestrationProposedPlan }>
  activeTabId: SidebarTabId
  onSelectTab: (tabId: SidebarTabId) => void
  onClose: () => void
  resizeLabel: string
  resizeMin: number
  resizeMax: number
  resizeValue: number
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void
  onResizeMove: (event: PointerEvent<HTMLDivElement>) => void
  onResizeEnd: (event: PointerEvent<HTMLDivElement>) => void
  onResizeKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  renderContent: (tabId: SidebarTabId) => React.JSX.Element | null
}): React.JSX.Element {
  return (
    <aside className={`diff-review-sidebar thread-sidebar ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div
        className="diff-review-resize-handle"
        role="separator"
        aria-label={resizeLabel}
        aria-orientation="vertical"
        aria-valuemin={resizeMin}
        aria-valuemax={resizeMax}
        aria-valuenow={resizeValue}
        tabIndex={open ? 0 : -1}
        onKeyDown={onResizeKeyDown}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
      />
      <div className="thread-sidebar-tabs" role="tablist" aria-label="Sidebar tabs">
        <div className="thread-sidebar-tab-strip">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className={`thread-sidebar-tab ${tab.id === activeTabId ? 'active' : ''}`}
              aria-selected={tab.id === activeTabId}
              onClick={() => onSelectTab(tab.id)}
              title={tab.label}
            >
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
        <button type="button" className="diff-close-button" onClick={onClose} aria-label="Close sidebar">
          ×
        </button>
      </div>
      <div className="thread-sidebar-content">{renderContent(activeTabId)}</div>
    </aside>
  )
}

export function PlanSidebarPanel({
  plan,
  disabled,
  onImplement
}: {
  plan: OrchestrationProposedPlan
  disabled: boolean
  onImplement: () => void
}): React.JSX.Element {
  return (
    <section className="plan-sidebar-panel">
      <div className="plan-sidebar-header">
        <div>
          <p>Proposed plan</p>
          <h2>{derivePlanTitle(plan.text)}</h2>
        </div>
        <button type="button" className="plan-implement-button" disabled={disabled} onClick={onImplement}>
          Implement
        </button>
      </div>
      <div className="plan-sidebar-body">
        <MarkdownMessage text={plan.text} isStreaming={false} />
      </div>
    </section>
  )
}
