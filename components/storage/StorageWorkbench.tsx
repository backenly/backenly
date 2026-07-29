'use client'

/**
 * Storage workbench — the object browser as an instrument surface.
 *
 * Storage is a file browser, not a document: the objects ARE the page, and a
 * reader arriving here wants to find one and act on it. So this drops the 22px
 * hero for a command bar and takes the whole viewport, the same trade the
 * Tables inspector makes (see app/app/projects/[id]/database/page.tsx and the
 * surface rule in components/inspector/InspectorPageHeader.tsx).
 *
 * Three panes, left to right:
 *   buckets rail (248px) · object grid (flex) · object detail (320px)
 *
 * The rail and the detail pane are flush full-height columns, so they use the
 * dense-surface rungs from the kit (KIT.rail / KIT.gridHead) rather than the
 * panel ladder — stacked opaque planes with no gap between them.
 *
 * The workbench's inner layer is absolutely positioned: without it a wide grid's
 * intrinsic width propagates up through the app shell's flex chain and scrolls
 * the whole page sideways.
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  Upload, Download, Trash2, Copy, Search, Folder, File,
  Image as ImageIcon, FileText, AlertTriangle, Check,
  HardDrive, RefreshCw, Plus, X, Loader2, Sparkles, CheckSquare, Square,
} from 'lucide-react'
import { Tooltip } from '@/components/ui/Tooltip'
import {
  getBuckets, getFiles, uploadFile, deleteFile, deleteFiles,
  getStorageStats, deleteBucket, createBucket,
  type StorageBucket, type StorageFile, type StorageStats,
} from '@/lib/api/storage'
import { getCurrentProjectId } from '@/lib/api/client'
import { getProject, type Project } from '@/lib/api/projects'
import {
  KitButton, KitNote, KitModal, KitConfirmDialog, KitField, KitInput,
  EmptyState, KIT,
} from '@/components/inspector/kit'

const ALL_BUCKETS = '__all__'

const toNum = (v: number | string | bigint | null | undefined): number => {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

const getFileIcon = (mimeType: string | null) => {
  if (!mimeType) return File
  if (mimeType.startsWith('image/')) return ImageIcon
  if (mimeType.includes('pdf') || mimeType.includes('document')) return FileText
  return File
}

/** Short type label for the grid — "image/jpeg" reads as "jpeg" in a column. */
const shortType = (mimeType: string | null): string => {
  if (!mimeType) return '—'
  const sub = mimeType.split('/')[1]
  return (sub || mimeType).split(';')[0]
}

function timeAgo(iso?: string | Date | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (isNaN(t)) return ''
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function StorageWorkbench({ projectId: projectIdProp }: { projectId?: string }) {
  const router = useRouter()

  const [selectedBucket, setSelectedBucket] = useState<string>(ALL_BUCKETS)
  const [selectedBucketId, setSelectedBucketId] = useState<string | null>(null)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [bucketFilter, setBucketFilter] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [isDragging, setIsDragging] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [buckets, setBuckets] = useState<StorageBucket[]>([])
  const [files, setFiles] = useState<StorageFile[]>([])
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [projectId, setProjectId] = useState<string | null>(projectIdProp ?? null)
  const [project, setProject] = useState<Project | null>(null)

  const [actionError, setActionError] = useState<string | null>(null)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [fileToDelete, setFileToDelete] = useState<StorageFile | null>(null)
  const [deletingFile, setDeletingFile] = useState(false)
  const [bucketToDelete, setBucketToDelete] = useState<{ id: string; name: string; fileCount: number } | null>(null)
  const [deletingBucket, setDeletingBucket] = useState(false)
  const [pendingUpload, setPendingUpload] = useState<File[] | null>(null)
  const [showNewBucket, setShowNewBucket] = useState(false)
  const [newBucketName, setNewBucketName] = useState('')
  const [newBucketPublic, setNewBucketPublic] = useState(false)
  const [creatingBucket, setCreatingBucket] = useState(false)

  useEffect(() => {
    const init = async () => {
      try {
        const pid = projectIdProp || (await getCurrentProjectId())
        if (!pid) {
          router.push('/app')
          return
        }
        setProjectId(pid)
        const [projectData] = await Promise.all([getProject(pid), fetchData(pid)])
        setProject(projectData)
      } catch (error) {
        console.error('Failed to initialize storage page:', error)
        setLoading(false)
      }
    }
    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIdProp])

  useEffect(() => {
    const onStorageChanged = () => { fetchData() }
    window.addEventListener('backenly:storage-changed', onStorageChanged)
    return () => window.removeEventListener('backenly:storage-changed', onStorageChanged)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const fetchData = async (pid?: string) => {
    const activePid = pid || projectId
    if (!activePid) return
    try {
      setLoading(true)
      const [bucketsData, filesData, statsData] = await Promise.all([
        getBuckets(activePid),
        getFiles({ projectId: activePid }),
        getStorageStats(activePid),
      ])
      setBuckets(bucketsData)
      setFiles(filesData)
      setStats(statsData)
    } catch (error) {
      console.error('Failed to fetch storage data:', error)
    } finally {
      setLoading(false)
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const visibleBuckets = bucketFilter.trim()
    ? buckets.filter((b) => b.name.toLowerCase().includes(bucketFilter.trim().toLowerCase()))
    : buckets

  const bucketFiles = selectedBucket === ALL_BUCKETS
    ? files
    : files.filter((f) => f.bucket === selectedBucket)

  const filteredFiles = searchQuery.trim()
    ? bucketFiles.filter((f) => f.name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : bucketFiles

  const selectedFile = selectedFileId ? files.find((f) => f.id === selectedFileId) ?? null : null

  const totalStorage = toNum(stats?.totalSize) || files.reduce((sum, f) => sum + toNum(f.size), 0)
  const totalFiles = stats?.totalFiles ?? files.length
  const totalBuckets = buckets.length

  const maxStorage = project?.storageLimit ? toNum(project.storageLimit) : 1 * 1024 * 1024 * 1024
  const storagePercentage = maxStorage > 0 ? (totalStorage / maxStorage) * 100 : 0
  const isStorageWarning = storagePercentage >= 80
  const isStorageCritical = storagePercentage >= 95

  const countFor = (bucketName: string) => files.filter((f) => f.bucket === bucketName).length
  const sizeFor = (bucketName: string) =>
    stats?.buckets.find((b) => b.name === bucketName)?.totalSize
      ?? files.filter((f) => f.bucket === bucketName).reduce((s, f) => s + toNum(f.size), 0)

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleFileSelect = (fileId: string) => {
    const next = new Set(selectedFiles)
    if (next.has(fileId)) next.delete(fileId)
    else next.add(fileId)
    setSelectedFiles(next)
  }

  const handleSelectAll = () => {
    if (selectedFiles.size === filteredFiles.length) setSelectedFiles(new Set())
    else setSelectedFiles(new Set(filteredFiles.map((f) => f.id)))
  }

  const handleBulkDelete = async () => {
    if (selectedFiles.size === 0) return
    try {
      await deleteFiles(Array.from(selectedFiles))
      if (selectedFileId && selectedFiles.has(selectedFileId)) setSelectedFileId(null)
      setSelectedFiles(new Set())
      await fetchData()
    } catch (error) {
      console.error('Failed to delete files:', error)
      setActionError('Failed to delete the selected files. Try again.')
    }
  }

  const handleCopyLink = (url: string) => {
    navigator.clipboard.writeText(url)
    setCopiedUrl(url)
    setTimeout(() => setCopiedUrl((cur) => (cur === url ? null : cur)), 1400)
  }

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const performUpload = async (filesToUpload: File[], bucketId: string) => {
    setUploading(true)
    try {
      for (const file of filesToUpload) {
        const uploadId = `${Date.now()}-${file.name}`
        await uploadFile({ file, bucketId, isPublic: false }, (progress) => {
          setUploadProgress((prev) => ({ ...prev, [uploadId]: progress }))
        })
        setTimeout(() => {
          setUploadProgress((prev) => {
            const next = { ...prev }
            delete next[uploadId]
            return next
          })
        }, 1000)
      }
      await fetchData()
    } catch (error) {
      console.error('Failed to upload files:', error)
      setActionError('Failed to upload files. Try again.')
    } finally {
      setUploading(false)
    }
  }

  const handleFileUpload = async (filesToUpload: File[]) => {
    if (filesToUpload.length === 0) return
    setActionError(null)
    let bucketId = selectedBucketId
    if (!bucketId || selectedBucket === ALL_BUCKETS) {
      if (buckets.length === 0) {
        setActionError('Create a bucket first. Describe what your app stores and Backenly sets one up.')
        return
      }
      if (buckets.length === 1) {
        bucketId = buckets[0].id
      } else {
        setPendingUpload(filesToUpload)
        return
      }
    }
    await performUpload(filesToUpload, bucketId)
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    handleFileUpload(Array.from(e.dataTransfer.files))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBucketId, selectedBucket, buckets])

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFileUpload(Array.from(e.target.files))
    e.target.value = ''
  }

  const handleCreateBucket = async () => {
    const name = newBucketName.trim()
    if (!name) return
    setCreatingBucket(true)
    try {
      const bucket = await createBucket({ name, projectId: projectId ?? undefined, isPublic: newBucketPublic })
      setShowNewBucket(false)
      setNewBucketName('')
      setNewBucketPublic(false)
      await fetchData()
      setSelectedBucket(bucket.name)
      setSelectedBucketId(bucket.id)
    } catch (error: any) {
      setActionError(error?.message || 'Failed to create the bucket. Try again.')
    } finally {
      setCreatingBucket(false)
    }
  }

  const activeUploads = Object.entries(uploadProgress)

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className={`flex h-[calc(100vh-48px)] flex-col overflow-hidden ${KIT.bg}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input ref={fileInputRef} type="file" multiple onChange={handleFileInputChange} className="hidden" />

      {/* ── Command bar ─────────────────────────────────────────
          Identity, live quota, and the one primary action. A browser needs
          vertical room more than a 22px title and a description. */}
      <div className="flex h-11 flex-shrink-0 items-center justify-between gap-4 border-b border-white/[0.06] px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
            <HardDrive className="h-3 w-3" />
            Inspector
          </span>
          <span className="h-3 w-px bg-white/10" />
          <h1 className="text-[13px] font-semibold text-zinc-100">Storage</h1>
          <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium text-zinc-400">
            <span className="h-[5px] w-[5px] rounded-full bg-zinc-500" />
            Governed
          </span>
          {totalFiles > 0 && (
            <span className="font-mono text-[10.5px] tabular-nums text-zinc-500">{totalFiles.toLocaleString()}</span>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-3">
          {/* Quota — a meter, not a panel. */}
          <div className="hidden items-center gap-2 sm:flex">
            <span className="font-mono text-[10.5px] tabular-nums text-zinc-500">
              {formatFileSize(totalStorage)}
              <span className="text-zinc-700"> / {formatFileSize(maxStorage)}</span>
            </span>
            <div className="h-[3px] w-24 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  isStorageCritical ? 'bg-rose-400' : isStorageWarning ? 'bg-amber-400' : 'bg-violet-400/60'
                }`}
                style={{ width: `${Math.min(storagePercentage, 100)}%` }}
              />
            </div>
            <span
              className={`font-mono text-[10.5px] tabular-nums ${
                isStorageCritical ? 'text-rose-300' : isStorageWarning ? 'text-amber-500' : 'text-zinc-600'
              }`}
            >
              {storagePercentage.toFixed(1)}%
            </span>
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || isStorageCritical || totalBuckets === 0}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-white px-2.5 text-[11.5px] font-semibold text-black transition-colors hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-violet-400/50 disabled:cursor-not-allowed disabled:opacity-40"
            title={totalBuckets === 0 ? 'Create a bucket first' : 'Upload files'}
          >
            {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>

      {/* Quota + action notices — flush strips, never floating cards. */}
      {actionError && (
        <div className="flex-shrink-0 border-b border-white/[0.06] px-4 py-2.5">
          <KitNote
            tone="danger"
            icon={AlertTriangle}
            actions={
              <button
                onClick={() => setActionError(null)}
                className="text-[11px] font-medium text-zinc-500 transition-colors hover:text-zinc-200 focus:outline-none"
              >
                Dismiss
              </button>
            }
          >
            {actionError}
          </KitNote>
        </div>
      )}

      {isStorageWarning && (
        <div className="flex-shrink-0 border-b border-white/[0.06] px-4 py-2.5">
          <KitNote
            tone={isStorageCritical ? 'danger' : 'warn'}
            icon={AlertTriangle}
            title={isStorageCritical ? 'Storage quota critical' : 'Storage quota warning'}
          >
            {formatFileSize(totalStorage)} of {formatFileSize(maxStorage)} used ({storagePercentage.toFixed(1)}%)
            {isStorageCritical && '. Uploads are blocked until you free space.'}
          </KitNote>
        </div>
      )}

      {/* ── Workbench ───────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex">

          {/* ── Buckets rail ───────────────────────────────── */}
          <div className={`flex w-[248px] flex-shrink-0 flex-col border-r border-white/[0.06] ${KIT.rail}`}>
            <div className="flex h-10 flex-shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">Buckets</span>
              <div className="flex flex-shrink-0 items-center gap-0.5">
                <button
                  onClick={() => fetchData()}
                  className="rounded-md p-1.5 text-zinc-600 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
                  title="Refresh"
                >
                  <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => setShowNewBucket(true)}
                  className="rounded-md p-1.5 text-zinc-600 transition-colors hover:bg-white/[0.06] hover:text-violet-300"
                  title="New bucket"
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>
            </div>

            {buckets.length > 0 && (
              <div className="flex-shrink-0 border-b border-white/[0.06] p-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" />
                  <input
                    type="text"
                    placeholder="Search buckets…"
                    value={bucketFilter}
                    onChange={(e) => setBucketFilter(e.target.value)}
                    className="h-7 w-full rounded-lg border border-white/[0.07] bg-[#0f1015] pl-7 pr-3 text-[11.5px] text-zinc-300 transition-colors placeholder:text-zinc-600 focus:border-violet-400/40 focus:outline-none focus:ring-2 focus:ring-violet-400/15"
                  />
                </div>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5">
              {loading && buckets.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-4 w-4 animate-spin text-white/30" />
                </div>
              ) : buckets.length === 0 ? (
                <div className="space-y-3 px-4 py-6 text-center">
                  <Folder className="mx-auto h-4 w-4 text-zinc-600" />
                  <div>
                    <p className="mb-0.5 text-[12px] font-semibold text-zinc-200">No buckets yet</p>
                    <p className="text-[11px] leading-relaxed text-zinc-500">
                      Ask your coding agent for file uploads and Backenly creates one with governed access.
                    </p>
                  </div>
                  <button
                    onClick={() => setShowNewBucket(true)}
                    className="flex h-7 w-full items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-[11.5px] font-medium text-zinc-300 transition-colors hover:border-white/20 hover:bg-white/[0.08]"
                  >
                    <Plus className="h-3 w-3" />
                    New bucket
                  </button>
                </div>
              ) : (
                <div className="space-y-px px-2">
                  {/* All buckets */}
                  <div
                    onClick={() => { setSelectedBucket(ALL_BUCKETS); setSelectedBucketId(null) }}
                    className={`group relative flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] transition-colors ${
                      selectedBucket === ALL_BUCKETS
                        ? 'bg-white/[0.05] text-zinc-50'
                        : 'text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-100'
                    }`}
                  >
                    <div
                      className={`h-[5px] w-[5px] flex-shrink-0 rounded-full transition-colors ${
                        selectedBucket === ALL_BUCKETS ? 'bg-violet-300' : 'bg-white/[0.12] group-hover:bg-white/25'
                      }`}
                    />
                    <span className="flex-1 truncate text-[12px] font-medium">All buckets</span>
                    <span className="flex-shrink-0 font-mono text-[10.5px] tabular-nums text-zinc-600">{totalFiles}</span>
                  </div>

                  {visibleBuckets.length === 0 ? (
                    <p className="px-2.5 py-6 text-center text-[11.5px] leading-relaxed text-zinc-600">
                      No bucket matches “{bucketFilter}”.
                    </p>
                  ) : (
                    visibleBuckets.map((bucket) => {
                      const active = selectedBucket === bucket.name
                      return (
                        <div
                          key={bucket.id}
                          onClick={() => { setSelectedBucket(bucket.name); setSelectedBucketId(bucket.id) }}
                          className={`group relative flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] transition-colors ${
                            active ? 'bg-white/[0.05] text-zinc-50' : 'text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-100'
                          }`}
                        >
                          <div
                            className={`h-[5px] w-[5px] flex-shrink-0 rounded-full transition-colors ${
                              active ? 'bg-violet-300' : 'bg-white/[0.12] group-hover:bg-white/25'
                            }`}
                          />
                          <span className={`flex-1 truncate font-mono text-[12px] ${active ? 'text-zinc-50' : ''}`}>
                            {bucket.name}
                          </span>
                          {bucket.isPublic && (
                            <span className="flex-shrink-0 font-mono text-[10px] text-emerald-300/70 group-hover:opacity-0">
                              public
                            </span>
                          )}
                          <span
                            className={`flex-shrink-0 font-mono text-[10.5px] tabular-nums transition-all group-hover:opacity-0 ${
                              active ? 'text-zinc-400' : 'text-zinc-600'
                            }`}
                          >
                            {countFor(bucket.name)}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setBucketToDelete({ id: bucket.id, name: bucket.name, fileCount: countFor(bucket.name) })
                            }}
                            className="absolute right-2 rounded-md p-1 opacity-0 transition-all hover:bg-rose-500/15 group-hover:opacity-100"
                            title="Delete bucket"
                          >
                            <Trash2 className="h-3 w-3 text-rose-300/70" />
                          </button>
                        </div>
                      )
                    })
                  )}
                </div>
              )}
            </div>

            {buckets.length > 0 && (
              <div className="flex h-7 flex-shrink-0 items-center border-t border-white/[0.06] px-3 font-mono text-[10.5px] tabular-nums text-zinc-600">
                {bucketFilter.trim()
                  ? `${visibleBuckets.length} of ${buckets.length}`
                  : `${buckets.length} bucket${buckets.length === 1 ? '' : 's'}`}
              </div>
            )}
          </div>

          {/* ── Object grid ────────────────────────────────── */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Toolbar */}
            <div className="flex h-10 flex-shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4">
              <div className="flex min-w-0 items-baseline gap-2">
                <h2 className="truncate font-mono text-[13px] font-medium text-zinc-100">
                  {selectedBucket === ALL_BUCKETS ? 'All buckets' : selectedBucket}
                </h2>
                <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-zinc-500">
                  {filteredFiles.length.toLocaleString()} object{filteredFiles.length === 1 ? '' : 's'}
                </span>
                {selectedBucket !== ALL_BUCKETS && (
                  <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-zinc-600">
                    {formatFileSize(toNum(sizeFor(selectedBucket)))}
                  </span>
                )}
              </div>

              <div className="flex flex-shrink-0 items-center gap-2">
                {selectedFiles.size > 0 && (
                  <>
                    <span className="font-mono text-[11px] font-medium tabular-nums text-zinc-400">
                      {selectedFiles.size} selected
                    </span>
                    <KitButton variant="danger" size="sm" icon={Trash2} onClick={handleBulkDelete}>
                      Delete
                    </KitButton>
                    <span className="h-3 w-px bg-white/10" />
                  </>
                )}
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" />
                  <input
                    type="text"
                    placeholder="Search objects…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="h-7 w-52 rounded-lg border border-white/[0.07] bg-[#0f1015] pl-7 pr-3 text-[11.5px] text-zinc-300 transition-colors placeholder:text-zinc-600 focus:border-violet-400/40 focus:outline-none focus:ring-2 focus:ring-violet-400/15"
                  />
                </div>
              </div>
            </div>

            {/* Grid */}
            <div className="min-h-0 flex-1 overflow-auto">
              {loading && files.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-4 w-4 animate-spin text-white/30" />
                </div>
              ) : filteredFiles.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center px-8">
                  <EmptyState
                    icon={File}
                    title={
                      searchQuery
                        ? 'Nothing matches'
                        : totalBuckets === 0
                        ? 'No storage yet'
                        : 'Empty bucket'
                    }
                    description={
                      searchQuery
                        ? 'Clear the search or try a different term.'
                        : totalBuckets === 0
                        ? 'Ask your coding agent for file uploads and Backenly sets up a bucket with governed access.'
                        : 'Drop files anywhere on this page, or use Upload.'
                    }
                    action={
                      totalBuckets === 0 ? (
                        <KitButton
                          variant="primary"
                          icon={Sparkles}
                          onClick={() => router.push(projectId ? `/app/projects/${projectId}/connect` : '/app')}
                        >
                          Connect your agent
                        </KitButton>
                      ) : undefined
                    }
                  />
                </div>
              ) : (
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 z-10">
                    <tr className={KIT.gridHead}>
                      <th className={`sticky left-0 z-20 w-10 border-b border-r border-white/[0.06] ${KIT.gridHead} px-2 py-2 text-center`}>
                        <button
                          onClick={handleSelectAll}
                          className="text-zinc-600 transition-colors hover:text-zinc-300"
                          title={selectedFiles.size === filteredFiles.length ? 'Deselect all' : 'Select all'}
                        >
                          {selectedFiles.size === filteredFiles.length && filteredFiles.length > 0 ? (
                            <CheckSquare className="h-3.5 w-3.5 text-violet-300" />
                          ) : (
                            <Square className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </th>
                      <th className="border-b border-white/[0.06] px-3 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                        Name
                      </th>
                      {selectedBucket === ALL_BUCKETS && (
                        <th className="border-b border-white/[0.06] px-3 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                          Bucket
                        </th>
                      )}
                      <th className="border-b border-white/[0.06] px-3 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                        Type
                      </th>
                      <th className="border-b border-white/[0.06] px-3 py-2 text-right text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                        Size
                      </th>
                      <th className="border-b border-white/[0.06] px-3 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                        Access
                      </th>
                      <th className="border-b border-white/[0.06] px-3 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                        Uploaded
                      </th>
                      <th className="w-20 border-b border-white/[0.06] px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFiles.map((file) => {
                      const FileIconComp = getFileIcon(file.mimeType)
                      const isChecked = selectedFiles.has(file.id)
                      const isActive = selectedFileId === file.id
                      return (
                        <tr
                          key={file.id}
                          onClick={() => setSelectedFileId(file.id)}
                          className={`group/row cursor-pointer transition-colors ${
                            isActive ? 'bg-white/[0.05]' : KIT.rowHoverOn
                          }`}
                        >
                          <td
                            className={`sticky left-0 z-10 border-b border-r border-white/[0.04] px-2 py-[9px] text-center transition-colors ${
                              isActive ? 'bg-[#1a1b21]' : `${KIT.bg} ${KIT.rowHoverGroup}`
                            }`}
                          >
                            <button
                              onClick={(e) => { e.stopPropagation(); handleFileSelect(file.id) }}
                              className="text-zinc-700 transition-colors hover:text-zinc-300"
                            >
                              {isChecked ? (
                                <CheckSquare className="h-3.5 w-3.5 text-violet-300" />
                              ) : (
                                <Square className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </td>
                          <td className="border-b border-white/[0.04] px-3 py-[9px]">
                            <div className="flex min-w-0 items-center gap-2.5">
                              <FileIconComp className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600" />
                              <span className="truncate font-mono text-[12px] text-zinc-200" title={file.name}>
                                {file.name}
                              </span>
                            </div>
                          </td>
                          {selectedBucket === ALL_BUCKETS && (
                            <td className="border-b border-white/[0.04] px-3 py-[9px] font-mono text-[11px] text-zinc-500">
                              {file.bucket}
                            </td>
                          )}
                          <td className="border-b border-white/[0.04] px-3 py-[9px] font-mono text-[11px] text-zinc-500">
                            {shortType(file.mimeType)}
                          </td>
                          <td className="border-b border-white/[0.04] px-3 py-[9px] text-right font-mono text-[11px] tabular-nums text-zinc-400">
                            {formatFileSize(toNum(file.size))}
                          </td>
                          <td className="border-b border-white/[0.04] px-3 py-[9px]">
                            <span className={`font-mono text-[10.5px] ${file.isPublic ? 'text-emerald-300/80' : 'text-zinc-600'}`}>
                              {file.isPublic ? 'public' : 'private'}
                            </span>
                          </td>
                          <td className="border-b border-white/[0.04] px-3 py-[9px] font-mono text-[10.5px] tabular-nums text-zinc-600">
                            {timeAgo(file.createdAt)}
                          </td>
                          <td className="border-b border-white/[0.04] px-3 py-[9px]">
                            <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100">
                              <Tooltip content={copiedUrl === file.url ? 'Copied' : 'Copy URL'}>
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleCopyLink(file.url) }}
                                  className="rounded-md p-1.5 text-zinc-600 transition-colors hover:bg-white/[0.04] hover:text-zinc-100"
                                >
                                  {copiedUrl === file.url ? (
                                    <Check className="h-3.5 w-3.5 text-emerald-300" />
                                  ) : (
                                    <Copy className="h-3.5 w-3.5" />
                                  )}
                                </button>
                              </Tooltip>
                              <Tooltip content="Delete">
                                <button
                                  onClick={(e) => { e.stopPropagation(); setFileToDelete(file) }}
                                  className="rounded-md p-1.5 text-zinc-600 transition-colors hover:bg-rose-500/[0.08] hover:text-rose-300"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </Tooltip>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Grid footer — counts, and live upload progress in the same strip. */}
            <div className="flex h-10 flex-shrink-0 items-center justify-between gap-4 border-t border-white/[0.06] px-4">
              <span className="font-mono text-[10.5px] tabular-nums text-zinc-600">
                {filteredFiles.length === 0
                  ? '0 objects'
                  : `1-${filteredFiles.length} of ${filteredFiles.length}`}
                {searchQuery.trim() && bucketFiles.length !== filteredFiles.length && (
                  <span className="text-zinc-700"> · filtered from {bucketFiles.length}</span>
                )}
              </span>

              {activeUploads.length > 0 && (
                <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
                  <span className="truncate font-mono text-[10.5px] text-zinc-500">
                    Uploading {activeUploads.length} file{activeUploads.length === 1 ? '' : 's'}
                  </span>
                  <div className="h-[3px] w-32 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="h-full rounded-full bg-violet-400/60 transition-all duration-200"
                      style={{
                        width: `${activeUploads.reduce((s, [, p]) => s + p, 0) / activeUploads.length}%`,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── Object detail ──────────────────────────────── */}
          {selectedFile && (
            <div className={`flex w-[320px] flex-shrink-0 flex-col border-l border-white/[0.06] ${KIT.rail}`}>
              <div className="flex h-10 flex-shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">Object</span>
                <button
                  onClick={() => setSelectedFileId(null)}
                  className="rounded-md p-1.5 text-zinc-600 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
                  title="Close"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {/* Preview */}
                <div className="border-b border-white/[0.06] p-3">
                  {selectedFile.mimeType?.startsWith('image/') ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={selectedFile.url}
                      alt={selectedFile.name}
                      className="max-h-56 w-full rounded-lg border border-white/[0.06] object-contain"
                    />
                  ) : (
                    <div className="flex h-28 items-center justify-center rounded-lg border border-white/[0.06] bg-[#0f1015]">
                      {(() => {
                        const Icon = getFileIcon(selectedFile.mimeType)
                        return <Icon className="h-5 w-5 text-zinc-700" />
                      })()}
                    </div>
                  )}
                  <p className="mt-2.5 break-all font-mono text-[12px] text-zinc-100">{selectedFile.name}</p>
                </div>

                {/* Metadata */}
                <dl className="divide-y divide-white/[0.04]">
                  {[
                    ['Size', formatFileSize(toNum(selectedFile.size))],
                    ['Type', selectedFile.mimeType || '—'],
                    ['Bucket', selectedFile.bucket],
                    ['Access', selectedFile.isPublic ? 'public' : 'private'],
                    ['Uploaded', new Date(selectedFile.createdAt).toLocaleString()],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-baseline justify-between gap-3 px-3 py-2.5">
                      <dt className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
                        {label}
                      </dt>
                      <dd
                        className={`min-w-0 truncate text-right font-mono text-[11.5px] tabular-nums ${
                          label === 'Access' && selectedFile.isPublic ? 'text-emerald-300/80' : 'text-zinc-300'
                        }`}
                        title={String(value)}
                      >
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>

                {/* URL */}
                <div className="border-t border-white/[0.06] p-3">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">URL</p>
                  <div className="flex items-center gap-1.5">
                    <code className="min-w-0 flex-1 truncate rounded-md border border-white/[0.06] bg-[#0f1015] px-2 py-1.5 font-mono text-[10.5px] text-zinc-400">
                      {selectedFile.url}
                    </code>
                    <button
                      onClick={() => handleCopyLink(selectedFile.url)}
                      className="flex-shrink-0 rounded-md p-1.5 text-zinc-600 transition-colors hover:bg-white/[0.04] hover:text-zinc-100"
                      title="Copy URL"
                    >
                      {copiedUrl === selectedFile.url ? (
                        <Check className="h-3.5 w-3.5 text-emerald-300" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-shrink-0 items-center gap-2 border-t border-white/[0.06] p-3">
                <a
                  href={selectedFile.url}
                  download={selectedFile.name}
                  className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[11.5px] font-medium text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/[0.08]"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </a>
                <button
                  onClick={() => setFileToDelete(selectedFile)}
                  className="inline-flex h-7 items-center justify-center gap-1.5 rounded-lg border border-rose-500/25 bg-rose-500/[0.08] px-2.5 text-[11.5px] font-medium text-rose-300 transition-colors hover:border-rose-500/35 hover:bg-rose-500/[0.14]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Drag overlay */}
      {isDragging && (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#09090b]/90"
        >
          <div className="rounded-xl border border-dashed border-violet-400/30 bg-[#16171d] px-14 py-12 text-center">
            <Upload className="mx-auto mb-3 h-4 w-4 text-violet-300" />
            <p className="mb-1 text-[14px] font-semibold tracking-[-0.01em] text-zinc-50">Drop to upload</p>
            <p className="text-[12px] text-zinc-500">
              {selectedBucket === ALL_BUCKETS ? 'Release to choose a bucket.' : `Release to upload to ${selectedBucket}.`}
            </p>
          </div>
        </div>
      )}

      {/* Delete file */}
      <KitConfirmDialog
        open={!!fileToDelete}
        onCancel={() => setFileToDelete(null)}
        onConfirm={async () => {
          if (!fileToDelete) return
          setDeletingFile(true)
          try {
            await deleteFile(fileToDelete.id)
            if (selectedFileId === fileToDelete.id) setSelectedFileId(null)
            setFileToDelete(null)
            await fetchData()
          } catch (error) {
            console.error('Failed to delete file:', error)
            setFileToDelete(null)
            setActionError('Failed to delete the file. Try again.')
          } finally {
            setDeletingFile(false)
          }
        }}
        title="Delete file?"
        description={fileToDelete ? `Permanently delete ${fileToDelete.name}. This cannot be undone.` : undefined}
        confirmLabel="Delete file"
        danger
        busy={deletingFile}
      />

      {/* Delete bucket */}
      <KitConfirmDialog
        open={!!bucketToDelete}
        onCancel={() => setBucketToDelete(null)}
        onConfirm={async () => {
          if (!bucketToDelete) return
          setDeletingBucket(true)
          try {
            await deleteBucket(bucketToDelete.id)
            if (selectedBucket === bucketToDelete.name) {
              setSelectedBucket(ALL_BUCKETS)
              setSelectedBucketId(null)
            }
            setBucketToDelete(null)
            await fetchData()
          } catch (error: any) {
            setBucketToDelete(null)
            setActionError(error?.message || 'Failed to delete the bucket. Try again.')
          } finally {
            setDeletingBucket(false)
          }
        }}
        title={`Delete bucket ${bucketToDelete?.name ?? ''}?`}
        description={
          bucketToDelete && bucketToDelete.fileCount > 0
            ? `This bucket contains ${bucketToDelete.fileCount} file${bucketToDelete.fileCount === 1 ? '' : 's'}. All of them will be permanently deleted. This cannot be undone.`
            : 'The empty bucket will be removed. This cannot be undone.'
        }
        confirmLabel="Delete bucket"
        danger
        busy={deletingBucket}
      />

      {/* New bucket */}
      <KitModal
        open={showNewBucket}
        onClose={() => setShowNewBucket(false)}
        title="New bucket"
        description="Buckets group objects and carry their own access rule."
        footer={
          <>
            <KitButton variant="ghost" onClick={() => setShowNewBucket(false)} disabled={creatingBucket}>
              Cancel
            </KitButton>
            <KitButton
              variant="primary"
              onClick={handleCreateBucket}
              disabled={creatingBucket || !newBucketName.trim()}
            >
              {creatingBucket ? 'Creating…' : 'Create bucket'}
            </KitButton>
          </>
        }
      >
        <div className="space-y-4">
          <KitField label="Name" hint="Lowercase, no spaces. This becomes part of every object's URL.">
            <KitInput
              autoFocus
              value={newBucketName}
              onChange={(e) => setNewBucketName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && newBucketName.trim()) handleCreateBucket() }}
              placeholder="avatars"
            />
          </KitField>
          <button
            onClick={() => setNewBucketPublic((v) => !v)}
            className="flex w-full items-start gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:border-white/[0.14]"
          >
            {newBucketPublic ? (
              <CheckSquare className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-violet-300" />
            ) : (
              <Square className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-zinc-600" />
            )}
            <span className="min-w-0">
              <span className="block text-[12px] font-medium text-zinc-200">Public bucket</span>
              <span className="mt-0.5 block text-[11.5px] leading-snug text-zinc-500">
                Anyone with an object URL can read it. Leave off for user data.
              </span>
            </span>
          </button>
        </div>
      </KitModal>

      {/* Bucket picker — when an upload lands with no bucket selected */}
      <KitModal
        open={!!pendingUpload}
        onClose={() => setPendingUpload(null)}
        title="Choose a bucket"
        description={
          pendingUpload
            ? `Where should ${pendingUpload.length} file${pendingUpload.length === 1 ? '' : 's'} go?`
            : undefined
        }
      >
        <div className={`-m-4 divide-y ${KIT.divide}`}>
          {buckets.map((b) => (
            <button
              key={b.id}
              onClick={() => {
                const filesToSend = pendingUpload
                setPendingUpload(null)
                if (filesToSend) performUpload(filesToSend, b.id)
              }}
              className="flex w-full items-center gap-3 px-4 py-[11px] text-left transition-colors hover:bg-white/[0.025] focus:outline-none"
            >
              <Folder className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600" />
              <span className="flex-1 truncate font-mono text-[12.5px] text-zinc-200">{b.name}</span>
              <span className="font-mono text-[10.5px] tabular-nums text-zinc-600">{countFor(b.name)} files</span>
            </button>
          ))}
        </div>
      </KitModal>
    </div>
  )
}
