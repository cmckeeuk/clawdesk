import { buildApiUrl } from '@/lib/api'
import { ApiError, createHttpError, toApiError } from '@/api/errors'
import type {
  ActivityEvent,
  ActivityFilters,
  ConfigResponse,
  CreateWorkspaceFileRequest,
  CreateWorkspaceFileResponse,
  CreateCommentRequest,
  CreateTicketRequest,
  DeleteWorkspaceFileResponse,
  GatewayHealthResponse,
  GatewaySessionsActivityResponse,
  HealthResponse,
  MoveTicketRequest,
  MoveTicketResponse,
  TicketComment,
  TicketDocsResponse,
  TicketEvent,
  Ticket,
  TicketFilters,
  UpdateWorkspaceFileRequest,
  UpdateWorkspaceFileResponse,
  UpdateTicketRequest,
  WorkspaceFileResponse,
  WorkspaceListResponse,
} from '@/api/types'

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

type RequestOptions = {
  method?: HttpMethod
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  signal?: AbortSignal
}

function withQuery(path: string, query?: RequestOptions['query']): string {
  if (!query) {
    return path
  }

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') {
      continue
    }
    params.set(key, String(value))
  }

  const queryString = params.toString()
  if (!queryString) {
    return path
  }

  return `${path}?${queryString}`
}

async function request<TResponse>(path: string, options: RequestOptions = {}): Promise<TResponse> {
  const url = buildApiUrl(withQuery(path, options.query))
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  }

  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw toApiError(error)
  }

  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.includes('application/json')

  let payload: unknown = null
  if (response.status !== 204) {
    try {
      payload = isJson ? await response.json() : await response.text()
    } catch (error) {
      throw toApiError(error)
    }
  }

  if (!response.ok) {
    throw createHttpError(response.status, payload)
  }

  return payload as TResponse
}

export const apiClient = {
  getHealth(signal?: AbortSignal) {
    return request<HealthResponse>('/api/health', { signal })
  },

  getConfig(signal?: AbortSignal) {
    return request<ConfigResponse>('/api/config', { signal })
  },

  getGatewayHealth(signal?: AbortSignal) {
    return request<GatewayHealthResponse>('/api/gateway/health', { signal })
  },

  getGatewaySessionsActivity(
    params: { sessionLimit?: number; historyLimit?: number } = {},
    signal?: AbortSignal,
  ) {
    return request<GatewaySessionsActivityResponse>('/api/gateway/sessions/activity', {
      query: {
        session_limit: params.sessionLimit,
        history_limit: params.historyLimit,
      },
      signal,
    })
  },

  listTickets(filters: TicketFilters = {}, signal?: AbortSignal) {
    return request<Ticket[]>('/api/tickets', {
      query: {
        status: filters.status,
        assignee: filters.assignee,
        archived: filters.archived,
      },
      signal,
    })
  },

  createTicket(input: CreateTicketRequest, signal?: AbortSignal) {
    return request<Ticket>('/api/tickets', {
      method: 'POST',
      body: input,
      signal,
    })
  },

  updateTicket(ticketId: number, input: UpdateTicketRequest, signal?: AbortSignal) {
    return request<Ticket>(`/api/tickets/${ticketId}`, {
      method: 'PATCH',
      body: input,
      signal,
    })
  },

  moveTicket(ticketId: number, input: MoveTicketRequest, signal?: AbortSignal) {
    return request<MoveTicketResponse>(`/api/tickets/${ticketId}/move`, {
      method: 'POST',
      query: {
        status: input.status,
        actor: input.actor,
      },
      signal,
    })
  },

  archiveTicket(ticketId: number, actor?: string, signal?: AbortSignal) {
    return request<Ticket>(`/api/tickets/${ticketId}/archive`, {
      method: 'POST',
      query: {
        actor,
      },
      signal,
    })
  },

  listTicketComments(ticketId: number, signal?: AbortSignal) {
    return request<TicketComment[]>(`/api/tickets/${ticketId}/comments`, { signal })
  },

  addTicketComment(ticketId: number, input: CreateCommentRequest, signal?: AbortSignal) {
    return request<TicketComment>(`/api/tickets/${ticketId}/comments`, {
      method: 'POST',
      body: input,
      signal,
    })
  },

  listTicketEvents(ticketId: number, signal?: AbortSignal) {
    return request<TicketEvent[]>(`/api/tickets/${ticketId}/events`, { signal })
  },

  getTicketDocs(ticketId: number, signal?: AbortSignal) {
    return request<TicketDocsResponse>(`/api/tickets/${ticketId}/docs`, { signal })
  },

  listActivity(filters: ActivityFilters = {}, signal?: AbortSignal) {
    return request<ActivityEvent[]>('/api/activity', {
      query: {
        limit: filters.limit,
        offset: filters.offset,
        ticket_id: filters.ticketId,
        event_type: filters.eventType,
        include_archived: filters.includeArchived,
      },
      signal,
    })
  },

  listWorkspace(path = '', includeHidden = false, signal?: AbortSignal) {
    return request<WorkspaceListResponse>('/api/workspace/list', {
      query: {
        path,
        include_hidden: includeHidden,
      },
      signal,
    })
  },

  getWorkspaceFile(path: string, signal?: AbortSignal) {
    return request<WorkspaceFileResponse>('/api/workspace/file', {
      query: { path },
      signal,
    })
  },

  updateWorkspaceFile(input: UpdateWorkspaceFileRequest, signal?: AbortSignal) {
    return request<UpdateWorkspaceFileResponse>('/api/workspace/file', {
      method: 'PUT',
      body: input,
      signal,
    })
  },

  createWorkspaceFile(input: CreateWorkspaceFileRequest, signal?: AbortSignal) {
    return request<CreateWorkspaceFileResponse>('/api/workspace/file', {
      method: 'POST',
      body: input,
      signal,
    })
  },

  deleteWorkspaceFile(path: string, signal?: AbortSignal) {
    return request<DeleteWorkspaceFileResponse>('/api/workspace/file', {
      method: 'DELETE',
      query: { path },
      signal,
    })
  },
}

export { ApiError }
