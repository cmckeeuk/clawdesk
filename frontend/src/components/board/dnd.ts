import type { TicketStatus } from '@/api/types'

const TICKET_ID_PREFIX = 'ticket:'
const LANE_ID_PREFIX = 'lane:'
const BOARD_STATUSES: TicketStatus[] = ['Todo', 'Plan', 'In Progress', 'Review', 'Done']

export function ticketItemId(ticketId: number): string {
  return `${TICKET_ID_PREFIX}${ticketId}`
}

export function laneDropId(status: TicketStatus): string {
  return `${LANE_ID_PREFIX}${status}`
}

export function parseTicketItemId(raw: string): number | null {
  if (!raw.startsWith(TICKET_ID_PREFIX)) {
    return null
  }

  const value = Number(raw.slice(TICKET_ID_PREFIX.length))
  return Number.isInteger(value) ? value : null
}

export function parseLaneDropId(raw: string): TicketStatus | null {
  if (!raw.startsWith(LANE_ID_PREFIX)) {
    return null
  }

  const value = raw.slice(LANE_ID_PREFIX.length) as TicketStatus
  if (BOARD_STATUSES.includes(value)) {
    return value
  }

  return null
}
