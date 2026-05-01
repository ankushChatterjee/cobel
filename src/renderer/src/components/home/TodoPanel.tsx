import { ListTodo } from 'lucide-react'
import type { OrchestrationTodoList } from '../../../../shared/agent'
import { todoProgressForLists } from './threadUtils'

type FlattenedTodoItem = {
  key: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  listIndex: number
  order: number
}

function flattenTodoLists(todoLists: OrchestrationTodoList[]): FlattenedTodoItem[] {
  return todoLists
    .flatMap((todoList, listIndex) =>
      todoList.items.map((item) => ({
        key: `${todoList.id}:${item.id}`,
        text: item.text,
        status: item.status,
        listIndex,
        order: item.order
      }))
    )
    .sort((left, right) => {
      if (left.status === right.status) {
        if (left.listIndex === right.listIndex) return left.order - right.order
        return left.listIndex - right.listIndex
      }
      if (left.status === 'completed') return 1
      if (right.status === 'completed') return -1
      if (left.status === 'in_progress') return -1
      if (right.status === 'in_progress') return 1
      if (left.listIndex === right.listIndex) return left.order - right.order
      return left.listIndex - right.listIndex
    })
}

export function FloatingTodoPill({
  todoLists,
  open,
  onToggle
}: {
  todoLists: OrchestrationTodoList[]
  open: boolean
  onToggle: () => void
}): React.JSX.Element | null {
  const progress = todoProgressForLists(todoLists)

  return (
    <button
      type="button"
      className={`floating-todo-pill${open ? ' active' : ''}`}
      hidden={progress.total === 0}
      disabled={progress.total === 0}
      aria-hidden={progress.total === 0}
      onClick={onToggle}
      aria-label={open ? 'Close todo list' : 'Open todo list'}
      title={open ? 'Close todo list' : 'Open todo list'}
    >
      <ListTodo size={13} strokeWidth={1.9} aria-hidden="true" />
      <span>{progress.completed}</span>
      <span className="floating-todo-pill-separator" aria-hidden="true">
        /
      </span>
      <span>{progress.total}</span>
    </button>
  )
}

export function FloatingTodoPanel({
  todoLists,
  open
}: {
  todoLists: OrchestrationTodoList[]
  open: boolean
}): React.JSX.Element | null {
  const progress = todoProgressForLists(todoLists)
  const items = flattenTodoLists(todoLists)

  return (
    <section
      className="floating-todo-panel"
      aria-label="Todo list"
      hidden={!open || progress.total === 0}
      aria-hidden={!open || progress.total === 0}
    >
      <header className="floating-todo-panel-header">
        <h2>todo</h2>
        <span className="floating-todo-panel-count">
          {progress.completed} / {progress.total}
        </span>
      </header>
      <ul className="floating-todo-items">
        {items.map((item) => (
          <li key={item.key} className={`floating-todo-item status-${item.status}`}>
            <span className="floating-todo-item-marker" aria-hidden="true" />
            <span className="floating-todo-item-text">{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
