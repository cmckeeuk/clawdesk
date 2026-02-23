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

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', path: '/dashboard', iconSrc: kanbanIcon },
  { label: 'Workspace', path: '/workspace', iconSrc: filesIcon },
  { label: 'Activity', path: '/log', iconSrc: activityIcon },
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
      status: 'Plan',
      assignee: payload.assignee ?? 'Unassigned',
      priority: payload.priority ?? 'Medium',
      agent_session_key: null,
      archived_at: null,
      created_at: now,
      updated_at: now,
    }

    setPendingTickets((existing) => [temporaryTicket, ...existing])
    setIsNewTaskModalOpen(false)
    showShellNotice('success', `Creating "${payload.title}" in Plan...`)

    try {
      const created = await createTicketMutation.mutate(payload)
      setPendingTickets((existing) => existing.filter((ticket) => ticket.id !== temporaryId))
      showShellNotice('success', `Created TASK-${created.id} in Plan.`)
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
  const description = ticket.description.trim()
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

      {description ? <p className="ticket-description">{truncateText(description, 160)}</p> : null}

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

function truncateText(value: string, maxLength: number): string {
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
