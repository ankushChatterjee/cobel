import { KeyboardEvent, PointerEvent, useState } from 'react'
import { Folder, FolderOpen, Plus, Trash2 } from 'lucide-react'
import type { OrchestrationShellSnapshot, ProjectSummary, ThreadShellSummary } from '../../../../shared/agent'
import { formatThreadLastUsed, formatTime } from './formatUtils'
import { minSidebarWidth, maxSidebarWidth } from './storage'
import { threadsForProject } from './threadUtils'
import type { ActiveSelection } from './types'

const INITIAL_VISIBLE_THREADS = 7

export function ProjectSidebar({
  shell,
  selection,
  openProjectIds,
  sidebarWidth,
  onAddProject,
  onSelectProject,
  onSelectChat,
  onDeleteChat,
  onNewChat,
  onResizeKeyDown,
  onResizeStart,
  onResizeMove,
  onResizeEnd
}: {
  shell: OrchestrationShellSnapshot
  selection: ActiveSelection
  openProjectIds: Set<string>
  sidebarWidth: number
  onAddProject: () => void
  onSelectProject: (project: ProjectSummary) => void
  onSelectChat: (chat: ThreadShellSummary) => void
  onDeleteChat: (chat: ThreadShellSummary) => void
  onNewChat: (project: ProjectSummary) => void
  onResizeKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void
  onResizeMove: (event: PointerEvent<HTMLDivElement>) => void
  onResizeEnd: (event: PointerEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set())

  return (
    <aside className="project-sidebar" aria-label="Projects">
      <div className="sidebar-header">
        <div className="sidebar-app-name">Cobel</div>
        <button
          type="button"
          className="add-project-button"
          title="Add project"
          aria-label="Add project"
          onClick={onAddProject}
        >
          <Plus size={13} strokeWidth={2} />
        </button>
      </div>

      <div className="sidebar-scroll">
        {shell.projects.length === 0 ? (
          <div className="sidebar-empty" aria-label="No projects open">
            <p>No projects open</p>
          </div>
        ) : (
          <nav className="project-list" aria-label="Project list">
            {shell.projects.map((project) => {
              const threads = threadsForProject(shell, project.id)
              const isOpen = openProjectIds.has(project.id)
              const isActive = project.id === selection.activeProjectId
              const activeChat = shell.threads.find(
                (t) => t.projectId === selection.activeProjectId && t.id === selection.activeChatId
              )
              const newestThreads = threads.slice(0, INITIAL_VISIBLE_THREADS)
              const activeChatOutsideInitialThreads =
                activeChat?.projectId === project.id &&
                !newestThreads.some((thread) => thread.id === activeChat.id)
              const showAllThreads =
                expandedProjectIds.has(project.id) || activeChatOutsideInitialThreads
              const visibleThreads = showAllThreads
                ? threads
                : threads.slice(0, INITIAL_VISIBLE_THREADS)
              const shouldShowMoreButton = !showAllThreads && threads.length > INITIAL_VISIBLE_THREADS
              return (
                <section key={project.id} className="project-group">
                  <div className="project-row">
                    <button
                      type="button"
                      className={`project-toggle ${isActive ? 'active' : ''}`}
                      aria-expanded={isOpen}
                      onClick={() => onSelectProject(project)}
                    >
                      {isOpen ? (
                        <FolderOpen size={13} strokeWidth={2} />
                      ) : (
                        <Folder size={13} strokeWidth={2} />
                      )}
                      <span className="project-name">{project.name}</span>
                    </button>
                    <button
                      type="button"
                      className="project-new-thread"
                      onClick={() => onNewChat(project)}
                      title="New thread"
                      aria-label="New thread"
                    >
                      +
                    </button>
                  </div>
                  {isOpen ? (
                    <div className="thread-list">
                      {visibleThreads.map((chat) => (
                        <div
                          key={chat.id}
                          className={`thread-row ${chat.id === activeChat?.id ? 'active' : ''}`}
                        >
                          <button
                            type="button"
                            className="thread-link"
                            onClick={() => onSelectChat(chat)}
                          >
                            <span className="thread-dot" />
                            <span className="thread-label">{chat.title}</span>
                            <span
                              className="thread-used-at"
                              title={`Last used ${formatTime(chat.updatedAt)}`}
                            >
                              {formatThreadLastUsed(chat.updatedAt)}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="thread-delete-button"
                            title={`Delete ${chat.title}`}
                            aria-label={`Delete ${chat.title}`}
                            onClick={() => onDeleteChat(chat)}
                          >
                            <Trash2 size={12} strokeWidth={1.9} />
                          </button>
                        </div>
                      ))}
                      {shouldShowMoreButton ? (
                        <button
                          type="button"
                          className="thread-show-more-button"
                          onClick={() =>
                            setExpandedProjectIds((current) => new Set(current).add(project.id))
                          }
                        >
                          Show More
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              )
            })}
          </nav>
        )}
      </div>
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={minSidebarWidth}
        aria-valuemax={maxSidebarWidth}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onKeyDown={onResizeKeyDown}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
      />
    </aside>
  )
}
