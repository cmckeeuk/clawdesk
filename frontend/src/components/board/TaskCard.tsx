import type { CSSProperties } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Card } from '@/components/ui/Card'
import { Tag } from '@/components/ui/Tag'
import { cn } from '@/lib/cn'
import type { Ticket, TicketPriority } from '@/api/types'
import { ticketItemId } from '@/components/board/dnd'

type TaskCardProps = {
  ticket: Ticket
  isMoving: boolean
  isArchiving: boolean
  isEditing: boolean
  warningMessages: string[]
  onEdit: (ticket: Ticket) => void
}

type TagTone = 'default' | 'warning' | 'danger'

export function TaskCard({
  ticket,
  isMoving,
  isArchiving,
  isEditing,
  warningMessages,
  onEdit,
}: TaskCardProps) {
  const isDragDisabled = ticket.id < 0 || isMoving || isArchiving || isEditing
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticketItemId(ticket.id),
    disabled: isDragDisabled,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  const priorityTone = priorityToTone(ticket.priority)
  const assigneeColor = assigneeToColor(ticket.assignee)
  const cardStyle = {
    ['--ticket-assignee-color' as string]: assigneeColor,
  } as CSSProperties
  const description = ticket.description.trim()

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        'ticket-sortable',
        isDragging && 'ticket-sortable-dragging',
        isMoving && 'ticket-sortable-moving',
        isDragDisabled && 'ticket-sortable-disabled',
      )}
    >
      <Card className="ticket-card" style={cardStyle}>
        <div className="ticket-card-head">
          <div className="ticket-card-head-left">
            <button
              type="button"
              className="ticket-key-button"
              aria-label={`Edit TASK-${ticket.id}`}
              disabled={ticket.id < 0 || isMoving || isArchiving}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onEdit(ticket)
              }}
            >
              TASK-{ticket.id}
            </button>
          </div>
          <Tag tone={priorityTone}>{ticket.priority}</Tag>
        </div>

        <h4 className="ticket-title">{ticket.title}</h4>

        {description ? <p className="ticket-description">{truncate(description, 160)}</p> : null}

        <p className="ticket-assignee-row">
          <span className="ticket-assignee-label">Assigned To</span>
          <strong className="ticket-assignee-value">{ticket.assignee}</strong>
        </p>
        <p className="ticket-updated">Updated {formatUpdatedAt(ticket.updated_at)}</p>

        {ticket.agent_session_key ? (
          <Tag className="ticket-ai-badge">AI active: {ticket.agent_session_key}</Tag>
        ) : null}

        {warningMessages.length > 0 ? (
          <div className="ticket-warning-block">
            <Tag tone="warning">Pickup warning</Tag>
            <p>{warningMessages[0]}</p>
          </div>
        ) : null}
      </Card>
    </div>
  )
}

function priorityToTone(priority: TicketPriority): TagTone {
  if (priority === 'Critical') {
    return 'danger'
  }

  if (priority === 'High') {
    return 'warning'
  }

  return 'default'
}

function formatUpdatedAt(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return 'unknown'
  }

  return parsed.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength - 1)}…`
}

function assigneeToColor(assignee: string): string {
  const normalized = assignee.trim().toLowerCase()
  if (!normalized || normalized === 'unassigned') {
    return '#3a4b7a'
  }

  const palette = ['#38bdf8', '#34d399', '#f59e0b', '#a78bfa', '#fb7185', '#22d3ee', '#f97316', '#60a5fa']
  let hash = 0
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0
  }
  return palette[hash % palette.length]
}
