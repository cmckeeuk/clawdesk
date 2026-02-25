import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent, UniqueIdentifier } from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import {
  BrowserRouter,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useOutletContext,
} from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Tag } from '@/components/ui/Tag'
import { Toast } from '@/components/ui/Toast'
import { EditTicketPanel } from '@/components/board/EditTicketPanel'
import { KanbanColumn } from '@/components/board/KanbanColumn'
import { NewTaskModal } from '@/components/board/NewTaskModal'
import { WorkspacePage } from '@/components/workspace/WorkspacePage'
import { parseLaneDropId, parseTicketItemId } from '@/components/board/dnd'
import { cn } from '@/lib/cn'
import { API_BASE_URL } from '@/config/env'
import type { UiError } from '@/api/errors'
import {
  useActivityQuery,
  useArchiveTicketMutation,
  useConfigQuery,
  useGatewaySessionsActivityQuery,
  useCreateTicketMutation,
  useGatewayHealthQuery,
  useHealthQuery,
  useMoveTicketMutation,
  useTicketsQuery,
  useUpdateTicketMutation,
} from '@/hooks/api'
import type {
  ConfigResponse,
  CreateTicketRequest,
  GatewaySessionActivity,
  Ticket,
  TicketPriority,
  TicketStatus,
  UpdateTicketRequest,
} from '@/api/types'
import activityIcon from './assets/activity.png'
import archiveIcon from './assets/archive.png'
import clawdeskIcon from './assets/clawdesk.png'
import filesIcon from './assets/files.png'
import kanbanIcon from './assets/kanban.png'
import settingsIcon from './assets/settings.png'
import usersIcon from './assets/users.png'
import './App.css'

type NavItem = {
  label: string
  path: string
  iconSrc: string
}

type RouteMeta = {
  title: string
  subtitle: string
}

type AppShellContext = {
  searchValue: string
  refreshToken: number
  pendingTickets: Ticket[]
  configData: ConfigResponse | null
  configUiError: UiError | null
  notify: (tone: ShellNoticeTone, message: string) => void
}

type ShellNoticeTone = 'success' | 'warning' | 'error'

type ShellNotice = {
  id: number
  tone: ShellNoticeTone
  message: string
}

type AgentSessionGroup = {
  key: string
  label: string
  sessions: GatewaySessionActivity[]
  totalSessions: number
  runningCount: number
  errorCount: number
  updatedAtMs: number
  updatedAt: string | null
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', path: '/dashboard', iconSrc: kanbanIcon },
  { label: 'Workspace', path: '/workspace', iconSrc: filesIcon },
  { label: 'Activity', path: '/log', iconSrc: activityIcon },
  { label: 'Sessions', path: '/sessions', iconSrc: usersIcon },
  { label: 'Settings', path: '/settings', iconSrc: settingsIcon },
  { label: 'Archived', path: '/archived', iconSrc: archiveIcon },
]

const ROUTE_META: Record<string, RouteMeta> = {
  '/dashboard': {
    title: 'Dashboard',
    subtitle: 'Kanban board for task management and workflow tracking.',
  },
  '/workspace': {
    title: 'Workspace',
    subtitle: 'Shared area for planning artifacts and task context.',
  },
  '/log': {
    title: 'Activity',
    subtitle: 'Live cross-ticket activity feed for high-tempo coordination.',
  },
  '/sessions': {
    title: 'Sessions',
    subtitle: 'Live monitor for agents, session health, and command execution timelines.',
  },
  '/settings': {
    title: 'Settings',
    subtitle: 'Preferences and board-level configuration placeholder.',
  },
  '/archived': {
    title: 'Archived',
    subtitle: 'Past tasks and historical records placeholder.',
  },
}

const DEFAULT_STATUSES: TicketStatus[] = ['Todo', 'Plan', 'In Progress', 'Review', 'Done']
const DEFAULT_PRIORITIES: TicketPriority[] = ['Critical', 'High', 'Medium', 'Low']
const ARCHIVE_NAV_DROP_ID = 'nav:archived'
const REALTIME_REFRESH_EVENT_TYPES = new Set([
  'ticket_created',
  'ticket_updated',
  'ticket_moved',
  'ticket_archived',
  'comment_added',
  'ticket_event',
])

function buildRealtimeWebSocketUrl(): string | null {
  try {
    const url = new URL('/ws', API_BASE_URL)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.toString()
  } catch {
    return null
  }
}

function shouldRefetchFromRealtimePayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') {
    return false
  }

  const type = (payload as { type?: unknown }).type
  return typeof type === 'string' && REALTIME_REFRESH_EVENT_TYPES.has(type)
}

function useTicketRealtimeRefetch(refetch: () => Promise<unknown>) {
  const refetchRef = useRef(refetch)

  useEffect(() => {
    refetchRef.current = refetch
  }, [refetch])

  useEffect(() => {
    const wsUrl = buildRealtimeWebSocketUrl()
    if (!wsUrl) {
      return
    }

    let socket: WebSocket | null = null
    let isClosed = false
    let reconnectTimer: number | null = null
    let throttleTimer: number | null = null
    let pendingRefetch = false
    let refetchInFlight = false

    const runRefetch = async () => {
      if (refetchInFlight || !pendingRefetch) {
        return
      }

      pendingRefetch = false
      refetchInFlight = true
      try {
        await refetchRef.current()
      } finally {
        refetchInFlight = false
        if (pendingRefetch) {
          void runRefetch()
        }
      }
    }

    const queueRefetch = () => {
      pendingRefetch = true
      if (throttleTimer !== null) {
        return
      }
      throttleTimer = window.setTimeout(() => {
        throttleTimer = null
        void runRefetch()
      }, 250)
    }

    const connect = () => {
      if (isClosed) {
        return
      }

      socket = new WebSocket(wsUrl)

      socket.addEventListener('message', (event) => {
        try {
          const payload: unknown = JSON.parse(event.data)
          if (shouldRefetchFromRealtimePayload(payload)) {
            queueRefetch()
          }
        } catch {
          // Ignore non-JSON heartbeat or malformed payloads.
        }
      })

      socket.addEventListener('error', () => {
        socket?.close()
      })

      socket.addEventListener('close', () => {
        if (isClosed || reconnectTimer !== null) {
          return
        }
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null
          connect()
        }, 1500)
      })
    }

    connect()

    return () => {
      isClosed = true
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
      }
      if (throttleTimer !== null) {
        window.clearTimeout(throttleTimer)
      }
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close()
      }
    }
  }, [])
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route
            path="/workspace"
            element={<WorkspaceRoute />}
          />
          <Route
            path="/log"
            element={<ActivityPage />}
          />
          <Route
            path="/sessions"
            element={<SessionsMonitorPage />}
          />
          <Route
            path="/settings"
            element={
              <PlaceholderPage
                title="Settings"
                description="This route is scaffolded and ready for user and board settings in a later task."
              />
            }
          />
          <Route
            path="/archived"
            element={<ArchivedPage />}
          />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

function AppShell() {
  const location = useLocation()
  const [searchValue, setSearchValue] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => new Date())
  const [pendingTickets, setPendingTickets] = useState<Ticket[]>([])
  const [isNewTaskModalOpen, setIsNewTaskModalOpen] = useState(false)
  const [newTaskModalEpoch, setNewTaskModalEpoch] = useState(0)
  const [shellNotice, setShellNotice] = useState<ShellNotice | null>(null)
  const shellNoticeTimerRef = useRef<number | null>(null)
  const configQuery = useConfigQuery(refreshToken)
  const createTicketMutation = useCreateTicketMutation()

  const routeMeta = useMemo(() => {
    return ROUTE_META[location.pathname] ?? ROUTE_META['/dashboard']
  }, [location.pathname])

  const handleRefresh = () => {
    setRefreshToken((value) => value + 1)
    setLastUpdatedAt(new Date())
  }

  const clearShellNoticeTimer = () => {
    if (shellNoticeTimerRef.current !== null) {
      window.clearTimeout(shellNoticeTimerRef.current)
      shellNoticeTimerRef.current = null
    }
  }

  const dismissShellNotice = () => {
    clearShellNoticeTimer()
    setShellNotice(null)
  }

  const showShellNotice = (tone: ShellNoticeTone, message: string) => {
    clearShellNoticeTimer()
    const noticeId = Date.now()
    const ttlMs = tone === 'error' ? 7000 : 3600

    setShellNotice({
      id: noticeId,
      tone,
      message,
    })

    shellNoticeTimerRef.current = window.setTimeout(() => {
      setShellNotice((current) => {
        if (!current || current.id !== noticeId) {
          return current
        }
        return null
      })
      shellNoticeTimerRef.current = null
    }, ttlMs)
  }

  useEffect(() => {
    return () => clearShellNoticeTimer()
  }, [])

  const handleOpenNewTask = () => {
    dismissShellNotice()
    setNewTaskModalEpoch((value) => value + 1)
    setIsNewTaskModalOpen(true)
  }

  const handleCreateTicket = async (payload: CreateTicketRequest) => {
    const temporaryId = -Date.now()
    const now = new Date().toISOString()
    const temporaryTicket: Ticket = {
      id: temporaryId,
      title: payload.title,
      description: payload.description ?? '',
      status: 'Todo',
      assignee: payload.assignee ?? 'Unassigned',
      priority: payload.priority ?? 'Medium',
      agent_session_key: null,
      archived_at: null,
      created_at: now,
      updated_at: now,
    }

    setPendingTickets((existing) => [temporaryTicket, ...existing])
    setIsNewTaskModalOpen(false)
    showShellNotice('success', `Creating "${payload.title}" in Todo...`)

    try {
      const created = await createTicketMutation.mutate(payload)
      setPendingTickets((existing) => existing.filter((ticket) => ticket.id !== temporaryId))
      showShellNotice('success', `Created TASK-${created.id} in Todo.`)
      setIsNewTaskModalOpen(false)
      setRefreshToken((value) => value + 1)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed'
      setPendingTickets((existing) => existing.filter((ticket) => ticket.id !== temporaryId))
      showShellNotice('error', `Create failed: ${message}`)
    }
  }

  const outletContext: AppShellContext = {
    searchValue,
    refreshToken,
    pendingTickets,
    configData: configQuery.data,
    configUiError: configQuery.uiError,
    notify: showShellNotice,
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-header">
          <img src={clawdeskIcon} alt="Clawdesk" className="brand-logo" />
        </div>

        <nav className="sidebar-nav" aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              data-nav-path={item.path}
              className={({ isActive }) =>
                isActive ? 'sidebar-link sidebar-link-active' : 'sidebar-link'
              }
            >
              <span className="sidebar-icon" aria-hidden="true">
                <img src={item.iconSrc} alt="" className="sidebar-icon-image" />
              </span>
              <span className="sidebar-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="content-wrap">
        <header className="topbar">
          <div className="topbar-heading">
            <h1>{routeMeta.title}</h1>
            <p>{routeMeta.subtitle}</p>
          </div>

          <div className="topbar-actions">
            <label className="search-field" htmlFor="global-search">
              <span className="visually-hidden">Search tasks</span>
              <Input
                id="global-search"
                type="search"
                placeholder="Search tasks"
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
              />
            </label>

            <Button variant="ghost" onClick={handleRefresh}>
              Refresh
            </Button>

            <Button variant="primary" onClick={handleOpenNewTask}>
              + New Task
            </Button>
          </div>
        </header>

        <p className="last-updated">Updated {formatTimestamp(lastUpdatedAt)}</p>

        <main className="page-content">
          <Outlet context={outletContext} />
        </main>
      </div>

      <div className="toast-stack">
        {shellNotice ? (
          <Toast tone={shellNotice.tone} message={shellNotice.message} onClose={dismissShellNotice} />
        ) : null}
      </div>

      <NewTaskModal
        key={newTaskModalEpoch}
        open={isNewTaskModalOpen}
        isPending={createTicketMutation.isPending}
        assigneeOptions={configQuery.data?.assignees ?? ['Unassigned']}
        priorityOptions={configQuery.data?.priorities ?? DEFAULT_PRIORITIES}
        onClose={() => setIsNewTaskModalOpen(false)}
        onSubmit={handleCreateTicket}
      />
    </div>
  )
}

function DashboardPage() {
  const { searchValue, refreshToken, pendingTickets, configData, configUiError, notify } = useAppShellContext()
  const healthQuery = useHealthQuery(refreshToken)
  const gatewayQuery = useGatewayHealthQuery(refreshToken)
  const ticketsQuery = useTicketsQuery({}, refreshToken)
  useTicketRealtimeRefetch(ticketsQuery.refetch)
  const archiveTicketMutation = useArchiveTicketMutation()
  const moveTicketMutation = useMoveTicketMutation()
  const updateTicketMutation = useUpdateTicketMutation()
  const [optimisticTickets, setOptimisticTickets] = useState<Map<number, Ticket>>(new Map())
  const [movingTicketIds, setMovingTicketIds] = useState<Set<number>>(new Set())
  const [archivingTicketIds, setArchivingTicketIds] = useState<Set<number>>(new Set())
  const [warningByTicketId, setWarningByTicketId] = useState<Map<number, string[]>>(new Map())
  const [activeDragTicketId, setActiveDragTicketId] = useState<number | null>(null)
  const [editingTicketId, setEditingTicketId] = useState<number | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const statuses = useMemo(() => {
    const configured = configData?.statuses ?? DEFAULT_STATUSES
    return DEFAULT_STATUSES.filter((status) => configured.includes(status))
  }, [configData?.statuses])
  const boardTickets = useMemo(() => {
    return mergeTickets(ticketsQuery.data ?? [], pendingTickets, optimisticTickets).filter(
      (ticket) => ticket.archived_at === null,
    )
  }, [optimisticTickets, pendingTickets, ticketsQuery.data])

  const filteredTickets = useMemo(() => {
    const search = searchValue.trim().toLowerCase()

    if (!search) {
      return boardTickets
    }

    return boardTickets.filter((ticket) => {
      return [ticket.title, ticket.description, ticket.assignee].some((value) =>
        value.toLowerCase().includes(search),
      )
    })
  }, [boardTickets, searchValue])
  const ticketById = useMemo(() => {
    const map = new Map<number, Ticket>()
    for (const ticket of boardTickets) {
      map.set(ticket.id, ticket)
    }
    return map
  }, [boardTickets])
  const activeDragTicket = useMemo(() => {
    if (activeDragTicketId === null) {
      return null
    }

    return ticketById.get(activeDragTicketId) ?? null
  }, [activeDragTicketId, ticketById])

  const lanes = useMemo(() => {
    const grouped = new Map<TicketStatus, Ticket[]>()
    for (const status of statuses) {
      grouped.set(status, [])
    }

    for (const ticket of filteredTickets) {
      const lane = grouped.get(ticket.status)
      if (lane) {
        lane.push(ticket)
      }
    }

    return grouped
  }, [filteredTickets, statuses])

  const hasTicketError = Boolean(ticketsQuery.uiError)
  const showBoardEmptyState = !ticketsQuery.isLoading && !hasTicketError && filteredTickets.length === 0
  const warningSummaries = useMemo(() => {
    return Array.from(warningByTicketId.entries()).sort((left, right) => right[0] - left[0])
  }, [warningByTicketId])
  const editingTicket = useMemo(() => {
    if (editingTicketId === null) {
      return null
    }

    return ticketById.get(editingTicketId) ?? null
  }, [editingTicketId, ticketById])
  const activeDragWarnings = useMemo(() => {
    if (activeDragTicketId === null) {
      return []
    }

    return warningByTicketId.get(activeDragTicketId) ?? []
  }, [activeDragTicketId, warningByTicketId])

  const banners = useMemo(() => {
    const list = [healthQuery.uiError, configUiError, gatewayQuery.uiError, ticketsQuery.uiError].filter(
      (value): value is NonNullable<typeof value> => Boolean(value),
    )

    return list.filter((item, index) => {
      return list.findIndex((candidate) => candidate.title === item.title) === index
    })
  }, [configUiError, gatewayQuery.uiError, healthQuery.uiError, ticketsQuery.uiError])

  const moveTicket = async (ticketId: number, targetStatus: TicketStatus) => {
    const currentTicket = ticketById.get(ticketId)
    if (!currentTicket) {
      return
    }

    if (currentTicket.id < 0) {
      notify('warning', 'Wait for ticket creation to finish before moving it.')
      return
    }

    if (currentTicket.status === targetStatus) {
      return
    }

    if (movingTicketIds.has(ticketId)) {
      return
    }

    const optimisticTicket: Ticket = {
      ...currentTicket,
      status: targetStatus,
      updated_at: new Date().toISOString(),
    }

    setOptimisticTickets((previous) => {
      const next = new Map(previous)
      next.set(ticketId, optimisticTicket)
      return next
    })
    setMovingTicketIds((previous) => {
      const next = new Set(previous)
      next.add(ticketId)
      return next
    })

    try {
      const response = await moveTicketMutation.mutate({
        ticketId,
        input: { status: targetStatus, actor: 'User' },
      })

      setOptimisticTickets((previous) => {
        const next = new Map(previous)
        next.set(ticketId, response.ticket)
        return next
      })

      const warningMessages = collectMoveWarnings(response)
      if (warningMessages.length > 0) {
        setWarningByTicketId((previous) => {
          const next = new Map(previous)
          next.set(ticketId, warningMessages)
          return next
        })
        notify('warning', `Moved TASK-${ticketId} with warning: ${warningMessages[0]}`)
      } else {
        setWarningByTicketId((previous) => {
          if (!previous.has(ticketId)) {
            return previous
          }

          const next = new Map(previous)
          next.delete(ticketId)
          return next
        })
        notify('success', `Moved TASK-${ticketId} to ${targetStatus}.`)
      }

      await ticketsQuery.refetch()
      setOptimisticTickets((previous) => {
        if (!previous.has(ticketId)) {
          return previous
        }

        const next = new Map(previous)
        next.delete(ticketId)
        return next
      })
    } catch (error) {
      setOptimisticTickets((previous) => {
        if (!previous.has(ticketId)) {
          return previous
        }

        const next = new Map(previous)
        next.delete(ticketId)
        return next
      })
      const message = error instanceof Error ? error.message : 'Request failed'
      notify('error', `Move failed for TASK-${ticketId}: ${message}`)
    } finally {
      setMovingTicketIds((previous) => {
        if (!previous.has(ticketId)) {
          return previous
        }

        const next = new Set(previous)
        next.delete(ticketId)
        return next
      })
    }
  }

  const handleOpenEditTicket = (ticket: Ticket) => {
    if (ticket.id < 0) {
      notify('warning', 'Wait for ticket creation to complete before editing.')
      return
    }

    setEditingTicketId(ticket.id)
  }

  const handleSubmitEditTicket = async (payload: { ticketId: number; input: UpdateTicketRequest }) => {
    const current = ticketById.get(payload.ticketId)
    if (!current) {
      return
    }

    const optimisticUpdated: Ticket = {
      ...current,
      ...payload.input,
      title: payload.input.title ?? current.title,
      description: payload.input.description ?? current.description,
      assignee: payload.input.assignee ?? current.assignee,
      priority: payload.input.priority ?? current.priority,
      updated_at: new Date().toISOString(),
    }

    setOptimisticTickets((previous) => {
      const next = new Map(previous)
      next.set(payload.ticketId, optimisticUpdated)
      return next
    })

    try {
      const updated = await updateTicketMutation.mutate(payload)
      setOptimisticTickets((previous) => {
        const next = new Map(previous)
        next.set(payload.ticketId, updated)
        return next
      })
      setEditingTicketId(null)
      notify('success', `Saved TASK-${updated.id}.`)

      await ticketsQuery.refetch()
      setOptimisticTickets((previous) => {
        if (!previous.has(payload.ticketId)) {
          return previous
        }

        const next = new Map(previous)
        next.delete(payload.ticketId)
        return next
      })
    } catch (error) {
      setOptimisticTickets((previous) => {
        if (!previous.has(payload.ticketId)) {
          return previous
        }

        const next = new Map(previous)
        next.delete(payload.ticketId)
        return next
      })
      const message = error instanceof Error ? error.message : 'Request failed'
      notify('error', `Save failed for TASK-${payload.ticketId}: ${message}`)
      throw error
    }
  }

  const handleArchiveTicket = async (ticket: Ticket) => {
    if (ticket.id < 0) {
      notify('warning', 'Wait for ticket creation to complete before archiving.')
      return
    }

    if (archivingTicketIds.has(ticket.id) || movingTicketIds.has(ticket.id)) {
      return
    }

    const optimisticArchived: Ticket = {
      ...ticket,
      archived_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    setOptimisticTickets((previous) => {
      const next = new Map(previous)
      next.set(ticket.id, optimisticArchived)
      return next
    })
    setArchivingTicketIds((previous) => {
      const next = new Set(previous)
      next.add(ticket.id)
      return next
    })

    try {
      await archiveTicketMutation.mutate({ ticketId: ticket.id, actor: 'User' })
      setWarningByTicketId((previous) => {
        if (!previous.has(ticket.id)) {
          return previous
        }
        const next = new Map(previous)
        next.delete(ticket.id)
        return next
      })
      notify('success', `Archived TASK-${ticket.id}.`)
      await ticketsQuery.refetch()
      setOptimisticTickets((previous) => {
        if (!previous.has(ticket.id)) {
          return previous
        }
        const next = new Map(previous)
        next.delete(ticket.id)
        return next
      })
    } catch (error) {
      setOptimisticTickets((previous) => {
        if (!previous.has(ticket.id)) {
          return previous
        }
        const next = new Map(previous)
        next.delete(ticket.id)
        return next
      })
      const message = error instanceof Error ? error.message : 'Request failed'
      notify('error', `Archive failed for TASK-${ticket.id}: ${message}`)
    } finally {
      setArchivingTicketIds((previous) => {
        if (!previous.has(ticket.id)) {
          return previous
        }
        const next = new Set(previous)
        next.delete(ticket.id)
        return next
      })
    }
  }

  const resolveTargetStatus = (overId: UniqueIdentifier | undefined): TicketStatus | null => {
    if (typeof overId !== 'string') {
      return null
    }

    const laneStatus = parseLaneDropId(overId)
    if (laneStatus) {
      return laneStatus
    }

    const ticketId = parseTicketItemId(overId)
    if (ticketId === null) {
      return null
    }

    return ticketById.get(ticketId)?.status ?? null
  }

  const handleDragEnd = (event: DragEndEvent) => {
    if (typeof event.active.id !== 'string') {
      setActiveDragTicketId(null)
      return
    }

    const ticketId = parseTicketItemId(event.active.id)
    if (ticketId === null) {
      setActiveDragTicketId(null)
      return
    }

    const overId = typeof event.over?.id === 'string' ? event.over.id : null
    setActiveDragTicketId(null)

    if (overId === ARCHIVE_NAV_DROP_ID) {
      const ticket = ticketById.get(ticketId)
      if (ticket) {
        void handleArchiveTicket(ticket)
      }
      return
    }

    const targetStatus = resolveTargetStatus(overId ?? undefined)

    if (!targetStatus) {
      return
    }

    void moveTicket(ticketId, targetStatus)
  }

  const handleDragStart = (event: DragStartEvent) => {
    if (typeof event.active.id !== 'string') {
      setActiveDragTicketId(null)
      return
    }

    setActiveDragTicketId(parseTicketItemId(event.active.id))
  }

  return (
    <section className="dashboard-content" aria-label="Dashboard board scaffold">
      <Card className="health-row">
        <Tag>API {healthQuery.data?.ok ? 'OK' : 'Checking'}</Tag>
        <Tag tone={gatewayTone(gatewayQuery.data?.gateway)}>
          Gateway {gatewayQuery.data?.gateway ?? 'checking'}
        </Tag>
        <Tag>Assignees {configData?.assignees.length ?? 0}</Tag>
        <Tag>Total Tickets {filteredTickets.length}</Tag>
      </Card>

      {banners.map((banner) => (
        <p key={`${banner.title}:${banner.message}`} className={cn('oc-banner', `oc-banner--${banner.tone}`)}>
          <strong>{banner.title}:</strong> {banner.message}
        </p>
      ))}

      {warningSummaries.length > 0 ? (
        <Card className="pickup-warning-summary" elevated>
          <h3>Pickup Warnings</h3>
          <ul>
            {warningSummaries.map(([ticketId, warnings]) => (
              <li key={ticketId}>
                <strong>TASK-{ticketId}:</strong> {warnings[0]}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {showBoardEmptyState ? (
        <Card className="board-empty-state" elevated>
          <h3>No tickets yet</h3>
          <p>Create your first ticket to start the board workflow.</p>
        </Card>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragCancel={() => setActiveDragTicketId(null)}
        onDragEnd={handleDragEnd}
      >
        <ArchiveNavDropTarget active={activeDragTicketId !== null} />

        <div className="board-grid">
          {statuses.map((status) => {
            const laneTickets = lanes.get(status) ?? []
            return (
              <KanbanColumn
                key={status}
                status={status}
                tickets={laneTickets}
                isLoading={ticketsQuery.isLoading}
                hasError={hasTicketError}
                searchValue={searchValue}
                movingTicketIds={movingTicketIds}
                archivingTicketIds={archivingTicketIds}
                editingTicketId={editingTicketId}
                warningByTicketId={warningByTicketId}
                onEditTicket={handleOpenEditTicket}
              />
            )
          })}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeDragTicket ? <DragTicketOverlay ticket={activeDragTicket} warnings={activeDragWarnings} /> : null}
        </DragOverlay>
      </DndContext>

      <EditTicketPanel
        open={editingTicketId !== null}
        ticket={editingTicket}
        assigneeOptions={configData?.assignees ?? ['Unassigned']}
        priorityOptions={configData?.priorities ?? DEFAULT_PRIORITIES}
        isPending={updateTicketMutation.isPending}
        onClose={() => setEditingTicketId(null)}
        onSubmit={handleSubmitEditTicket}
      />
    </section>
  )
}

function ArchiveNavDropTarget({ active }: { active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: ARCHIVE_NAV_DROP_ID })
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null)

  useEffect(() => {
    const readRect = () => {
      const navLink = document.querySelector<HTMLElement>('[data-nav-path="/archived"]')
      if (!navLink) {
        setRect(null)
        return
      }
      const next = navLink.getBoundingClientRect()
      setRect({
        top: next.top,
        left: next.left,
        width: next.width,
        height: next.height,
      })
    }

    readRect()
    window.addEventListener('resize', readRect)
    window.addEventListener('scroll', readRect, true)

    return () => {
      window.removeEventListener('resize', readRect)
      window.removeEventListener('scroll', readRect, true)
    }
  }, [active])

  useEffect(() => {
    const navLink = document.querySelector<HTMLElement>('[data-nav-path="/archived"]')
    if (!navLink) {
      return
    }

    navLink.classList.toggle('sidebar-link-drop-target', active)
    navLink.classList.toggle('sidebar-link-drop-over', active && isOver)

    return () => {
      navLink.classList.remove('sidebar-link-drop-target')
      navLink.classList.remove('sidebar-link-drop-over')
    }
  }, [active, isOver])

  if (!rect) {
    return null
  }

  return (
    <div
      ref={setNodeRef}
      aria-hidden="true"
      className={cn('archive-nav-dropzone', active && 'archive-nav-dropzone-active', isOver && 'archive-nav-dropzone-over')}
      style={{
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      }}
    />
  )
}

function ArchivedPage() {
  const { searchValue, refreshToken, configData, notify } = useAppShellContext()
  const archivedQuery = useTicketsQuery({ archived: true }, refreshToken)
  useTicketRealtimeRefetch(archivedQuery.refetch)
  const updateTicketMutation = useUpdateTicketMutation()
  const [editingTicketId, setEditingTicketId] = useState<number | null>(null)

  const filteredTickets = useMemo(() => {
    const search = searchValue.trim().toLowerCase()
    const tickets = archivedQuery.data ?? []
    if (!search) {
      return tickets
    }

    return tickets.filter((ticket) =>
      [ticket.title, ticket.description, ticket.assignee].some((value) => value.toLowerCase().includes(search)),
    )
  }, [archivedQuery.data, searchValue])

  const editingTicket = useMemo(() => {
    if (editingTicketId === null) {
      return null
    }
    return (archivedQuery.data ?? []).find((ticket) => ticket.id === editingTicketId) ?? null
  }, [archivedQuery.data, editingTicketId])

  const assigneeOptions = useMemo(() => {
    const configured = configData?.assignees ?? ['Unassigned']
    return configured.length > 0 ? configured : ['Unassigned']
  }, [configData?.assignees])

  const priorityOptions = useMemo(() => {
    const configured = configData?.priorities ?? DEFAULT_PRIORITIES
    return configured.length > 0 ? configured : DEFAULT_PRIORITIES
  }, [configData?.priorities])

  const handleSubmitEditTicket = async (payload: { ticketId: number; input: UpdateTicketRequest }) => {
    try {
      await updateTicketMutation.mutate(payload)
      setEditingTicketId(null)
      notify('success', `Saved TASK-${payload.ticketId}.`)
      await archivedQuery.refetch()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed'
      notify('error', `Save failed for TASK-${payload.ticketId}: ${message}`)
      throw error
    }
  }

  return (
    <section className="dashboard-content" aria-label="Archived tickets">
      <Card className="archived-table-card" elevated>
        <h2 className="archived-table-title">Archived Tickets</h2>

        {archivedQuery.isLoading ? <p className="archived-table-state">Loading archived tickets...</p> : null}
        {!archivedQuery.isLoading && archivedQuery.uiError ? (
          <p className="archived-table-state">
            <strong>{archivedQuery.uiError.title}:</strong> {archivedQuery.uiError.message}
          </p>
        ) : null}
        {!archivedQuery.isLoading && !archivedQuery.uiError && filteredTickets.length === 0 ? (
          <p className="archived-table-state">No archived tickets found.</p>
        ) : null}

        {!archivedQuery.isLoading && !archivedQuery.uiError && filteredTickets.length > 0 ? (
          <div className="archived-table-wrap">
            <table className="archived-table">
              <thead>
                <tr>
                  <th scope="col">Ticket</th>
                  <th scope="col">Title</th>
                  <th scope="col">Status</th>
                  <th scope="col">Assignee</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Archived</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {filteredTickets.map((ticket) => (
                  <tr key={ticket.id}>
                    <td>
                      <button type="button" className="archived-ticket-link" onClick={() => setEditingTicketId(ticket.id)}>
                        TASK-{ticket.id}
                      </button>
                    </td>
                    <td>{ticket.title}</td>
                    <td>{ticket.status}</td>
                    <td>{ticket.assignee}</td>
                    <td>{ticket.priority}</td>
                    <td>{formatUpdatedAtDisplay(ticket.archived_at ?? ticket.updated_at)}</td>
                    <td>{formatUpdatedAtDisplay(ticket.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      <EditTicketPanel
        open={editingTicketId !== null}
        ticket={editingTicket}
        assigneeOptions={assigneeOptions}
        priorityOptions={priorityOptions}
        isPending={updateTicketMutation.isPending}
        onClose={() => setEditingTicketId(null)}
        onSubmit={handleSubmitEditTicket}
      />
    </section>
  )
}

function ActivityPage() {
  const { searchValue, refreshToken } = useAppShellContext()
  const [activeEventType, setActiveEventType] = useState<string>('all')
  const activityQuery = useActivityQuery({ limit: 400, includeArchived: false }, refreshToken)
  useTicketRealtimeRefetch(activityQuery.refetch)

  const events = activityQuery.data ?? []
  const filteredEvents = useMemo(() => {
    const search = searchValue.trim().toLowerCase()
    return events.filter((event) => {
      if (activeEventType !== 'all' && event.event_type !== activeEventType) {
        return false
      }

      if (!search) {
        return true
      }

      const haystack = [
        `task-${event.ticket_id}`,
        event.ticket_title,
        event.ticket_status,
        event.ticket_assignee,
        event.event_type,
        event.actor ?? '',
        event.details,
      ]
        .join(' ')
        .toLowerCase()

      return haystack.includes(search)
    })
  }, [activeEventType, events, searchValue])

  const eventTypeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const event of events) {
      counts.set(event.event_type, (counts.get(event.event_type) ?? 0) + 1)
    }
    return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])
  }, [events])

  const touchedTickets = useMemo(() => {
    return new Set(filteredEvents.map((event) => event.ticket_id)).size
  }, [filteredEvents])

  const movedCount = useMemo(() => {
    return filteredEvents.filter((event) => event.event_type === 'ticket_moved').length
  }, [filteredEvents])

  const commentCount = useMemo(() => {
    return filteredEvents.filter((event) => event.event_type === 'comment_added').length
  }, [filteredEvents])

  return (
    <section className="dashboard-content" aria-label="Global activity feed">
      <Card className="activity-summary-row">
        <Tag>Realtime Feed</Tag>
        <Tag>Total Events {filteredEvents.length}</Tag>
        <Tag>Tickets Touched {touchedTickets}</Tag>
        <Tag>Moves {movedCount}</Tag>
        <Tag>Comments {commentCount}</Tag>
      </Card>

      <Card className="activity-feed-card" elevated>
        <header className="activity-feed-head">
          <h2>Activity Stream</h2>
          <p>Auto-updates from websocket events across all active tickets.</p>
        </header>

        <div className="activity-filter-row">
          <button
            type="button"
            className={cn('activity-filter-btn', activeEventType === 'all' && 'activity-filter-btn-active')}
            onClick={() => setActiveEventType('all')}
          >
            All
          </button>
          {eventTypeCounts.map(([eventType, count]) => (
            <button
              key={eventType}
              type="button"
              className={cn('activity-filter-btn', activeEventType === eventType && 'activity-filter-btn-active')}
              onClick={() => setActiveEventType(eventType)}
            >
              {prettifyEventType(eventType)} ({count})
            </button>
          ))}
        </div>

        {activityQuery.uiError ? (
          <p className="activity-feed-state">
            <strong>{activityQuery.uiError.title}:</strong> {activityQuery.uiError.message}
          </p>
        ) : null}
        {activityQuery.isLoading ? <p className="activity-feed-state">Loading activity feed...</p> : null}
        {!activityQuery.isLoading && !activityQuery.uiError && filteredEvents.length === 0 ? (
          <p className="activity-feed-state">No matching activity events.</p>
        ) : null}

        {!activityQuery.isLoading && !activityQuery.uiError && filteredEvents.length > 0 ? (
          <ul className="activity-feed-list">
            {filteredEvents.map((event) => (
              <li key={event.id}>
                <article className={cn('activity-item', `activity-item--${activityClassForEvent(event.event_type)}`)}>
                  <header className="activity-item-head">
                    <div className="activity-item-head-left">
                      <Tag tone={activityToneForEvent(event.event_type)}>{prettifyEventType(event.event_type)}</Tag>
                      <p className="activity-item-ticket">
                        <strong>TASK-{event.ticket_id}</strong> {event.ticket_title}
                      </p>
                    </div>
                    <time className="activity-item-time">{formatUpdatedAtDisplay(event.created_at)}</time>
                  </header>

                  <div className="activity-item-meta">
                    <span>Assignee {event.ticket_assignee}</span>
                    <span>Status {event.ticket_status}</span>
                    <span>Actor {event.actor ?? 'System'}</span>
                  </div>

                  <p className="activity-item-details">{event.details || '(no details)'}</p>
                </article>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </section>
  )
}

function SessionsMonitorPage() {
  const { searchValue, refreshToken } = useAppShellContext()
  const [sessionLimit, setSessionLimit] = useState(200)
  const [historyLimit, setHistoryLimit] = useState(160)
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'errors' | 'idle'>('all')
  const [agentFocus, setAgentFocus] = useState<'all' | 'running' | 'errors' | 'idle'>('all')
  const [agentSearchValue, setAgentSearchValue] = useState('')
  const [selectedAgentKeys, setSelectedAgentKeys] = useState<string[]>([])
  const [expandedAgentOverrides, setExpandedAgentOverrides] = useState<Record<string, boolean>>({})
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null)

  const sessionsQuery = useGatewaySessionsActivityQuery({ sessionLimit, historyLimit }, refreshToken)
  useTicketRealtimeRefetch(sessionsQuery.refetch)

  const sessions = useMemo(() => sessionsQuery.data?.sessions ?? [], [sessionsQuery.data?.sessions])
  const filteredSessions = useMemo(() => {
    const search = searchValue.trim().toLowerCase()

    return sessions.filter((session) => {
      if (!sessionMatchesStatusFilter(session, statusFilter)) {
        return false
      }
      if (!search) {
        return true
      }

      return sessionSearchHaystack(session).includes(search)
    })
  }, [searchValue, sessions, statusFilter])

  const allAgentGroups = useMemo(() => buildAgentSessionGroups(sessions), [sessions])
  const agentRailGroups = useMemo(() => {
    const search = agentSearchValue.trim().toLowerCase()

    return allAgentGroups.filter((group) => {
      if (agentFocus === 'running' && group.runningCount <= 0) {
        return false
      }
      if (agentFocus === 'errors' && group.errorCount <= 0) {
        return false
      }
      if (agentFocus === 'idle' && (group.runningCount > 0 || group.errorCount > 0)) {
        return false
      }

      if (!search) {
        return true
      }

      return group.label.toLowerCase().includes(search) || group.key.toLowerCase().includes(search)
    })
  }, [agentFocus, agentSearchValue, allAgentGroups])

  const availableAgentKeys = useMemo(() => new Set(allAgentGroups.map((group) => group.key)), [allAgentGroups])
  const effectiveSelectedAgentKeys = useMemo(
    () => selectedAgentKeys.filter((key) => availableAgentKeys.has(key)),
    [availableAgentKeys, selectedAgentKeys],
  )

  const selectedAgentSet = useMemo(() => {
    if (effectiveSelectedAgentKeys.length === 0) {
      return null
    }
    return new Set(effectiveSelectedAgentKeys)
  }, [effectiveSelectedAgentKeys])

  const groupedSessions = useMemo(() => {
    const map = new Map<string, AgentSessionGroup>()

    for (const session of filteredSessions) {
      const groupKey = agentKeyForSession(session)
      if (selectedAgentSet && !selectedAgentSet.has(groupKey)) {
        continue
      }

      const existing = map.get(groupKey)
      if (!existing) {
        map.set(groupKey, {
          key: groupKey,
          label: agentLabelForSession(session),
          sessions: [session],
          totalSessions: 1,
          runningCount: session.runningCount,
          errorCount: session.errorCount > 0 || Boolean(session.historyError) ? 1 : 0,
          updatedAtMs: sessionUpdatedAtMs(session),
          updatedAt: session.updatedAt,
        })
        continue
      }

      existing.sessions.push(session)
      existing.totalSessions += 1
      existing.runningCount += session.runningCount
      if (session.errorCount > 0 || Boolean(session.historyError)) {
        existing.errorCount += 1
      }

      const updatedAtMs = sessionUpdatedAtMs(session)
      if (updatedAtMs > existing.updatedAtMs) {
        existing.updatedAtMs = updatedAtMs
        existing.updatedAt = session.updatedAt
      }
    }

    const groups = Array.from(map.values())
    for (const group of groups) {
      group.sessions.sort((left, right) => {
        const rankDiff = sessionRank(left) - sessionRank(right)
        if (rankDiff !== 0) {
          return rankDiff
        }
        return sessionUpdatedAtMs(right) - sessionUpdatedAtMs(left)
      })
    }

    groups.sort((left, right) => {
      const leftRank = groupRank(left)
      const rightRank = groupRank(right)
      if (leftRank !== rightRank) {
        return leftRank - rightRank
      }
      return right.updatedAtMs - left.updatedAtMs
    })

    return groups
  }, [filteredSessions, selectedAgentSet])

  const visibleSessions = useMemo(() => groupedSessions.flatMap((group) => group.sessions), [groupedSessions])
  const effectiveSelectedSessionKey = useMemo(() => {
    if (visibleSessions.length === 0) {
      return null
    }
    if (selectedSessionKey && visibleSessions.some((session) => session.key === selectedSessionKey)) {
      return selectedSessionKey
    }
    return visibleSessions[0].key
  }, [selectedSessionKey, visibleSessions])

  const selectedSession = useMemo(() => {
    if (!effectiveSelectedSessionKey) {
      return null
    }
    return visibleSessions.find((session) => session.key === effectiveSelectedSessionKey) ?? null
  }, [effectiveSelectedSessionKey, visibleSessions])

  const activeAgents = allAgentGroups.length
  const runningCommands = useMemo(
    () => visibleSessions.reduce((total, session) => total + session.runningCount, 0),
    [visibleSessions],
  )
  const erroredSessions = useMemo(
    () => visibleSessions.filter((session) => session.errorCount > 0 || Boolean(session.historyError)).length,
    [visibleSessions],
  )
  const isAgentExpanded = (group: AgentSessionGroup) => {
    if (Object.prototype.hasOwnProperty.call(expandedAgentOverrides, group.key)) {
      return expandedAgentOverrides[group.key]
    }
    return group.runningCount > 0 || group.errorCount > 0
  }
  const expandedSessionCount = groupedSessions.reduce(
    (total, group) => total + (isAgentExpanded(group) ? group.sessions.length : 0),
    0,
  )

  const toggleAgentSelection = (agentKey: string) => {
    setSelectedAgentKeys((previous) => {
      if (previous.includes(agentKey)) {
        return previous.filter((value) => value !== agentKey)
      }
      return [...previous, agentKey]
    })
  }

  const selectedAgentLabelByKey = useMemo(() => {
    const mapping = new Map<string, string>()
    for (const group of allAgentGroups) {
      mapping.set(group.key, group.label)
    }
    return mapping
  }, [allAgentGroups])

  const expandAllAgents = () => {
    setExpandedAgentOverrides((previous) => {
      const next = { ...previous }
      for (const group of groupedSessions) {
        next[group.key] = true
      }
      return next
    })
  }

  const collapseAllAgents = () => {
    setExpandedAgentOverrides((previous) => {
      const next = { ...previous }
      for (const group of groupedSessions) {
        next[group.key] = false
      }
      return next
    })
  }

  const expandCriticalAgents = () => {
    setExpandedAgentOverrides((previous) => {
      const next = { ...previous }
      for (const group of groupedSessions) {
        next[group.key] = group.runningCount > 0 || group.errorCount > 0
      }
      return next
    })
  }

  return (
    <section className="dashboard-content" aria-label="Session and command monitor">
      <Card className="sessions-monitor-summary">
        <Tag>Total Sessions {visibleSessions.length}</Tag>
        <Tag>Active Agents {activeAgents}</Tag>
        <Tag tone={runningCommands > 0 ? 'warning' : 'default'}>Running Commands {runningCommands}</Tag>
        <Tag tone={erroredSessions > 0 ? 'danger' : 'default'}>Sessions With Errors {erroredSessions}</Tag>
        <Tag>Expanded Rows {expandedSessionCount}</Tag>
      </Card>

      <Card className="sessions-monitor-shell" elevated>
        <aside className="sessions-agent-rail" aria-label="Agent filters">
          <header className="sessions-pane-head">
            <div>
              <h3>Agents</h3>
              <p>Select one or more agents to narrow session groups.</p>
            </div>
            {effectiveSelectedAgentKeys.length > 0 ? (
              <Button variant="ghost" onClick={() => setSelectedAgentKeys([])}>
                Clear
              </Button>
            ) : null}
          </header>

          <label className="sessions-agent-search">
            <span>Find Agent</span>
            <Input
              value={agentSearchValue}
              onChange={(event) => setAgentSearchValue(event.target.value)}
              placeholder="Filter by agent name"
            />
          </label>

          <div className="sessions-monitor-filter-row">
            <button
              type="button"
              className={cn('activity-filter-btn', agentFocus === 'all' && 'activity-filter-btn-active')}
              onClick={() => setAgentFocus('all')}
            >
              All
            </button>
            <button
              type="button"
              className={cn('activity-filter-btn', agentFocus === 'running' && 'activity-filter-btn-active')}
              onClick={() => setAgentFocus('running')}
            >
              Running
            </button>
            <button
              type="button"
              className={cn('activity-filter-btn', agentFocus === 'errors' && 'activity-filter-btn-active')}
              onClick={() => setAgentFocus('errors')}
            >
              Errors
            </button>
            <button
              type="button"
              className={cn('activity-filter-btn', agentFocus === 'idle' && 'activity-filter-btn-active')}
              onClick={() => setAgentFocus('idle')}
            >
              Idle
            </button>
          </div>

          <ul className="sessions-agent-list">
            {agentRailGroups.map((group) => {
              const selected = effectiveSelectedAgentKeys.includes(group.key)
              return (
                <li key={group.key}>
                  <button
                    type="button"
                    className={cn('sessions-agent-item', selected && 'sessions-agent-item-active')}
                    onClick={() => toggleAgentSelection(group.key)}
                  >
                    <div className="sessions-agent-item-head">
                      <p>{group.label}</p>
                      <Tag>{group.totalSessions}</Tag>
                    </div>
                    <p className="sessions-agent-item-meta">
                      Running {group.runningCount} • Errors {group.errorCount}
                    </p>
                  </button>
                </li>
              )
            })}
          </ul>
        </aside>

        <section className="sessions-center-pane" aria-label="Session groups">
          <header className="sessions-pane-head">
            <div>
              <h3>Sessions</h3>
              <p>Grouped by agent. Expand critical groups to inspect command activity quickly.</p>
            </div>
          </header>

          <div className="sessions-center-controls">
            <div className="sessions-monitor-filter-row">
              <button
                type="button"
                className={cn('activity-filter-btn', statusFilter === 'all' && 'activity-filter-btn-active')}
                onClick={() => setStatusFilter('all')}
              >
                All
              </button>
              <button
                type="button"
                className={cn('activity-filter-btn', statusFilter === 'running' && 'activity-filter-btn-active')}
                onClick={() => setStatusFilter('running')}
              >
                Running
              </button>
              <button
                type="button"
                className={cn('activity-filter-btn', statusFilter === 'errors' && 'activity-filter-btn-active')}
                onClick={() => setStatusFilter('errors')}
              >
                Errors
              </button>
              <button
                type="button"
                className={cn('activity-filter-btn', statusFilter === 'idle' && 'activity-filter-btn-active')}
                onClick={() => setStatusFilter('idle')}
              >
                Idle
              </button>
            </div>

            <div className="sessions-center-action-row">
              <Button variant="ghost" onClick={expandAllAgents}>
                Expand All
              </Button>
              <Button variant="ghost" onClick={collapseAllAgents}>
                Collapse All
              </Button>
              <Button variant="ghost" onClick={expandCriticalAgents}>
                Critical Only
              </Button>
            </div>

            <div className="sessions-monitor-input-row">
              <label className="sessions-monitor-input">
                <span>Sessions</span>
                <Input
                  type="number"
                  min={1}
                  max={200}
                  value={String(sessionLimit)}
                  onChange={(event) => {
                    const next = Number.parseInt(event.target.value, 10)
                    if (Number.isFinite(next)) {
                      setSessionLimit(Math.min(200, Math.max(1, next)))
                    }
                  }}
                />
              </label>
              <label className="sessions-monitor-input">
                <span>History / session</span>
                <Input
                  type="number"
                  min={1}
                  max={500}
                  value={String(historyLimit)}
                  onChange={(event) => {
                    const next = Number.parseInt(event.target.value, 10)
                    if (Number.isFinite(next)) {
                      setHistoryLimit(Math.min(500, Math.max(1, next)))
                    }
                  }}
                />
              </label>
            </div>

            {effectiveSelectedAgentKeys.length > 0 ? (
              <div className="sessions-active-filter-row">
                {effectiveSelectedAgentKeys.map((agentKey) => (
                  <button
                    key={agentKey}
                    type="button"
                    className="sessions-filter-chip"
                    onClick={() => toggleAgentSelection(agentKey)}
                  >
                    {selectedAgentLabelByKey.get(agentKey) ?? agentKey}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="sessions-center-body">
            {sessionsQuery.uiError ? (
              <p className="activity-feed-state">
                <strong>{sessionsQuery.uiError.title}:</strong> {sessionsQuery.uiError.message}
              </p>
            ) : null}
            {sessionsQuery.isLoading ? <p className="activity-feed-state">Loading session monitor...</p> : null}
            {!sessionsQuery.isLoading && !sessionsQuery.uiError && groupedSessions.length === 0 ? (
              <p className="activity-feed-state">No sessions match the current filters.</p>
            ) : null}

            {!sessionsQuery.isLoading && !sessionsQuery.uiError && groupedSessions.length > 0 ? (
              <ul className="sessions-agent-groups">
                {groupedSessions.map((group) => {
                  const expanded = isAgentExpanded(group)
                  return (
                    <li key={group.key} className="sessions-agent-group">
                      <button
                        type="button"
                        className="sessions-agent-group-head"
                        onClick={() =>
                          setExpandedAgentOverrides((previous) => ({
                            ...previous,
                            [group.key]: !expanded,
                          }))
                        }
                      >
                        <div className="sessions-agent-group-summary">
                          <p className="sessions-agent-group-title">{group.label}</p>
                          <p className="sessions-agent-group-meta">
                            Sessions {group.totalSessions} • Updated{' '}
                            {group.updatedAt ? formatUpdatedAtDisplay(group.updatedAt) : 'unknown'}
                          </p>
                        </div>
                        <div className="sessions-agent-group-tags">
                          <Tag tone={group.runningCount > 0 ? 'warning' : 'default'}>Running {group.runningCount}</Tag>
                          <Tag tone={group.errorCount > 0 ? 'danger' : 'default'}>Errors {group.errorCount}</Tag>
                          <Tag>{expanded ? 'Expanded' : 'Collapsed'}</Tag>
                        </div>
                      </button>

                      {expanded ? (
                        <ul className="sessions-agent-group-list">
                          {group.sessions.map((session) => {
                            const isSelected = selectedSession?.key === session.key
                            const sessionLabelValue = `${agentLabelForSession(session)} / ${session.channel ?? 'unknown'} / ${shortSessionKey(
                              session.key,
                            )}`
                            return (
                              <li key={session.key}>
                                <button
                                  type="button"
                                  className={cn('session-row-button', isSelected && 'session-row-button-active')}
                                  onClick={() => setSelectedSessionKey(session.key)}
                                >
                                  <div className="session-row-head">
                                    <div className="session-row-main">
                                      <p className="session-row-title">{sessionLabelValue}</p>
                                      <p className="session-row-sub">
                                        {session.displayName ?? 'No display name'} • Updated{' '}
                                        {session.updatedAt ? formatUpdatedAtDisplay(session.updatedAt) : 'unknown'}
                                      </p>
                                    </div>
                                    <div className="session-row-tags">
                                      <Tag tone={sessionTone(session)}>{sessionLabel(session.status)}</Tag>
                                      <Tag tone={session.runningCount > 0 ? 'warning' : 'default'}>
                                        Running {session.runningCount}
                                      </Tag>
                                      <Tag tone={session.errorCount > 0 ? 'danger' : 'default'}>Errors {session.errorCount}</Tag>
                                    </div>
                                  </div>

                                  {session.tickets.length > 0 ? (
                                    <div className="session-monitor-ticket-row">
                                      {session.tickets.map((ticket) => (
                                        <span key={ticket.id} className="session-ticket-chip">
                                          TASK-{ticket.id} {ticket.title}
                                        </span>
                                      ))}
                                    </div>
                                  ) : null}

                                  {session.lastCommandPreview ? (
                                    <p className="session-row-preview">{session.lastCommandPreview}</p>
                                  ) : (
                                    <p className="panel-inline-muted">No command preview captured for this session.</p>
                                  )}
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </div>
        </section>

        <aside className="sessions-detail-pane" aria-label="Selected session detail">
          <header className="sessions-pane-head">
            <div>
              <h3>Session Detail</h3>
              <p>Full metadata and command timeline for the selected session.</p>
            </div>
          </header>

          {selectedSession ? (
            <div className="sessions-detail-body">
              <p className="sessions-detail-key">{selectedSession.key}</p>
              <p className="sessions-detail-meta">
                Agent {agentLabelForSession(selectedSession)} • Channel {selectedSession.channel ?? 'unknown'} • Model{' '}
                {selectedSession.model ?? 'unknown'}
              </p>
              <div className="sessions-detail-tags">
                <Tag tone={sessionTone(selectedSession)}>{sessionLabel(selectedSession.status)}</Tag>
                <Tag tone={selectedSession.runningCount > 0 ? 'warning' : 'default'}>
                  Running {selectedSession.runningCount}
                </Tag>
                <Tag tone={selectedSession.errorCount > 0 ? 'danger' : 'default'}>Errors {selectedSession.errorCount}</Tag>
              </div>

              {selectedSession.historyError ? (
                <p className="session-monitor-error">{selectedSession.historyError}</p>
              ) : null}

              {selectedSession.tickets.length > 0 ? (
                <div className="sessions-detail-block">
                  <p className="sessions-detail-label">Linked Tickets</p>
                  <div className="session-monitor-ticket-row">
                    {selectedSession.tickets.map((ticket) => (
                      <span key={ticket.id} className="session-ticket-chip">
                        TASK-{ticket.id} {ticket.title}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="sessions-detail-block">
                <p className="sessions-detail-label">Commands</p>
                {selectedSession.commands.length > 0 ? (
                  <ul className="session-command-list">
                    {selectedSession.commands.slice(0, 12).map((command) => (
                      <li key={command.callId} className="session-command-row">
                        <div className="session-command-head">
                          <Tag tone={commandTone(command.status)}>{command.status}</Tag>
                          <p className="session-command-time">
                            {command.updatedAt ? formatUpdatedAtDisplay(command.updatedAt) : 'unknown'}
                          </p>
                        </div>
                        <code className="session-command-code">{command.command ?? '(no command payload)'}</code>
                        {command.preview ? <p className="session-command-preview">{command.preview}</p> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="panel-inline-muted">No command activity captured for this session.</p>
                )}
              </div>
            </div>
          ) : (
            <p className="activity-feed-state">Select a session row to inspect details.</p>
          )}
        </aside>
      </Card>
    </section>
  )
}

function WorkspaceRoute() {
  const { searchValue, refreshToken, notify } = useAppShellContext()
  return <WorkspacePage searchValue={searchValue} refreshToken={refreshToken} notify={notify} />
}

function PlaceholderPage(props: { title: string; description: string }) {
  return (
    <Card className="placeholder-card" elevated aria-label={`${props.title} placeholder`}>
      <h2>{props.title}</h2>
      <p>{props.description}</p>
    </Card>
  )
}

function gatewayTone(gateway: 'disabled' | 'reachable' | 'unreachable' | undefined) {
  if (gateway === 'reachable') {
    return 'default' as const
  }

  if (gateway === 'disabled') {
    return 'warning' as const
  }

  if (gateway === 'unreachable') {
    return 'danger' as const
  }

  return 'default' as const
}

function sessionLabel(value: string): string {
  return value.replace(/_/g, ' ')
}

function sessionTone(session: GatewaySessionActivity): 'default' | 'warning' | 'danger' {
  if (session.errorCount > 0 || Boolean(session.historyError) || session.status.includes('error')) {
    return 'danger'
  }
  if (session.runningCount > 0 || ['running', 'active', 'queued', 'started'].includes(session.status)) {
    return 'warning'
  }
  return 'default'
}

function commandTone(status: string): 'default' | 'warning' | 'danger' {
  if (status === 'error') {
    return 'danger'
  }
  if (status === 'running') {
    return 'warning'
  }
  return 'default'
}

function agentKeyForSession(session: GatewaySessionActivity): string {
  const raw = (session.agentId ?? session.agentName ?? 'unknown').trim()
  return raw ? raw.toLowerCase() : 'unknown'
}

function agentLabelForSession(session: GatewaySessionActivity): string {
  const raw = (session.agentName ?? session.agentId ?? 'unknown').trim()
  return raw || 'unknown'
}

function shortSessionKey(key: string): string {
  const parts = key.split(':').filter((value) => value.length > 0)
  if (parts.length >= 2) {
    return parts.slice(-2).join(':')
  }
  if (key.length <= 26) {
    return key
  }
  return `${key.slice(0, 12)}...${key.slice(-10)}`
}

function sessionUpdatedAtMs(session: GatewaySessionActivity): number {
  if (!session.updatedAt) {
    return 0
  }
  const parsed = new Date(session.updatedAt).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function sessionMatchesStatusFilter(
  session: GatewaySessionActivity,
  filter: 'all' | 'running' | 'errors' | 'idle',
): boolean {
  if (filter === 'running') {
    return session.runningCount > 0
  }
  if (filter === 'errors') {
    return session.errorCount > 0 || Boolean(session.historyError)
  }
  if (filter === 'idle') {
    return session.commandCount <= 0 && session.runningCount <= 0
  }
  return true
}

function sessionSearchHaystack(session: GatewaySessionActivity): string {
  return [
    session.key,
    session.status,
    session.kind ?? '',
    session.channel ?? '',
    session.displayName ?? '',
    session.agentId ?? '',
    session.agentName ?? '',
    session.lastCommandPreview ?? '',
    ...session.tickets.map((ticket) => `${ticket.id} ${ticket.title} ${ticket.assignee}`),
    ...session.commands.slice(0, 8).map((command) => `${command.toolName} ${command.command ?? ''} ${command.preview ?? ''}`),
  ]
    .join(' ')
    .toLowerCase()
}

function sessionRank(session: GatewaySessionActivity): number {
  if (session.errorCount > 0 || Boolean(session.historyError) || session.status.includes('error')) {
    return 0
  }
  if (session.runningCount > 0 || ['running', 'active', 'queued', 'started'].includes(session.status)) {
    return 1
  }
  return 2
}

function groupRank(group: AgentSessionGroup): number {
  if (group.errorCount > 0) {
    return 0
  }
  if (group.runningCount > 0) {
    return 1
  }
  return 2
}

function buildAgentSessionGroups(sessions: GatewaySessionActivity[]): AgentSessionGroup[] {
  const map = new Map<string, AgentSessionGroup>()

  for (const session of sessions) {
    const key = agentKeyForSession(session)
    const existing = map.get(key)
    if (!existing) {
      map.set(key, {
        key,
        label: agentLabelForSession(session),
        sessions: [session],
        totalSessions: 1,
        runningCount: session.runningCount,
        errorCount: session.errorCount > 0 || Boolean(session.historyError) ? 1 : 0,
        updatedAtMs: sessionUpdatedAtMs(session),
        updatedAt: session.updatedAt,
      })
      continue
    }

    existing.sessions.push(session)
    existing.totalSessions += 1
    existing.runningCount += session.runningCount
    if (session.errorCount > 0 || Boolean(session.historyError)) {
      existing.errorCount += 1
    }

    const updatedMs = sessionUpdatedAtMs(session)
    if (updatedMs > existing.updatedAtMs) {
      existing.updatedAtMs = updatedMs
      existing.updatedAt = session.updatedAt
    }
  }

  const groups = Array.from(map.values())
  groups.sort((left, right) => {
    const rankDiff = groupRank(left) - groupRank(right)
    if (rankDiff !== 0) {
      return rankDiff
    }
    return right.updatedAtMs - left.updatedAtMs
  })

  return groups
}

function mergeTickets(
  serverTickets: Ticket[],
  pendingTickets: Ticket[],
  optimisticTickets: Map<number, Ticket>,
): Ticket[] {
  const map = new Map<number, Ticket>()

  for (const ticket of pendingTickets) {
    map.set(ticket.id, ticket)
  }

  for (const ticket of serverTickets) {
    map.set(ticket.id, ticket)
  }

  for (const [ticketId, ticket] of optimisticTickets.entries()) {
    map.set(ticketId, ticket)
  }

  return Array.from(map.values())
}

function collectMoveWarnings(response: { warnings: string[]; pickup: { spawned: boolean; reason?: string } }): string[] {
  const warnings = [...response.warnings]

  if (!response.pickup.spawned && response.pickup.reason && !warnings.includes(response.pickup.reason)) {
    warnings.push(response.pickup.reason)
  }

  return warnings
}

function DragTicketOverlay({ ticket, warnings }: { ticket: Ticket; warnings: string[] }) {
  const assigneeColor = assigneeToColor(ticket.assignee)
  const overlayStyle = {
    ['--ticket-assignee-color' as string]: assigneeColor,
  } as CSSProperties

  return (
    <Card className={cn('ticket-card', 'ticket-overlay')} style={overlayStyle} elevated>
      <div className="ticket-card-head">
        <p className="ticket-key">TASK-{ticket.id}</p>
        <Tag tone={priorityToTone(ticket.priority)}>{ticket.priority}</Tag>
      </div>

      <h4 className="ticket-title">{ticket.title}</h4>


      <p className="ticket-assignee-row">
        <span className="ticket-assignee-label">Assigned To</span>
        <strong className="ticket-assignee-value">{ticket.assignee}</strong>
      </p>
      <p className="ticket-updated">Updated {formatUpdatedAtDisplay(ticket.updated_at)}</p>

      {ticket.agent_session_key ? (
        <Tag className="ticket-ai-badge">AI active: {ticket.agent_session_key}</Tag>
      ) : null}

      {warnings.length > 0 ? (
        <div className="ticket-warning-block">
          <Tag tone="warning">Pickup warning</Tag>
          <p>{warnings[0]}</p>
        </div>
      ) : null}
    </Card>
  )
}

function priorityToTone(priority: TicketPriority): 'default' | 'warning' | 'danger' {
  if (priority === 'Critical') {
    return 'danger'
  }

  if (priority === 'High') {
    return 'warning'
  }

  return 'default'
}

function formatUpdatedAtDisplay(value: string): string {
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

function useAppShellContext() {
  return useOutletContext<AppShellContext>()
}

function prettifyEventType(value: string): string {
  return value.replace(/_/g, ' ')
}

function activityClassForEvent(eventType: string): string {
  if (eventType.includes('fail') || eventType.includes('error')) {
    return 'danger'
  }
  if (eventType.includes('spawn') || eventType.includes('notify')) {
    return 'accent'
  }
  if (eventType === 'comment_added') {
    return 'comment'
  }
  if (eventType === 'ticket_moved') {
    return 'move'
  }
  if (eventType === 'ticket_archived') {
    return 'warning'
  }
  return 'default'
}

function activityToneForEvent(eventType: string): 'default' | 'warning' | 'danger' {
  if (eventType.includes('fail') || eventType.includes('error')) {
    return 'danger'
  }
  if (eventType === 'ticket_archived') {
    return 'warning'
  }
  return 'default'
}

function formatTimestamp(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default App
