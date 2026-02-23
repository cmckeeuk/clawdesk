import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Card } from '@/components/ui/Card'
import type { Ticket, TicketStatus } from '@/api/types'
import { TaskCard } from '@/components/board/TaskCard'
import { laneDropId, ticketItemId } from '@/components/board/dnd'
import { cn } from '@/lib/cn'

type KanbanColumnProps = {
  status: TicketStatus
  tickets: Ticket[]
  isLoading: boolean
  hasError: boolean
  searchValue: string
  movingTicketIds: Set<number>
  archivingTicketIds: Set<number>
  editingTicketId: number | null
  warningByTicketId: Map<number, string[]>
  onEditTicket: (ticket: Ticket) => void
}

export function KanbanColumn({
  status,
  tickets,
  isLoading,
  hasError,
  searchValue,
  movingTicketIds,
  archivingTicketIds,
  editingTicketId,
  warningByTicketId,
  onEditTicket,
}: KanbanColumnProps) {
  const emptyMessage = searchValue.trim()
    ? 'No tasks match this search in this lane.'
    : 'No tasks in this lane yet.'
  const sortableItems = tickets.map((ticket) => ticketItemId(ticket.id))
  const { setNodeRef, isOver } = useDroppable({ id: laneDropId(status) })

  return (
    <Card className={cn('kanban-column', laneStatusClass(status))} elevated>
      <header className="kanban-column-header">
        <h3>{status}</h3>
        <span aria-label={`${tickets.length} tasks`}>{tickets.length}</span>
      </header>

      <div
        ref={setNodeRef}
        className={cn('kanban-column-dropzone', isOver && 'kanban-column-dropzone-over')}
      >
        {isLoading ? <p className="kanban-column-state">Loading tasks...</p> : null}

        {!isLoading && hasError ? <p className="kanban-column-state">Unable to load tasks.</p> : null}

        {!isLoading && !hasError && tickets.length === 0 ? (
          <p className="kanban-column-state">{emptyMessage}</p>
        ) : null}

        {!isLoading && !hasError && tickets.length > 0 ? (
          <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
            <ul className="kanban-ticket-list" aria-label={`${status} tickets`}>
              {tickets.map((ticket) => (
                <li key={ticket.id}>
                  <TaskCard
                    ticket={ticket}
                    isMoving={movingTicketIds.has(ticket.id)}
                    isArchiving={archivingTicketIds.has(ticket.id)}
                    isEditing={editingTicketId === ticket.id}
                    warningMessages={warningByTicketId.get(ticket.id) ?? []}
                    onEdit={onEditTicket}
                  />
                </li>
              ))}
            </ul>
          </SortableContext>
        ) : null}
      </div>
    </Card>
  )
}

function laneStatusClass(status: TicketStatus): string {
  if (status === 'Plan') {
    return 'kanban-column--plan'
  }

  if (status === 'Todo') {
    return 'kanban-column--todo'
  }

  if (status === 'In Progress') {
    return 'kanban-column--in-progress'
  }

  if (status === 'Review') {
    return 'kanban-column--review'
  }

  return 'kanban-column--done'
}
