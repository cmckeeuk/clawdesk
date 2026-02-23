export type TicketStatus = 'Plan' | 'Todo' | 'In Progress' | 'Review' | 'Done'
export type TicketPriority = 'Critical' | 'High' | 'Medium' | 'Low'

export type Ticket = {
  id: number
  title: string
  description: string
  status: TicketStatus
  assignee: string
  priority: TicketPriority
  agent_session_key: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

export type TicketComment = {
  id: number
  ticket_id: number
  author: string
  content: string
  created_at: string
}

export type TicketEvent = {
  id: number
  ticket_id: number
  event_type: string
  actor: string | null
  details: string
  created_at: string
}

export type TicketDocFile = {
  name: string
  path: string
  relativePath: string
  sizeBytes: number
  updatedAt: string
  isMarkdown: boolean
}

export type TicketDocsResponse = {
  ticketId: number
  folderPath: string
  exists: boolean
  files: TicketDocFile[]
}

export type HealthResponse = {
  ok: boolean
  service: string
  db: string
}

export type ConfigResponse = {
  statuses: TicketStatus[]
  priorities: TicketPriority[]
  assignees: string[]
}

export type GatewayHealthResponse = {
  ok: boolean
  gateway: 'disabled' | 'reachable' | 'unreachable'
  detail?: string
}

export type TicketFilters = {
  status?: TicketStatus
  assignee?: string
  archived?: boolean
}

export type CreateTicketRequest = {
  title: string
  description?: string
  assignee?: string
  priority?: TicketPriority
}

export type UpdateTicketRequest = {
  title?: string
  description?: string
  assignee?: string
  priority?: TicketPriority
}

export type CreateCommentRequest = {
  author: string
  content: string
}

export type MoveTicketRequest = {
  status: TicketStatus
  actor?: string
}

export type PickupResult = {
  attempted: boolean
  spawned: boolean
  agent_id?: string
  session_key?: string
  run_id?: string
  reason?: string
}

export type MoveTicketResponse = {
  ok: boolean
  ticket: Ticket
  from: TicketStatus
  to: TicketStatus
  pickup: PickupResult
  warnings: string[]
}

export type WorkspaceEntry = {
  name: string
  path: string
  type: 'dir' | 'file'
  sizeBytes: number | null
  updatedAt: string
  isMarkdown: boolean
  isImage: boolean
}

export type WorkspaceListResponse = {
  root: string
  path: string
  entries: WorkspaceEntry[]
}

export type WorkspaceFileResponse = {
  root: string
  path: string
  name: string
  content: string
  isMarkdown: boolean
  isImage: boolean
  sizeBytes: number
  updatedAt: string
}

export type UpdateWorkspaceFileRequest = {
  path: string
  content: string
}

export type CreateWorkspaceFileRequest = {
  path: string
  content?: string
}

export type UpdateWorkspaceFileResponse = {
  ok: boolean
  root: string
  path: string
  name: string
  isMarkdown: boolean
  isImage: boolean
  sizeBytes: number
  updatedAt: string
}

export type CreateWorkspaceFileResponse = {
  ok: boolean
  root: string
  path: string
  name: string
  isMarkdown: boolean
  isImage: boolean
  sizeBytes: number
  updatedAt: string
}

export type DeleteWorkspaceFileResponse = {
  ok: boolean
  path: string
  name: string
  parentPath: string
}

export type ActivityEvent = {
  id: number
  ticket_id: number
  event_type: string
  actor: string | null
  details: string
  created_at: string
  ticket_title: string
  ticket_status: TicketStatus
  ticket_assignee: string
  ticket_priority: TicketPriority
  ticket_archived_at: string | null
}

export type ActivityFilters = {
  limit?: number
  offset?: number
  ticketId?: number
  eventType?: string
  includeArchived?: boolean
}
