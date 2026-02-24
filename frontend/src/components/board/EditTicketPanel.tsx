import { useEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import {
  useAddTicketCommentMutation,
  useTicketDocsQuery,
  useTicketCommentsQuery,
  useTicketEventsQuery,
} from '@/hooks/api'
import type { Ticket, TicketComment, TicketEvent, TicketPriority, UpdateTicketRequest } from '@/api/types'

type EditTicketPanelProps = {
  open: boolean
  ticket: Ticket | null
  assigneeOptions: string[]
  priorityOptions: TicketPriority[]
  isPending: boolean
  onClose: () => void
  onSubmit: (payload: { ticketId: number; input: UpdateTicketRequest }) => Promise<void>
}

type ValidationErrors = {
  title?: string
  description?: string
}

const DEFAULT_PRIORITIES: TicketPriority[] = ['Critical', 'High', 'Medium', 'Low']
const COMMENT_MAX_LENGTH = 5000
const DRAWER_WIDTH_STORAGE_KEY = 'oc:ticket-drawer-width'
const DRAWER_WIDTH_MIN = 420
const DRAWER_WIDTH_MAX = 960
const DRAWER_WIDTH_DEFAULT = 544

export function EditTicketPanel({
  open,
  ticket,
  assigneeOptions,
  priorityOptions,
  isPending,
  onClose,
  onSubmit,
}: EditTicketPanelProps) {
  if (!open || !ticket) {
    return null
  }

  const priorities = priorityOptions.length > 0 ? priorityOptions : DEFAULT_PRIORITIES
  const normalizedAssignees = assigneeOptions.length > 0 ? assigneeOptions : ['Unassigned']
  const initialAssignee = normalizedAssignees.includes(ticket.assignee) ? ticket.assignee : normalizedAssignees[0]
  const initialPriority = priorities.includes(ticket.priority) ? ticket.priority : priorities[0]

  return (
    <EditTicketPanelForm
      key={`${ticket.id}:${ticket.updated_at}`}
      ticket={ticket}
      priorities={priorities}
      assignees={normalizedAssignees}
      initialAssignee={initialAssignee}
      initialPriority={initialPriority}
      isPending={isPending}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  )
}

type EditTicketPanelFormProps = {
  ticket: Ticket
  priorities: TicketPriority[]
  assignees: string[]
  initialAssignee: string
  initialPriority: TicketPriority
  isPending: boolean
  onClose: () => void
  onSubmit: (payload: { ticketId: number; input: UpdateTicketRequest }) => Promise<void>
}

function EditTicketPanelForm({
  ticket,
  priorities,
  assignees,
  initialAssignee,
  initialPriority,
  isPending,
  onClose,
  onSubmit,
}: EditTicketPanelFormProps) {
  const navigate = useNavigate()
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const [drawerWidth, setDrawerWidth] = useState(() => readDrawerWidthFromStorage())
  const [isResizing, setIsResizing] = useState(false)
  const [title, setTitle] = useState(ticket.title)
  const [description, setDescription] = useState(ticket.description)
  const [assignee, setAssignee] = useState(initialAssignee)
  const [priority, setPriority] = useState<TicketPriority>(initialPriority)
  const [errors, setErrors] = useState<ValidationErrors>({})
  const [activeTab, setActiveTab] = useState<'comments' | 'history' | 'activity'>('comments')
  const [commentDraft, setCommentDraft] = useState('')
  const [commentError, setCommentError] = useState<string | null>(null)
  const commentsQuery = useTicketCommentsQuery(ticket.id, 0, true)
  const eventsQuery = useTicketEventsQuery(ticket.id, 0, true)
  const docsQuery = useTicketDocsQuery(ticket.id, 0, true)
  const addCommentMutation = useAddTicketCommentMutation()

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const validation = validateForm(title, description)
    if (validation.title || validation.description) {
      setErrors(validation)
      return
    }

    setErrors({})

    const payload: UpdateTicketRequest = {
      title: title.trim(),
      description: description.trim(),
      assignee,
      priority,
    }

    await onSubmit({ ticketId: ticket.id, input: payload })
  }

  const handlePostComment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const content = commentDraft.trim()
    if (!content) {
      setCommentError('Comment cannot be empty.')
      return
    }
    if (content.length > COMMENT_MAX_LENGTH) {
      setCommentError(`Comment must be ${COMMENT_MAX_LENGTH} characters or less.`)
      return
    }

    setCommentError(null)

    try {
      await addCommentMutation.mutate({
        ticketId: ticket.id,
        input: {
          author: 'User',
          content,
        },
      })
      setCommentDraft('')
      await Promise.all([commentsQuery.refetch(), eventsQuery.refetch()])
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : 'Failed to post comment.')
    }
  }

  const commentLength = commentDraft.trim().length
  const comments = commentsQuery.data ?? []
  const events = eventsQuery.data ?? []
  const activityEntries = buildTicketActivityEntries(events, comments)
  const taskDocs = docsQuery.data
  const taskDocFiles = taskDocs?.files ?? []
  const drawerStyle = { '--drawer-width': `${drawerWidth}px` } as CSSProperties

  const openWorkspaceFile = (path: string) => {
    window.sessionStorage.setItem('workspaceOpenPath', path)
    const params = new URLSearchParams({ open: path })
    navigate(`/workspace?${params.toString()}`)
    onClose()
  }

  const persistDrawerWidth = (value: number) => {
    const normalized = clampDrawerWidth(value)
    setDrawerWidth(normalized)

    if (typeof window !== 'undefined') {
      window.localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, String(normalized))
    }
  }

  const handleResizerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    resizeStateRef.current = { startX: event.clientX, startWidth: drawerWidth }
    setIsResizing(true)
  }

  const handleResizerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      persistDrawerWidth(drawerWidth + 20)
      return
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault()
      persistDrawerWidth(drawerWidth - 20)
      return
    }

    if (event.key === 'Home') {
      event.preventDefault()
      persistDrawerWidth(DRAWER_WIDTH_MIN)
      return
    }

    if (event.key === 'End') {
      event.preventDefault()
      persistDrawerWidth(DRAWER_WIDTH_MAX)
    }
  }

  useEffect(() => {
    if (!isResizing) {
      return
    }

    const handlePointerMove = (event: PointerEvent) => {
      const resizeState = resizeStateRef.current
      if (!resizeState) {
        return
      }

      const delta = resizeState.startX - event.clientX
      persistDrawerWidth(resizeState.startWidth + delta)
    }

    const handlePointerUp = () => {
      resizeStateRef.current = null
      setIsResizing(false)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [isResizing])

  return (
    <div className="drawer-backdrop" role="presentation" onClick={isPending ? undefined : onClose}>
      <aside
        className={isResizing ? 'drawer-panel drawer-panel-resizing' : 'drawer-panel'}
        style={drawerStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-ticket-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className={isResizing ? 'drawer-resizer drawer-resizer-active' : 'drawer-resizer'}
          role="separator"
          aria-label="Resize task detail panel"
          aria-orientation="vertical"
          aria-valuemin={DRAWER_WIDTH_MIN}
          aria-valuemax={DRAWER_WIDTH_MAX}
          aria-valuenow={drawerWidth}
          tabIndex={0}
          onPointerDown={handleResizerPointerDown}
          onKeyDown={handleResizerKeyDown}
          onDoubleClick={() => persistDrawerWidth(DRAWER_WIDTH_DEFAULT)}
        />
        <header className="drawer-header">
          <div>
            <p className="drawer-eyebrow">TASK-{ticket.id}</p>
            <h2 id="edit-ticket-title">Edit Ticket</h2>
          </div>
          <div className="drawer-header-actions">
            <Button variant="ghost" onClick={onClose} disabled={isPending}>
              Close
            </Button>
          </div>
        </header>

        <form className="drawer-form" onSubmit={handleSubmit}>
          <label className="form-row">
            <span>Title</span>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Write a clear title"
              maxLength={200}
              required
            />
            {errors.title ? <small className="field-error">{errors.title}</small> : null}
          </label>

          <label className="form-row">
            <span>Description</span>
            <textarea
              className="form-textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Add details"
              maxLength={10000}
            />
            {errors.description ? <small className="field-error">{errors.description}</small> : null}
          </label>

          <div className="form-grid-two">
            <label className="form-row">
              <span>Assignee</span>
              <select className="form-select" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
                {assignees.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>

            <label className="form-row">
              <span>Priority</span>
              <select
                className="form-select"
                value={priority}
                onChange={(event) => setPriority(event.target.value as TicketPriority)}
              >
                {priorities.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="drawer-actions">
            <Button variant="ghost" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={isPending}>
              {isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </form>

        <section className="ticket-panel-meta" aria-label="Ticket discussion and activity">
          <section className="ticket-docs-panel" aria-label="Task docs">
            <header className="ticket-docs-head">
              <h3>Task Docs</h3>
              <code>{taskDocs?.folderPath ?? `docs/task-${ticket.id}-slug`}</code>
            </header>

            {docsQuery.uiError ? (
              <p className="panel-inline-error">
                <strong>{docsQuery.uiError.title}:</strong> {docsQuery.uiError.message}
              </p>
            ) : null}
            {docsQuery.isLoading ? <p className="panel-inline-muted">Loading task docs...</p> : null}
            {!docsQuery.isLoading && !docsQuery.uiError && taskDocFiles.length === 0 ? (
              <p className="panel-inline-muted">No associated docs yet.</p>
            ) : null}
            {!docsQuery.isLoading && !docsQuery.uiError && taskDocFiles.length > 0 ? (
              <ul className="ticket-docs-list">
                {taskDocFiles.map((file) => (
                  <li key={file.path}>
                    <button type="button" className="ticket-docs-link" onClick={() => openWorkspaceFile(file.path)}>
                      {file.relativePath}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <div className="ticket-panel-tabs" role="tablist" aria-label="Ticket details tabs">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'comments'}
              className={activeTab === 'comments' ? 'ticket-panel-tab ticket-panel-tab-active' : 'ticket-panel-tab'}
              onClick={() => setActiveTab('comments')}
            >
              Comments
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'history'}
              className={activeTab === 'history' ? 'ticket-panel-tab ticket-panel-tab-active' : 'ticket-panel-tab'}
              onClick={() => setActiveTab('history')}
            >
              History
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'activity'}
              className={activeTab === 'activity' ? 'ticket-panel-tab ticket-panel-tab-active' : 'ticket-panel-tab'}
              onClick={() => setActiveTab('activity')}
            >
              Activity
            </button>
          </div>

          {activeTab === 'comments' ? (
            <div className="ticket-panel-tab-body">
              <form className="comment-composer" onSubmit={handlePostComment}>
                <label className="form-row">
                  <span>Add Comment</span>
                  <textarea
                    className="form-textarea comment-textarea"
                    value={commentDraft}
                    onChange={(event) => setCommentDraft(event.target.value)}
                    placeholder="Write a comment..."
                    maxLength={COMMENT_MAX_LENGTH}
                  />
                </label>
                <div className="comment-composer-foot">
                  <span className="comment-counter">
                    {commentLength}/{COMMENT_MAX_LENGTH}
                  </span>
                  <Button variant="primary" type="submit" disabled={addCommentMutation.isPending || commentLength === 0}>
                    {addCommentMutation.isPending ? 'Posting...' : 'Post'}
                  </Button>
                </div>
                {commentError ? <p className="panel-inline-error">{commentError}</p> : null}
              </form>

              {commentsQuery.uiError ? (
                <p className="panel-inline-error">
                  <strong>{commentsQuery.uiError.title}:</strong> {commentsQuery.uiError.message}
                </p>
              ) : null}

              {commentsQuery.isLoading ? <p className="panel-inline-muted">Loading comments...</p> : null}
              {!commentsQuery.isLoading && comments.length === 0 ? (
                <p className="panel-inline-muted">No comments yet.</p>
              ) : null}
              {!commentsQuery.isLoading && comments.length > 0 ? (
                <ul className="comment-list">
                  {comments.map((comment) => (
                    <li key={comment.id}>
                      <CommentCard comment={comment} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {activeTab === 'history' ? (
            <TabEventList
              isLoading={eventsQuery.isLoading}
              errorMessage={
                eventsQuery.uiError ? `${eventsQuery.uiError.title}: ${eventsQuery.uiError.message}` : null
              }
              emptyMessage="No history entries yet."
              events={events}
              formatter={formatHistoryEvent}
            />
          ) : null}

          {activeTab === 'activity' ? (
            <TabActivityList
              isLoading={eventsQuery.isLoading || commentsQuery.isLoading}
              errorMessage={
                eventsQuery.uiError
                  ? `${eventsQuery.uiError.title}: ${eventsQuery.uiError.message}`
                  : commentsQuery.uiError
                    ? `${commentsQuery.uiError.title}: ${commentsQuery.uiError.message}`
                    : null
              }
              emptyMessage="No activity entries yet."
              entries={activityEntries}
            />
          ) : null}
        </section>
      </aside>
    </div>
  )
}

function CommentCard({ comment }: { comment: TicketComment }) {
  return (
    <article className="comment-card">
      <header className="comment-card-head">
        <p className="comment-card-author">{comment.author}</p>
        <time className="comment-card-time" dateTime={comment.created_at}>
          {formatDateTime(comment.created_at)}
        </time>
      </header>
      <p className="comment-card-content">{comment.content}</p>
    </article>
  )
}

function TabEventList({
  isLoading,
  errorMessage,
  emptyMessage,
  events,
  formatter,
}: {
  isLoading: boolean
  errorMessage: string | null
  emptyMessage: string
  events: TicketEvent[]
  formatter: (event: TicketEvent) => { title: string; detail: string }
}) {
  if (errorMessage) {
    return <p className="panel-inline-error">{errorMessage}</p>
  }

  if (isLoading) {
    return <p className="panel-inline-muted">Loading...</p>
  }

  if (events.length === 0) {
    return <p className="panel-inline-muted">{emptyMessage}</p>
  }

  return (
    <ul className="event-list">
      {events.map((event) => {
        const item = formatter(event)
        return (
          <li key={event.id} className="event-row">
            <div className="event-row-head">
              <p className="event-row-title">{item.title}</p>
              <time className="event-row-time" dateTime={event.created_at}>
                {formatDateTime(event.created_at)}
              </time>
            </div>
            <p className="event-row-detail">{item.detail}</p>
          </li>
        )
      })}
    </ul>
  )
}

type TicketActivityEntry = {
  id: string
  createdAt: string
  title: string
  detail: string
}

function TabActivityList({
  isLoading,
  errorMessage,
  emptyMessage,
  entries,
}: {
  isLoading: boolean
  errorMessage: string | null
  emptyMessage: string
  entries: TicketActivityEntry[]
}) {
  if (errorMessage) {
    return <p className="panel-inline-error">{errorMessage}</p>
  }

  if (isLoading) {
    return <p className="panel-inline-muted">Loading...</p>
  }

  if (entries.length === 0) {
    return <p className="panel-inline-muted">{emptyMessage}</p>
  }

  return (
    <ul className="event-list">
      {entries.map((entry) => (
        <li key={entry.id} className="event-row">
          <div className="event-row-head">
            <p className="event-row-title">{entry.title}</p>
            <time className="event-row-time" dateTime={entry.createdAt}>
              {formatDateTime(entry.createdAt)}
            </time>
          </div>
          <p className="event-row-detail">{entry.detail}</p>
        </li>
      ))}
    </ul>
  )
}

function buildTicketActivityEntries(events: TicketEvent[], comments: TicketComment[]): TicketActivityEntry[] {
  const eventEntries = events.map((event) => ({
    id: `event-${event.id}`,
    createdAt: event.created_at,
    ...formatActivityEvent(event),
  }))

  const commentEntries = comments.map((comment) => ({
    id: `comment-${comment.id}`,
    createdAt: comment.created_at,
    title: `Comment by ${comment.author || 'User'}`,
    detail: comment.content || 'No comment content.',
  }))

  return [...eventEntries, ...commentEntries].sort((left, right) => {
    const leftMs = Date.parse(left.createdAt)
    const rightMs = Date.parse(right.createdAt)

    if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) {
      return right.createdAt.localeCompare(left.createdAt)
    }

    return rightMs - leftMs
  })
}

function formatHistoryEvent(event: TicketEvent): { title: string; detail: string } {
  const actor = event.actor?.trim() || 'System'
  return {
    title: `${formatEventType(event.event_type)} by ${actor}`,
    detail: event.details || 'No details provided.',
  }
}

function formatActivityEvent(event: TicketEvent): { title: string; detail: string } {
  return {
    title: formatEventType(event.event_type),
    detail: event.details || `${event.actor ?? 'System'} updated this ticket.`,
  }
}

function formatEventType(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

function formatDateTime(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return 'Unknown time'
  }

  return parsed.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function validateForm(title: string, description: string): ValidationErrors {
  const trimmedTitle = title.trim()
  const trimmedDescription = description.trim()
  const errors: ValidationErrors = {}

  if (!trimmedTitle) {
    errors.title = 'Title is required.'
  } else if (trimmedTitle.length > 200) {
    errors.title = 'Title must be 200 characters or less.'
  }

  if (trimmedDescription.length > 10000) {
    errors.description = 'Description must be 10,000 characters or less.'
  }

  return errors
}

function clampDrawerWidth(value: number): number {
  if (!Number.isFinite(value)) {
    return DRAWER_WIDTH_DEFAULT
  }
  return Math.min(DRAWER_WIDTH_MAX, Math.max(DRAWER_WIDTH_MIN, Math.round(value)))
}

function readDrawerWidthFromStorage(): number {
  if (typeof window === 'undefined') {
    return DRAWER_WIDTH_DEFAULT
  }

  const raw = window.localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY)
  if (!raw) {
    return DRAWER_WIDTH_DEFAULT
  }

  const parsed = Number(raw)
  return clampDrawerWidth(parsed)
}
