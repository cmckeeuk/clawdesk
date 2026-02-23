import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Editor } from '@toast-ui/react-editor'
import { apiClient } from '@/api/client'
import type { WorkspaceEntry } from '@/api/types'
import {
  useCreateWorkspaceFileMutation,
  useDeleteWorkspaceFileMutation,
  useUpdateWorkspaceFileMutation,
  useWorkspaceDirectoryQuery,
  useWorkspaceFileQuery,
} from '@/hooks/api'
import { buildApiUrl } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import '@toast-ui/editor/dist/toastui-editor.css'
import '@toast-ui/editor/dist/theme/toastui-editor-dark.css'

type NoticeTone = 'success' | 'warning' | 'error'

type WorkspacePageProps = {
  searchValue: string
  refreshToken: number
  notify: (tone: NoticeTone, message: string) => void
}

type WorkspaceViewMode = 'split' | 'preview' | 'edit'
type ResizeTarget = 'tree' | 'split'
type ResizeState = {
  target: ResizeTarget
  pointerStartX: number
  valueStart: number
}
type AutoSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

const ROOT_PATH = ''
const MARKDOWN_TOOLBAR_ITEMS = [
  ['heading', 'bold', 'italic', 'strike'],
  ['hr', 'quote'],
  ['ul', 'ol', 'task', 'indent', 'outdent'],
  ['table', 'link', 'image'],
  ['code', 'codeblock'],
]

export function WorkspacePage({ searchValue, refreshToken, notify }: WorkspacePageProps) {
  const rootQuery = useWorkspaceDirectoryQuery(ROOT_PATH, refreshToken, false)
  const createFileMutation = useCreateWorkspaceFileMutation()
  const deleteFileMutation = useDeleteWorkspaceFileMutation()
  const saveFileMutation = useUpdateWorkspaceFileMutation()

  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [activeDirectoryPath, setActiveDirectoryPath] = useState<string>(ROOT_PATH)
  const [fileRefreshToken, setFileRefreshToken] = useState(0)
  const [viewMode, setViewMode] = useState<WorkspaceViewMode>('split')
  const [treePanelWidth, setTreePanelWidth] = useState(320)
  const [splitLeftPercent, setSplitLeftPercent] = useState(50)
  const [draftContent, setDraftContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [directoryCache, setDirectoryCache] = useState<Map<string, WorkspaceEntry[]>>(new Map())
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set([ROOT_PATH]))
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(new Set())
  const [directoryErrors, setDirectoryErrors] = useState<Map<string, string>>(new Map())
  const [resizeState, setResizeState] = useState<ResizeState | null>(null)
  const [autoSaveState, setAutoSaveState] = useState<AutoSaveState>('idle')
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState<Date | null>(null)
  const [draftVersion, setDraftVersion] = useState(0)
  const [savedVersion, setSavedVersion] = useState(0)
  const [searchParams, setSearchParams] = useSearchParams()
  const markdownEditorRef = useRef<Editor | null>(null)
  const lastSavedFingerprintRef = useRef<string | null>(null)
  const failedAutoSaveVersionRef = useRef<number | null>(null)
  const consumedOpenPathRef = useRef<string | null>(null)
  const directoryCacheRef = useRef<Map<string, WorkspaceEntry[]>>(new Map())
  const workspaceMainRef = useRef<HTMLDivElement | null>(null)
  const workspaceSplitBodyRef = useRef<HTMLDivElement | null>(null)

  const fileQuery = useWorkspaceFileQuery(selectedFilePath, fileRefreshToken, selectedFilePath !== null)
  const normalizedSelectedFilePath = useMemo(
    () => (selectedFilePath ? normalizeWorkspacePath(selectedFilePath) : null),
    [selectedFilePath],
  )
  const selectedFile = useMemo(() => {
    if (!selectedFilePath || !fileQuery.data) {
      return null
    }
    const normalizedResponsePath = normalizeWorkspacePath(fileQuery.data.path)
    if (!normalizedSelectedFilePath || normalizedResponsePath !== normalizedSelectedFilePath) {
      return null
    }
    return {
      ...fileQuery.data,
      path: normalizedResponsePath,
    }
  }, [fileQuery.data, normalizedSelectedFilePath, selectedFilePath])
  const isMarkdownFile = Boolean(selectedFile?.isMarkdown)
  const isImageFile = Boolean(selectedFile?.isImage)
  const isEditableFile = Boolean(selectedFile && !selectedFile.isImage)
  const effectiveViewMode: WorkspaceViewMode = isImageFile
    ? 'preview'
    : !isMarkdownFile && viewMode === 'split'
      ? 'edit'
      : viewMode
  const selectedImagePreviewUrl = useMemo(() => {
    if (!selectedFile || !selectedFile.isImage) {
      return ''
    }
    const query = new URLSearchParams({ path: selectedFile.path })
    return buildApiUrl(`/api/workspace/content?${query.toString()}`)
  }, [selectedFile])

  useEffect(() => {
    const rootData = rootQuery.data
    if (!rootData) {
      return
    }

    setDirectoryCache((current) => {
      const next = new Map(current)
      next.set(ROOT_PATH, rootData.entries)
      return next
    })
  }, [rootQuery.data])

  useEffect(() => {
    directoryCacheRef.current = directoryCache
  }, [directoryCache])

  useEffect(() => {
    if (!selectedFilePath) {
      setDraftContent('')
      setSavedContent('')
      setDraftVersion(0)
      setSavedVersion(0)
      lastSavedFingerprintRef.current = null
      failedAutoSaveVersionRef.current = null
      return
    }

    if (!selectedFile || selectedFile.path !== selectedFilePath) {
      return
    }

    setDraftContent(selectedFile.content)
    setSavedContent(selectedFile.content)
    setDraftVersion(0)
    setSavedVersion(0)
    lastSavedFingerprintRef.current = contentFingerprint(selectedFile.content, Boolean(selectedFile.isMarkdown))
    failedAutoSaveVersionRef.current = null
  }, [selectedFile, selectedFilePath])

  useEffect(() => {
    if (!isMarkdownFile) {
      return
    }

    const instance = markdownEditorRef.current?.getInstance()
    if (!instance) {
      return
    }

    const editorMarkdown = instance.getMarkdown()
    if (editorMarkdown !== draftContent) {
      instance.setMarkdown(draftContent, false)
    }
  }, [draftContent, isMarkdownFile, selectedFilePath])

  useEffect(() => {
    if (selectedFilePath) {
      setFileRefreshToken((value) => value + 1)
    }
  }, [refreshToken, selectedFilePath])

  useEffect(() => {
    setAutoSaveState('idle')
    setLastAutoSavedAt(null)
    setDraftVersion(0)
    setSavedVersion(0)
    failedAutoSaveVersionRef.current = null
  }, [selectedFilePath])

  useEffect(() => {
    if (!resizeState) {
      return
    }

    const onPointerMove = (event: MouseEvent) => {
      if (resizeState.target === 'tree') {
        const container = workspaceMainRef.current
        if (!container) {
          return
        }

        const bounds = container.getBoundingClientRect()
        const deltaX = event.clientX - resizeState.pointerStartX
        const nextRaw = resizeState.valueStart + deltaX
        const minWidth = 240
        const maxWidth = Math.max(minWidth, bounds.width - 420)
        const nextWidth = clampNumber(nextRaw, minWidth, maxWidth)
        setTreePanelWidth(nextWidth)
        return
      }

      const splitContainer = workspaceSplitBodyRef.current
      if (!splitContainer) {
        return
      }

      const bounds = splitContainer.getBoundingClientRect()
      const deltaX = event.clientX - resizeState.pointerStartX
      const deltaPercent = (deltaX / Math.max(bounds.width, 1)) * 100
      const nextRaw = resizeState.valueStart + deltaPercent
      const nextPercent = clampNumber(nextRaw, 28, 72)
      setSplitLeftPercent(nextPercent)
    }

    const stopResize = () => {
      setResizeState(null)
    }

    window.addEventListener('mousemove', onPointerMove)
    window.addEventListener('mouseup', stopResize)
    window.addEventListener('blur', stopResize)

    return () => {
      window.removeEventListener('mousemove', onPointerMove)
      window.removeEventListener('mouseup', stopResize)
      window.removeEventListener('blur', stopResize)
    }
  }, [resizeState])

  const hasUnsavedChanges =
    isEditableFile && selectedFile !== null && !areContentsEquivalent(draftContent, savedContent, Boolean(selectedFile?.isMarkdown))
  const autoSaveTone: 'saving' | 'error' | 'dirty' | 'saved' = isImageFile
    ? 'saved'
    : saveFileMutation.isPending
      ? 'saving'
      : autoSaveState === 'error'
        ? 'error'
        : hasUnsavedChanges
          ? 'dirty'
          : 'saved'
  const autoSaveLabel = useMemo(() => {
    if (isImageFile) {
      return 'Read only'
    }
    if (saveFileMutation.isPending || autoSaveState === 'saving') {
      return 'Saving...'
    }
    if (autoSaveState === 'error') {
      return 'Save failed'
    }
    if (hasUnsavedChanges) {
      return 'Unsaved'
    }
    if (lastAutoSavedAt) {
      return `Saved ${formatAutoSaveTime(lastAutoSavedAt)}`
    }
    return 'All changes saved'
  }, [autoSaveState, hasUnsavedChanges, isImageFile, lastAutoSavedAt, saveFileMutation.isPending])
  const treeSearch = searchValue.trim().toLowerCase()

  const rootEntries = useMemo(() => {
    return directoryCache.get(ROOT_PATH) ?? rootQuery.data?.entries ?? []
  }, [directoryCache, rootQuery.data?.entries])

  const isDirectoryVisible = useCallback(
    (entry: WorkspaceEntry): boolean => {
      if (!treeSearch) {
        return true
      }

      if (entry.name.toLowerCase().includes(treeSearch)) {
        return true
      }

      if (entry.type !== 'dir') {
        return false
      }

      const children = directoryCache.get(entry.path)
      if (!children || children.length === 0) {
        return false
      }

      return children.some((child) => isDirectoryVisible(child))
    },
    [directoryCache, treeSearch],
  )

  const loadDirectory = useCallback(
    async (path: string, force = false) => {
      if (!force && directoryCacheRef.current.has(path)) {
        return
      }

      setLoadingDirectories((current) => {
        const next = new Set(current)
        next.add(path)
        return next
      })

      setDirectoryErrors((current) => {
        if (!current.has(path)) {
          return current
        }
        const next = new Map(current)
        next.delete(path)
        return next
      })

      try {
        const response = await apiClient.listWorkspace(path, false)
        setDirectoryCache((current) => {
          const next = new Map(current)
          next.set(path, response.entries)
          return next
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load directory.'
        setDirectoryErrors((current) => {
          const next = new Map(current)
          next.set(path, message)
          return next
        })
      } finally {
        setLoadingDirectories((current) => {
          if (!current.has(path)) {
            return current
          }
          const next = new Set(current)
          next.delete(path)
          return next
        })
      }
    },
    [],
  )

  useEffect(() => {
    const openPathRaw = searchParams.get('open') ?? window.sessionStorage.getItem('workspaceOpenPath')
    if (!openPathRaw) {
      return
    }

    const normalizedPath = normalizeWorkspacePath(openPathRaw)
    if (!normalizedPath) {
      return
    }
    if (consumedOpenPathRef.current === normalizedPath) {
      return
    }

    let cancelled = false
    const expandAndOpen = async () => {
      const segments = normalizedPath.split('/').filter(Boolean)
      const directorySegments = segments.slice(0, -1)
      const directoriesToExpand: string[] = []
      let current = ''
      for (const segment of directorySegments) {
        current = current ? `${current}/${segment}` : segment
        directoriesToExpand.push(current)
      }

      if (directoriesToExpand.length > 0) {
        setExpandedDirectories((existing) => {
          const next = new Set(existing)
          for (const path of directoriesToExpand) {
            next.add(path)
          }
          return next
        })

        for (const path of directoriesToExpand) {
          await loadDirectory(path, true)
          if (cancelled) {
            return
          }
        }
      }

      setActiveDirectoryPath(workspaceParentPath(normalizedPath))
      setSelectedFilePath(normalizedPath)
      setFileRefreshToken((value) => value + 1)
      consumedOpenPathRef.current = normalizedPath

      window.setTimeout(() => {
        if (cancelled) {
          return
        }
        const row = document.querySelector<HTMLElement>('.workspace-tree-row-selected')
        row?.scrollIntoView({ block: 'nearest' })
      }, 120)

      const nextParams = new URLSearchParams(searchParams)
      nextParams.delete('open')
      window.sessionStorage.removeItem('workspaceOpenPath')
      setSearchParams(nextParams, { replace: true })
    }

    void expandAndOpen()
    return () => {
      cancelled = true
    }
  }, [loadDirectory, searchParams, setSearchParams])

  const handleToggleDirectory = (path: string) => {
    setActiveDirectoryPath(path)
    setExpandedDirectories((current) => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        void loadDirectory(path)
      }
      return next
    })
  }

  const handleSelectFile = (path: string) => {
    if (selectedFilePath === path) {
      return
    }

    setActiveDirectoryPath(workspaceParentPath(path))

    if (hasUnsavedChanges) {
      const proceed = window.confirm('Discard unsaved changes and open another file?')
      if (!proceed) {
        return
      }
    }

    setDraftContent('')
    setSavedContent('')
    setSelectedFilePath(path)
    setFileRefreshToken((value) => value + 1)
  }

  const handleRefreshWorkspace = async () => {
    await rootQuery.refetch()
    for (const path of expandedDirectories) {
      if (path === ROOT_PATH) {
        continue
      }
      void loadDirectory(path, true)
    }
    if (selectedFilePath) {
      setFileRefreshToken((value) => value + 1)
    }
  }

  const handleCreateFile = async () => {
    if (hasUnsavedChanges) {
      const proceed = window.confirm('Discard unsaved changes and create a new file?')
      if (!proceed) {
        return
      }
    }

    const selectedPath = selectedFilePath ? normalizeWorkspacePath(selectedFilePath) : ''
    const activePath = normalizeWorkspacePath(activeDirectoryPath)
    const defaultParent = selectedPath ? workspaceParentPath(selectedPath) : activePath || ROOT_PATH
    const defaultPath = defaultParent ? `${defaultParent}/untitled.md` : 'untitled.md'
    const rawInput = window.prompt('Enter new file path (workspace-relative):', defaultPath)
    if (rawInput === null) {
      return
    }

    const path = normalizeWorkspacePath(rawInput)
    if (!path || path.endsWith('/')) {
      notify('warning', 'Enter a valid file path (example: docs/notes.md).')
      return
    }

    try {
      const response = await createFileMutation.mutate({
        path,
        content: '',
      })
      const parentPaths = listParentDirectories(response.path)
      setExpandedDirectories((existing) => {
        const next = new Set(existing)
        for (const parentPath of parentPaths) {
          next.add(parentPath)
        }
        return next
      })

      if (parentPaths.length === 0) {
        await rootQuery.refetch()
      } else {
        for (const parentPath of parentPaths) {
          await loadDirectory(parentPath, true)
        }
      }

      setActiveDirectoryPath(workspaceParentPath(response.path))
      setSelectedFilePath(response.path)
      setFileRefreshToken((value) => value + 1)
      notify('success', `Created ${response.path}.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create file.'
      notify('error', message)
    }
  }

  const handleDeleteFile = async () => {
    if (!selectedFilePath) {
      return
    }

    const confirmDelete = window.confirm(`Delete file "${selectedFilePath}"?`)
    if (!confirmDelete) {
      return
    }

    try {
      const response = await deleteFileMutation.mutate({ path: selectedFilePath })
      setSelectedFilePath(null)
      setDraftContent('')
      setSavedContent('')
      setDraftVersion(0)
      setSavedVersion(0)
      failedAutoSaveVersionRef.current = null

      if (response.parentPath) {
        setActiveDirectoryPath(response.parentPath)
        await loadDirectory(response.parentPath, true)
      } else {
        setActiveDirectoryPath(ROOT_PATH)
        await rootQuery.refetch()
      }

      notify('success', `Deleted ${response.path}.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete file.'
      notify('error', message)
    }
  }

  const handleRevert = () => {
    setDraftContent(savedContent)
    failedAutoSaveVersionRef.current = null
    notify('warning', 'Reverted unsaved changes.')
  }

  const saveCurrentFile = useCallback(async (trigger: 'manual' | 'auto'): Promise<boolean> => {
    if (!selectedFilePath || !selectedFile || selectedFile.path !== selectedFilePath) {
      return false
    }
    if (selectedFile.isImage) {
      return false
    }

    const contentSnapshot = draftContent
    const isMarkdownSnapshot = Boolean(selectedFile.isMarkdown)
    const snapshotFingerprint = contentFingerprint(contentSnapshot, isMarkdownSnapshot)
    const snapshotVersion = draftVersion
    if (trigger === 'auto' && (lastSavedFingerprintRef.current === snapshotFingerprint || snapshotVersion <= savedVersion)) {
      return true
    }
    if (trigger === 'auto' && failedAutoSaveVersionRef.current === snapshotVersion) {
      return true
    }

    if (trigger === 'manual' && draftContent.length === 0) {
      const confirmed = window.confirm('This will save an empty file. Continue?')
      if (!confirmed) {
        return false
      }
    }

    setAutoSaveState('saving')

    try {
      const response = await saveFileMutation.mutate({
        path: selectedFilePath,
        content: contentSnapshot,
      })
      setSavedContent(contentSnapshot)
      setSavedVersion(snapshotVersion)
      lastSavedFingerprintRef.current = snapshotFingerprint
      failedAutoSaveVersionRef.current = null
      setAutoSaveState('saved')
      setLastAutoSavedAt(new Date())
      if (trigger === 'manual') {
        setFileRefreshToken((value) => value + 1)
      }
      setDirectoryCache((current) => {
        const parentPath = workspaceParentPath(response.path)
        const existing = current.get(parentPath)
        if (!existing) {
          return current
        }

        const updated = existing.map((entry) => {
          if (entry.path !== response.path) {
            return entry
          }
          return {
            ...entry,
            sizeBytes: response.sizeBytes,
            updatedAt: response.updatedAt,
            isMarkdown: response.isMarkdown,
            isImage: response.isImage,
          }
        })

        const next = new Map(current)
        next.set(parentPath, updated)
        return next
      })
      return true
    } catch (error) {
      setAutoSaveState('error')
      if (trigger === 'auto') {
        failedAutoSaveVersionRef.current = snapshotVersion
      }
      const message = error instanceof Error ? error.message : 'Failed to save file.'
      if (trigger === 'manual') {
        notify('error', message)
      }
      return false
    }
  }, [draftContent, draftVersion, notify, saveFileMutation, savedVersion, selectedFile, selectedFilePath])

  const handleSaveFile = async () => {
    await saveCurrentFile('manual')
  }

  const handleMarkdownEditorChange = useCallback(() => {
    if (!isMarkdownFile) {
      return
    }

    const instance = markdownEditorRef.current?.getInstance()
    if (!instance) {
      return
    }

    const nextValue = instance.getMarkdown()
    setDraftContent((current) => {
      if (current === nextValue) {
        return current
      }
      setDraftVersion((value) => value + 1)
      failedAutoSaveVersionRef.current = null
      return nextValue
    })
  }, [isMarkdownFile])

  useEffect(() => {
    if (!selectedFilePath || !selectedFile || selectedFile.path !== selectedFilePath) {
      return
    }
    if (!hasUnsavedChanges || saveFileMutation.isPending) {
      return
    }
    if (draftVersion <= savedVersion) {
      return
    }
    if (failedAutoSaveVersionRef.current === draftVersion) {
      return
    }

    const draftFingerprint = contentFingerprint(draftContent, Boolean(selectedFile.isMarkdown))
    if (lastSavedFingerprintRef.current === draftFingerprint) {
      return
    }

    setAutoSaveState('dirty')
    const timeoutId = window.setTimeout(() => {
      void saveCurrentFile('auto')
    }, 900)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [
    draftContent,
    draftVersion,
    hasUnsavedChanges,
    saveCurrentFile,
    saveFileMutation.isPending,
    savedVersion,
    selectedFile,
    selectedFilePath,
  ])

  const handleTreeResizeStart = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    setResizeState({
      target: 'tree',
      pointerStartX: event.clientX,
      valueStart: treePanelWidth,
    })
  }

  const handleSplitResizeStart = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    setResizeState({
      target: 'split',
      pointerStartX: event.clientX,
      valueStart: splitLeftPercent,
    })
  }

  const renderTreeEntries = (entries: WorkspaceEntry[], depth: number) => {
    const visibleEntries = entries.filter((entry) => isDirectoryVisible(entry))
    if (visibleEntries.length === 0) {
      return null
    }

    return (
      <ul className="workspace-tree-list" style={{ ['--workspace-depth' as string]: String(depth) }}>
        {visibleEntries.map((entry) => {
          const isDirectory = entry.type === 'dir'
          const isExpanded = isDirectory && expandedDirectories.has(entry.path)
          const isLoadingDirectory = isDirectory && loadingDirectories.has(entry.path)
          const childEntries = isDirectory ? directoryCache.get(entry.path) ?? [] : []
          const directoryError = isDirectory ? directoryErrors.get(entry.path) : null
          const isSelectedFile = !isDirectory && selectedFilePath === entry.path

          return (
            <li key={entry.path}>
              <button
                type="button"
                className={cn(
                  'workspace-tree-row',
                  isDirectory && 'workspace-tree-row-dir',
                  isSelectedFile && 'workspace-tree-row-selected',
                )}
                onClick={() => {
                  if (isDirectory) {
                    handleToggleDirectory(entry.path)
                  } else {
                    handleSelectFile(entry.path)
                  }
                }}
              >
                <span className="workspace-tree-caret" aria-hidden="true">
                  {isDirectory ? (isExpanded ? '▾' : '▸') : '·'}
                </span>
                <span className="workspace-tree-icon" aria-hidden="true">
                  {isDirectory ? 'DIR' : entry.isImage ? 'IMG' : entry.isMarkdown ? 'MD' : 'TXT'}
                </span>
                <span className="workspace-tree-name">{entry.name}</span>
              </button>

              {isDirectory && isExpanded ? (
                <div className="workspace-tree-children">
                  {isLoadingDirectory ? <p className="workspace-tree-state">Loading...</p> : null}
                  {!isLoadingDirectory && directoryError ? <p className="workspace-tree-state">{directoryError}</p> : null}
                  {!isLoadingDirectory && !directoryError ? renderTreeEntries(childEntries, depth + 1) : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <section className="workspace-content" aria-label="Workspace files">
      <Card className="workspace-shell" elevated>
        <header className="workspace-toolbar">
          <div>
            <p className="workspace-kicker">Workspace</p>
            <h2>File Studio</h2>
            <p className="workspace-root-path">{rootQuery.data?.root ?? 'Loading workspace root...'}</p>
          </div>
          <div className="workspace-toolbar-actions">
            <div className="workspace-mode-toggle" role="group" aria-label="Editor view mode">
              <button
                type="button"
                className={cn('workspace-mode-btn', effectiveViewMode === 'preview' && 'workspace-mode-btn-active')}
                onClick={() => setViewMode('preview')}
              >
                {isImageFile ? 'Image' : isMarkdownFile ? 'Rich' : 'Preview'}
              </button>
              {!isImageFile ? (
                <>
                  <button
                    type="button"
                    className={cn('workspace-mode-btn', effectiveViewMode === 'edit' && 'workspace-mode-btn-active')}
                    onClick={() => setViewMode('edit')}
                  >
                    {isMarkdownFile ? 'Raw' : 'Edit'}
                  </button>
                  {isMarkdownFile ? (
                    <button
                      type="button"
                      className={cn('workspace-mode-btn', effectiveViewMode === 'split' && 'workspace-mode-btn-active')}
                      onClick={() => setViewMode('split')}
                    >
                      Split
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
            <Button variant="ghost" onClick={handleRefreshWorkspace}>
              Refresh Files
            </Button>
            <Button variant="ghost" onClick={handleRevert} disabled={!isEditableFile || !hasUnsavedChanges || saveFileMutation.isPending}>
              Revert
            </Button>
            <Button
              variant="primary"
              onClick={handleSaveFile}
              disabled={!selectedFilePath || !isEditableFile || !hasUnsavedChanges || saveFileMutation.isPending}
            >
              {saveFileMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </header>

        <div
          className={cn('workspace-main', resizeState?.target === 'tree' && 'workspace-main-resizing')}
          ref={workspaceMainRef}
          style={{ ['--workspace-tree-width' as string]: `${Math.round(treePanelWidth)}px` }}
        >
          <aside className="workspace-tree-panel" aria-label="Workspace tree">
            <header className="workspace-panel-head">
              <div className="workspace-panel-title">
                <h3>Workspace Files</h3>
                <span>{rootEntries.length}</span>
              </div>
              <div className="workspace-panel-actions" role="group" aria-label="File actions">
                <button
                  type="button"
                  className="workspace-panel-icon-btn"
                  onClick={handleCreateFile}
                  disabled={createFileMutation.isPending || saveFileMutation.isPending || deleteFileMutation.isPending}
                  aria-label={createFileMutation.isPending ? 'Creating file' : 'Create new file'}
                  title={createFileMutation.isPending ? 'Creating file…' : 'New file'}
                >
                  <span aria-hidden="true">{createFileMutation.isPending ? '…' : '+'}</span>
                </button>
                <button
                  type="button"
                  className="workspace-panel-icon-btn workspace-panel-icon-btn-danger"
                  onClick={handleDeleteFile}
                  disabled={!selectedFilePath || deleteFileMutation.isPending || saveFileMutation.isPending}
                  aria-label={deleteFileMutation.isPending ? 'Deleting file' : 'Delete selected file'}
                  title={deleteFileMutation.isPending ? 'Deleting file…' : 'Delete selected file'}
                >
                  <span aria-hidden="true">{deleteFileMutation.isPending ? '…' : '−'}</span>
                </button>
              </div>
            </header>
            <div className="workspace-tree-scroll">
              {rootQuery.uiError ? (
                <p className="workspace-tree-state">
                  <strong>{rootQuery.uiError.title}:</strong> {rootQuery.uiError.message}
                </p>
              ) : null}
              {rootQuery.isLoading ? <p className="workspace-tree-state">Loading workspace tree...</p> : null}
              {!rootQuery.isLoading && !rootQuery.uiError && rootEntries.length === 0 ? (
                <p className="workspace-tree-state">No files found in workspace root.</p>
              ) : null}
              {!rootQuery.isLoading && !rootQuery.uiError && rootEntries.length > 0 ? renderTreeEntries(rootEntries, 0) : null}
            </div>
          </aside>
          <button
            type="button"
            className={cn('workspace-resizer', 'workspace-resizer-tree', resizeState?.target === 'tree' && 'workspace-resizer-active')}
            onMouseDown={handleTreeResizeStart}
            aria-label="Resize workspace panels"
          />

          <section className="workspace-editor-panel" aria-label="File editor">
            {!selectedFilePath ? (
              <div className="workspace-empty-state">
                <h3>Select a file to start</h3>
                <p>Choose a markdown, text, or image file from the tree.</p>
              </div>
            ) : null}

            {selectedFilePath && (fileQuery.isLoading || selectedFile === null) ? (
              <p className="workspace-file-state">Loading file...</p>
            ) : null}
            {selectedFilePath && fileQuery.uiError ? (
              <p className="workspace-file-state">
                <strong>{fileQuery.uiError.title}:</strong> {fileQuery.uiError.message}
              </p>
            ) : null}

            {selectedFilePath && selectedFile && !fileQuery.isLoading && !fileQuery.uiError ? (
              <>
                <header className="workspace-file-header">
                  <div>
                    <h3>{selectedFile.name}</h3>
                  </div>
                  <div className="workspace-file-meta">
                    <span>{selectedFile.isImage ? 'Image' : selectedFile.isMarkdown ? 'Markdown' : 'Text'}</span>
                    <span>{formatBytes(selectedFile.sizeBytes)}</span>
                    <span>Updated {formatUpdatedAt(selectedFile.updatedAt)}</span>
                    <span className={cn('workspace-autosave-pill', `workspace-autosave-pill-${autoSaveTone}`)}>{autoSaveLabel}</span>
                  </div>
                </header>

                {isImageFile ? (
                  <div className={cn('workspace-file-body', 'workspace-file-body-preview')}>
                    <div className="workspace-preview-pane workspace-image-pane">
                      <img className="workspace-image-preview" src={selectedImagePreviewUrl} alt={selectedFile.name} loading="lazy" />
                    </div>
                  </div>
                ) : effectiveViewMode === 'split' ? (
                  <div
                    className={cn(
                      'workspace-file-body',
                      'workspace-file-body-split',
                      isMarkdownFile && 'workspace-file-body-markdown',
                      resizeState?.target === 'split' && 'workspace-file-body-resizing',
                    )}
                    ref={workspaceSplitBodyRef}
                    style={{ ['--workspace-split-left' as string]: `${splitLeftPercent.toFixed(2)}%` }}
                  >
                    <div className={cn('workspace-preview-pane', isMarkdownFile && 'workspace-rich-pane')}>
                      {selectedFile.isMarkdown ? (
                        <Editor
                          key={selectedFile.path}
                          ref={markdownEditorRef}
                          initialValue={draftContent}
                          previewStyle="tab"
                          initialEditType="wysiwyg"
                          hideModeSwitch
                          usageStatistics={false}
                          toolbarItems={MARKDOWN_TOOLBAR_ITEMS}
                          height="100%"
                          theme="dark"
                          onChange={handleMarkdownEditorChange}
                        />
                      ) : (
                        <pre className="workspace-text-preview">{draftContent}</pre>
                      )}
                    </div>

                    <button
                      type="button"
                      className={cn(
                        'workspace-resizer',
                        'workspace-resizer-split',
                        resizeState?.target === 'split' && 'workspace-resizer-active',
                      )}
                      onMouseDown={handleSplitResizeStart}
                      aria-label="Resize editor split panes"
                    />

                    <div className={cn('workspace-edit-pane', !selectedFile.isMarkdown && 'workspace-edit-pane-plain')}>
                      {selectedFile.isMarkdown ? (
                        <header className="workspace-raw-header" aria-hidden="true">
                          <span>Markdown</span>
                        </header>
                      ) : null}
                      <textarea
                        className="workspace-editor"
                        value={draftContent}
                        onChange={(event) => {
                          setDraftContent(event.target.value)
                          setDraftVersion((value) => value + 1)
                          failedAutoSaveVersionRef.current = null
                        }}
                        spellCheck={selectedFile.isMarkdown}
                      />
                    </div>
                  </div>
                ) : (
                  <div
                    className={cn(
                      'workspace-file-body',
                      isMarkdownFile && 'workspace-file-body-markdown',
                      effectiveViewMode === 'preview' && 'workspace-file-body-preview',
                      effectiveViewMode === 'edit' && 'workspace-file-body-edit',
                    )}
                  >
                    {effectiveViewMode !== 'edit' ? (
                      <div className={cn('workspace-preview-pane', isMarkdownFile && 'workspace-rich-pane')}>
                        {selectedFile.isMarkdown ? (
                          <Editor
                            key={selectedFile.path}
                            ref={markdownEditorRef}
                            initialValue={draftContent}
                            previewStyle="tab"
                            initialEditType="wysiwyg"
                            hideModeSwitch
                            usageStatistics={false}
                            toolbarItems={MARKDOWN_TOOLBAR_ITEMS}
                            height="100%"
                            theme="dark"
                            onChange={handleMarkdownEditorChange}
                          />
                        ) : (
                          <pre className="workspace-text-preview">{draftContent}</pre>
                        )}
                      </div>
                    ) : null}

                    {effectiveViewMode !== 'preview' ? (
                      <div className={cn('workspace-edit-pane', !selectedFile.isMarkdown && 'workspace-edit-pane-plain')}>
                        {selectedFile.isMarkdown ? (
                          <header className="workspace-raw-header" aria-hidden="true">
                            <span>Markdown</span>
                          </header>
                        ) : null}
                        <textarea
                          className="workspace-editor"
                          value={draftContent}
                          onChange={(event) => {
                            setDraftContent(event.target.value)
                            setDraftVersion((value) => value + 1)
                            failedAutoSaveVersionRef.current = null
                          }}
                          spellCheck={selectedFile.isMarkdown}
                        />
                      </div>
                    ) : null}
                  </div>
                )}
              </>
            ) : null}
          </section>
        </div>
      </Card>
    </section>
  )
}

function workspaceParentPath(path: string): string {
  const lastSlashIndex = path.lastIndexOf('/')
  if (lastSlashIndex < 0) {
    return ROOT_PATH
  }
  return path.slice(0, lastSlashIndex)
}

function listParentDirectories(path: string): string[] {
  const segments = path.split('/').filter(Boolean)
  if (segments.length <= 1) {
    return []
  }

  const parentSegments = segments.slice(0, -1)
  const directories: string[] = []
  let current = ''
  for (const segment of parentSegments) {
    current = current ? `${current}/${segment}` : segment
    directories.push(current)
  }
  return directories
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

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function formatAutoSaveTime(value: Date): string {
  const secondsAgo = Math.floor((Date.now() - value.getTime()) / 1000)
  if (secondsAgo < 5) {
    return 'just now'
  }
  if (secondsAgo < 60) {
    return `${secondsAgo}s ago`
  }

  return value.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function contentFingerprint(value: string, isMarkdown: boolean): string {
  return normalizeContentForCompare(value, isMarkdown)
}

function normalizeWorkspacePath(value: string): string {
  let normalized = value.trim()

  for (let index = 0; index < 2; index += 1) {
    try {
      const decoded = decodeURIComponent(normalized)
      if (decoded === normalized) {
        break
      }
      normalized = decoded
    } catch {
      break
    }
  }

  return normalized
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .join('/')
}

function areContentsEquivalent(nextValue: string, previousValue: string, isMarkdown: boolean): boolean {
  if (nextValue === previousValue) {
    return true
  }

  const normalizedNext = normalizeContentForCompare(nextValue, isMarkdown)
  const normalizedPrevious = normalizeContentForCompare(previousValue, isMarkdown)
  return normalizedNext === normalizedPrevious
}

function normalizeContentForCompare(value: string, isMarkdown: boolean): string {
  let normalized = value.replace(/\r\n/g, '\n')

  if (!isMarkdown) {
    return normalized
  }

  // Toast UI normalizes markdown to end with a single trailing newline.
  if (normalized.endsWith('\n')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}
