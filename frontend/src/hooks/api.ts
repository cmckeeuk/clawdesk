import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { apiClient } from '@/api/client'
import { mapApiErrorToUi, toApiError } from '@/api/errors'
import type { ApiError, UiError } from '@/api/errors'
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

type QueryState<TData> = {
  data: TData | null
  error: ApiError | null
  uiError: UiError | null
  isLoading: boolean
}

type QueryAction<TData> =
  | { type: 'loading' }
  | { type: 'success'; data: TData }
  | { type: 'error'; error: ApiError; uiError: UiError }

function createInitialQueryState<TData>(enabled: boolean): QueryState<TData> {
  return {
    data: null,
    error: null,
    uiError: null,
    isLoading: enabled,
  }
}

function queryReducer<TData>(state: QueryState<TData>, action: QueryAction<TData>): QueryState<TData> {
  if (action.type === 'loading') {
    return {
      ...state,
      error: null,
      uiError: null,
      isLoading: true,
    }
  }

  if (action.type === 'success') {
    return {
      data: action.data,
      error: null,
      uiError: null,
      isLoading: false,
    }
  }

  return {
    ...state,
    error: action.error,
    uiError: action.uiError,
    isLoading: false,
  }
}

type UseApiQueryParams<TData> = {
  key: string
  fetcher: (signal: AbortSignal) => Promise<TData>
  enabled?: boolean
}

type UseApiMutationResult<TData, TVariables> = {
  data: TData | null
  error: ApiError | null
  uiError: UiError | null
  isPending: boolean
  mutate: (variables: TVariables) => Promise<TData>
  reset: () => void
}

export function useApiQuery<TData>({ key, fetcher, enabled = true }: UseApiQueryParams<TData>) {
  const [state, dispatch] = useReducer(queryReducer<TData>, enabled, createInitialQueryState<TData>)
  const controllerRef = useRef<AbortController | null>(null)

  const execute = useCallback(async () => {
    if (!enabled) {
      return
    }

    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller

    dispatch({ type: 'loading' })

    try {
      const data = await fetcher(controller.signal)
      dispatch({ type: 'success', data })
    } catch (error) {
      if (controller.signal.aborted) {
        return
      }

      const apiError = toApiError(error)
      dispatch({
        type: 'error',
        error: apiError,
        uiError: mapApiErrorToUi(apiError),
      })
    }
  }, [enabled, fetcher])

  useEffect(() => {
    void execute()
    return () => controllerRef.current?.abort()
  }, [key, execute])

  return {
    ...state,
    refetch: execute,
  }
}

export function useApiMutation<TData, TVariables>(
  mutationFn: (variables: TVariables) => Promise<TData>,
): UseApiMutationResult<TData, TVariables> {
  const [data, setData] = useState<TData | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [uiError, setUiError] = useState<UiError | null>(null)
  const [isPending, setIsPending] = useState(false)

  const mutate = useCallback(
    async (variables: TVariables): Promise<TData> => {
      setIsPending(true)
      setError(null)
      setUiError(null)

      try {
        const result = await mutationFn(variables)
        setData(result)
        return result
      } catch (rawError) {
        const apiError = toApiError(rawError)
        setError(apiError)
        setUiError(mapApiErrorToUi(apiError))
        throw apiError
      } finally {
        setIsPending(false)
      }
    },
    [mutationFn],
  )

  const reset = useCallback(() => {
    setData(null)
    setError(null)
    setUiError(null)
    setIsPending(false)
  }, [])

  return {
    data,
    error,
    uiError,
    isPending,
    mutate,
    reset,
  }
}

export function useHealthQuery(refreshToken = 0) {
  const fetcher = useCallback((signal: AbortSignal) => apiClient.getHealth(signal), [])
  return useApiQuery<HealthResponse>({
    key: `health:${refreshToken}`,
    fetcher,
  })
}

export function useConfigQuery(refreshToken = 0) {
  const fetcher = useCallback((signal: AbortSignal) => apiClient.getConfig(signal), [])
  return useApiQuery<ConfigResponse>({
    key: `config:${refreshToken}`,
    fetcher,
  })
}

export function useGatewayHealthQuery(refreshToken = 0) {
  const fetcher = useCallback((signal: AbortSignal) => apiClient.getGatewayHealth(signal), [])
  return useApiQuery<GatewayHealthResponse>({
    key: `gateway-health:${refreshToken}`,
    fetcher,
  })
}

export function useGatewaySessionsActivityQuery(
  options: { sessionLimit?: number; historyLimit?: number } = {},
  refreshToken = 0,
) {
  const sessionLimit = options.sessionLimit ?? 200
  const historyLimit = options.historyLimit ?? 160
  const key = `gateway-sessions-activity:${sessionLimit}:${historyLimit}:${refreshToken}`
  const fetcher = useCallback(
    (signal: AbortSignal) => apiClient.getGatewaySessionsActivity({ sessionLimit, historyLimit }, signal),
    [historyLimit, sessionLimit],
  )
  return useApiQuery<GatewaySessionsActivityResponse>({ key, fetcher })
}

export function useTicketsQuery(filters: TicketFilters = {}, refreshToken = 0) {
  const { status, assignee, archived } = filters
  const key = useMemo(
    () => `tickets:${status ?? 'all'}:${assignee ?? 'all'}:${archived === true ? 'archived' : 'active'}:${refreshToken}`,
    [archived, assignee, refreshToken, status],
  )

  const fetcher = useCallback(
    (signal: AbortSignal) => apiClient.listTickets({ status, assignee, archived }, signal),
    [archived, assignee, status],
  )

  return useApiQuery<Ticket[]>({ key, fetcher })
}

export function useCreateTicketMutation() {
  return useApiMutation<Ticket, CreateTicketRequest>((input) => apiClient.createTicket(input))
}

export function useUpdateTicketMutation() {
  return useApiMutation<Ticket, { ticketId: number; input: UpdateTicketRequest }>(({ ticketId, input }) =>
    apiClient.updateTicket(ticketId, input),
  )
}

export function useMoveTicketMutation() {
  return useApiMutation<MoveTicketResponse, { ticketId: number; input: MoveTicketRequest }>(
    ({ ticketId, input }) => apiClient.moveTicket(ticketId, input),
  )
}

export function useArchiveTicketMutation() {
  return useApiMutation<Ticket, { ticketId: number; actor?: string }>(
    ({ ticketId, actor }) => apiClient.archiveTicket(ticketId, actor),
  )
}

export function useTicketCommentsQuery(ticketId: number | null, refreshToken = 0, enabled = true) {
  const key = `ticket-comments:${ticketId ?? 'none'}:${refreshToken}`
  const queryEnabled = enabled && ticketId !== null

  const fetcher = useCallback((signal: AbortSignal) => {
    if (ticketId === null) {
      return Promise.resolve([] as TicketComment[])
    }

    return apiClient.listTicketComments(ticketId, signal)
  }, [ticketId])

  return useApiQuery<TicketComment[]>({
    key,
    fetcher,
    enabled: queryEnabled,
  })
}

export function useAddTicketCommentMutation() {
  return useApiMutation<TicketComment, { ticketId: number; input: CreateCommentRequest }>(
    ({ ticketId, input }) => apiClient.addTicketComment(ticketId, input),
  )
}

export function useTicketEventsQuery(ticketId: number | null, refreshToken = 0, enabled = true) {
  const key = `ticket-events:${ticketId ?? 'none'}:${refreshToken}`
  const queryEnabled = enabled && ticketId !== null

  const fetcher = useCallback((signal: AbortSignal) => {
    if (ticketId === null) {
      return Promise.resolve([] as TicketEvent[])
    }

    return apiClient.listTicketEvents(ticketId, signal)
  }, [ticketId])

  return useApiQuery<TicketEvent[]>({
    key,
    fetcher,
    enabled: queryEnabled,
  })
}

export function useTicketDocsQuery(ticketId: number | null, refreshToken = 0, enabled = true) {
  const key = `ticket-docs:${ticketId ?? 'none'}:${refreshToken}`
  const queryEnabled = enabled && ticketId !== null

  const fetcher = useCallback((signal: AbortSignal) => {
    if (ticketId === null) {
      return Promise.resolve({
        ticketId: -1,
        folderPath: '',
        exists: false,
        files: [],
      } as TicketDocsResponse)
    }

    return apiClient.getTicketDocs(ticketId, signal)
  }, [ticketId])

  return useApiQuery<TicketDocsResponse>({
    key,
    fetcher,
    enabled: queryEnabled,
  })
}

export function useActivityQuery(filters: ActivityFilters = {}, refreshToken = 0) {
  const { limit, offset, ticketId, eventType, includeArchived } = filters
  const key = useMemo(
    () =>
      `activity:${limit ?? 250}:${offset ?? 0}:${ticketId ?? 'all'}:${eventType ?? 'all'}:${includeArchived ? 'all' : 'active'}:${refreshToken}`,
    [eventType, includeArchived, limit, offset, refreshToken, ticketId],
  )

  const fetcher = useCallback(
    (signal: AbortSignal) => apiClient.listActivity({ limit, offset, ticketId, eventType, includeArchived }, signal),
    [eventType, includeArchived, limit, offset, ticketId],
  )

  return useApiQuery<ActivityEvent[]>({ key, fetcher })
}

export function useWorkspaceDirectoryQuery(path: string, refreshToken = 0, includeHidden = false) {
  const normalizedPath = path.trim()
  const key = `workspace-list:${normalizedPath || '.'}:${includeHidden ? 'hidden' : 'clean'}:${refreshToken}`

  const fetcher = useCallback(
    (signal: AbortSignal) => apiClient.listWorkspace(normalizedPath, includeHidden, signal),
    [includeHidden, normalizedPath],
  )

  return useApiQuery<WorkspaceListResponse>({ key, fetcher })
}

export function useWorkspaceFileQuery(path: string | null, refreshToken = 0, enabled = true) {
  const normalizedPath = path?.trim() ?? ''
  const queryEnabled = enabled && normalizedPath.length > 0
  const key = `workspace-file:${normalizedPath || 'none'}:${refreshToken}`

  const fetcher = useCallback((signal: AbortSignal) => apiClient.getWorkspaceFile(normalizedPath, signal), [normalizedPath])

  return useApiQuery<WorkspaceFileResponse>({
    key,
    fetcher,
    enabled: queryEnabled,
  })
}

export function useUpdateWorkspaceFileMutation() {
  return useApiMutation<UpdateWorkspaceFileResponse, UpdateWorkspaceFileRequest>((input) =>
    apiClient.updateWorkspaceFile(input),
  )
}

export function useCreateWorkspaceFileMutation() {
  return useApiMutation<CreateWorkspaceFileResponse, CreateWorkspaceFileRequest>((input) =>
    apiClient.createWorkspaceFile(input),
  )
}

export function useDeleteWorkspaceFileMutation() {
  return useApiMutation<DeleteWorkspaceFileResponse, { path: string }>(({ path }) =>
    apiClient.deleteWorkspaceFile(path),
  )
}
