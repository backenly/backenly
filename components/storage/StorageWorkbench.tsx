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
  Upload, Download, Trash2, Copy, Search, Folder, File, Lock,
  Image as ImageIcon, FileText, AlertTriangle, Check,
  HardDrive, RefreshCw, Plus, X, Loader2, Sparkles, CheckSquare, Square,
  ChevronLeft,
} from 'lucide-react'
import { Tooltip } from '@/components/ui/Tooltip'
import {
  getBuckets, getFiles, uploadFile, deleteFile, deleteFiles,
  getStorageStats, deleteBucket,
  type StorageBucket, type StorageFile, type StorageStats,
  getBucketsWithCaveat, updateBucketPolicy,
} from '@/lib/api/storage'
import { getCurrentProjectId } from '@/lib/api/client'
import { getProject, type Project } from '@/lib/api/projects'
import {
  AgentPrompt, CommandBar, EmptyState, IconButton, INPUT_BASE, KIT, KitButton, KitConfirmDialog, KitField,
  KitInput, KitModal, KitNote,
} from '@/components/inspector/kit'
import { FOCUS_INSET } from '@/components/console/tokens'
import { POLICY_LABELS, type AccessPolicy } from '@/lib/storage/access-policy'
import { BucketPolicyDialog } from '@/components/storage/BucketPolicyDialog'

const ALL_BUCKETS = '__all__'

const TH_BASE = 'h-[36px] whitespace-nowrap border-b border-white/[0.06] px-3 text-[12px] font-medium text-zinc-500'
const TH = `${TH_BASE} text-left`
const TD = 'h-[40px] whitespace-nowrap border-b border-white/[0.04] px-3'

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

/** The type icon as an element, so no component identity is created during render. */
function FileTypeIcon({ mimeType, className, strokeWidth = 1.75 }: { mimeType: string | null; className?: string; strokeWidth?: number }) {
  if (mimeType?.startsWith('image/')) return <ImageIcon className={className} strokeWidth={strokeWidth} />
  if (mimeType && (mimeType.includes('pdf') || mimeType.includes('document'))) return <FileText className={className} strokeWidth={strokeWidth} />
  return <File className={className} strokeWidth={strokeWidth} />
}

/** Short type label for the grid — "image/jpeg" reads as "jpeg" in a column. */
const shortType = (mimeType: string | null): string => {
  if (!mimeType) return 'file'
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
  const [mobilePane, setMobilePane] = useState<'buckets' | 'objects'>('buckets')
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
  /**
   * The bucket whose read policy is being changed.
   *
   * Policy is the control that decides who may read this bucket's objects, and
   * the dashboard previously could not show it, let alone change it: the list
   * response carried `isPublic` only.
   */
  const [bucketPolicyTarget, setBucketPolicyTarget] = useState<StorageBucket | null>(null)
  /** Deployment-level, reported by the server. See BucketPolicyDialog. */
  const [cdnServesPublicObjects, setCdnServesPublicObjects] = useState(false)
  const [deletingBucket, setDeletingBucket] = useState(false)
  const [pendingUpload, setPendingUpload] = useState<File[] | null>(null)

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
      const [bucketsResult, filesData, statsData] = await Promise.all([
        getBucketsWithCaveat(activePid),
        getFiles({ projectId: activePid }),
        getStorageStats(activePid),
      ])
      const bucketsData = bucketsResult.buckets
      setCdnServesPublicObjects(bucketsResult.cdnServesPublicObjects)
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
  // lib/services/storageQuota.ts reports "no cap" (self-hosted, or a plan
  // lookup that failed open) as 2^63-1 bytes. Drawn as a quota, that read
  // "0 B / 8589934592.0 GB" and a meter that can never move. Anything beyond
  // exact integer range is not a real limit, so it is shown as none.
  const unlimitedStorage = maxStorage > Number.MAX_SAFE_INTEGER
  const storagePercentage = !unlimitedStorage && maxStorage > 0 ? (totalStorage / maxStorage) * 100 : 0
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

  const activeUploads = Object.entries(uploadProgress)

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className={`console-fill flex flex-col overflow-hidden ${KIT.bg}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input ref={fileInputRef} type="file" multiple onChange={handleFileInputChange} className="hidden" />

      {/* ── Command bar ─────────────────────────────────────────
          Identity, the live quota, and the one primary action. A browser
          needs vertical room more than a 22px title and a description. */}
      <CommandBar
        title="Storage"
        context={
          totalFiles > 0 ? (
            <span className="tabular-nums">
              {totalFiles.toLocaleString()} {totalFiles === 1 ? 'object' : 'objects'}
            </span>
          ) : undefined
        }
      >
        {/* Quota — a meter, not a panel. */}
        <div className="hidden items-center gap-2.5 sm:flex" title={unlimitedStorage ? 'This deployment sets no storage limit' : undefined}>
          <span className="text-[12.5px] tabular-nums text-zinc-400">
            {formatFileSize(totalStorage)}
            <span className="text-zinc-600">{unlimitedStorage ? ' used, no limit' : ` of ${formatFileSize(maxStorage)}`}</span>
          </span>
          {!unlimitedStorage && (
            <>
              <div
                className="h-[4px] w-24 overflow-hidden rounded-full bg-white/[0.07]"
                role="meter"
                aria-label="Storage used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(storagePercentage)}
              >
                <div
                  className={`h-full rounded-full transition-[width] duration-500 ${
                    isStorageCritical ? 'bg-rose-400' : isStorageWarning ? 'bg-amber-400' : 'bg-zinc-300'
                  }`}
                  style={{ width: `${Math.max(Math.min(storagePercentage, 100), totalStorage > 0 ? 2 : 0)}%` }}
                />
              </div>
              <span
                className={`text-[12.5px] tabular-nums ${
                  isStorageCritical ? 'text-rose-300' : isStorageWarning ? 'text-amber-200' : 'text-zinc-500'
                }`}
              >
                {storagePercentage.toFixed(storagePercentage < 10 ? 1 : 0)}%
              </span>
            </>
          )}
        </div>
        <KitButton
          variant="primary"
          size="sm"
          icon={Upload}
          loading={uploading}
          onClick={() => fileInputRef.current?.click()}
          disabled={isStorageCritical || totalBuckets === 0}
          title={totalBuckets === 0 ? 'Create a bucket first' : 'Upload files'}
        >
          {uploading ? 'Uploading…' : 'Upload'}
        </KitButton>
      </CommandBar>

      {/* Quota + action notices — flush strips, never floating cards. */}
      {actionError && (
        <div className="flex-shrink-0 border-b border-white/[0.06] px-4 py-2.5">
          <KitNote
            tone="danger"
            icon={AlertTriangle}
            actions={
              <button
                onClick={() => setActionError(null)}
                className="text-[12px] font-medium text-zinc-500 transition-colors hover:text-zinc-200 focus:outline-none"
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

          {/* ── Buckets rail (responsive drill-down on mobile) ── */}
          <div className={`w-full md:w-[248px] flex-shrink-0 flex-col border-r border-white/[0.06] ${KIT.rail} ${mobilePane === 'buckets' ? 'flex' : 'hidden md:flex'}`}>
            <div className="flex h-[44px] flex-shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] pl-4 pr-2">
              <span className="text-[13px] font-medium text-zinc-200">Buckets</span>
              <div className="flex flex-shrink-0 items-center gap-0.5">
                <IconButton icon={RefreshCw} label="Refresh" onClick={() => fetchData()} className={loading ? '[&_svg]:animate-spin' : ''} />
              </div>
            </div>

            {buckets.length > 0 && (
              <div className="flex-shrink-0 border-b border-white/[0.06] p-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
                  <input
                    type="search"
                    aria-label="Search buckets"
                    placeholder="Search buckets…"
                    value={bucketFilter}
                    onChange={(e) => setBucketFilter(e.target.value)}
                    className={`${INPUT_BASE} h-[30px] pl-8 pr-2.5`}
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
                <div className="px-4 py-5">
                  <p className="text-[13px] font-medium text-zinc-200">No buckets yet</p>
                  <p className="mt-1 text-[12.5px] leading-[19px] text-zinc-500">
                    Your agent creates a bucket when your app needs uploads, with the read rule you ask for.
                  </p>
                </div>
              ) : (
                <div className="space-y-px px-2">
                  {/* All buckets */}
                  <button
                    type="button"
                    aria-current={selectedBucket === ALL_BUCKETS ? 'true' : undefined}
                    onClick={() => { setSelectedBucket(ALL_BUCKETS); setSelectedBucketId(null); setMobilePane('objects') }}
                    className={`group relative flex h-[32px] w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left transition-colors ${FOCUS_INSET} ${
                      selectedBucket === ALL_BUCKETS
                        ? 'bg-white/[0.07] text-zinc-50'
                        : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
                    }`}
                  >
                    <Folder className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" strokeWidth={1.75} />
                    <span className="flex-1 truncate text-[13px] font-medium">All buckets</span>
                    <span className="flex-shrink-0 text-[12px] tabular-nums text-zinc-500">{totalFiles}</span>
                  </button>

                  {visibleBuckets.length === 0 ? (
                    <p className="px-2.5 py-6 text-center text-[12.5px] leading-relaxed text-zinc-600">
                      No bucket matches “{bucketFilter}”.
                    </p>
                  ) : (
                    visibleBuckets.map((bucket) => {
                      const active = selectedBucket === bucket.name
                      return (
                        <div
                          key={bucket.id}
                          role="button"
                          tabIndex={0}
                          aria-current={active ? 'true' : undefined}
                          onClick={() => { setSelectedBucket(bucket.name); setSelectedBucketId(bucket.id); setMobilePane('objects') }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              setSelectedBucket(bucket.name); setSelectedBucketId(bucket.id); setMobilePane('objects')
                            }
                          }}
                          className={`group relative flex h-[32px] cursor-pointer items-center gap-2.5 rounded-[7px] px-2.5 transition-colors ${FOCUS_INSET} ${
                            active ? 'bg-white/[0.07] text-zinc-50' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
                          }`}
                        >
                          <Folder className={`h-3.5 w-3.5 flex-shrink-0 ${active ? 'text-zinc-300' : 'text-zinc-600'}`} strokeWidth={1.75} />
                          <span className={`flex-1 truncate font-mono text-[12.5px] ${active ? 'text-zinc-50' : ''}`}>
                            {bucket.name}
                          </span>
                          {/* The POLICY, not a derived boolean. `public` next to a
                              bucket whose policy is `owner_only` would be telling
                              the operator the opposite of what is enforced. */}
                          <span
                            className={`flex-shrink-0 text-[11.5px] group-hover:opacity-0 group-focus-within:opacity-0 ${
                              bucket.accessPolicy === 'public_read' || bucket.accessPolicy === 'cdn_cacheable'
                                ? 'text-amber-200/80'
                                : 'text-zinc-600'
                            }`}
                          >
                            {POLICY_LABELS[(bucket.accessPolicy ?? 'private') as AccessPolicy]?.title ?? bucket.accessPolicy}
                          </span>
                          <span
                            className={`flex-shrink-0 text-[12px] tabular-nums transition-all group-hover:opacity-0 group-focus-within:opacity-0 ${
                              active ? 'text-zinc-400' : 'text-zinc-600'
                            }`}
                          >
                            {countFor(bucket.name)}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setBucketPolicyTarget(bucket)
                            }}
                            className="absolute right-8 rounded-[5px] p-1 opacity-0 transition-all hover:bg-white/[0.08] focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                            title="Who may read this bucket"
                            aria-label={`Read access for ${bucket.name}`}
                          >
                            <Lock className="h-3.5 w-3.5 text-zinc-400" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setBucketToDelete({ id: bucket.id, name: bucket.name, fileCount: countFor(bucket.name) })
                            }}
                            className="absolute right-2 rounded-[5px] p-1 opacity-0 transition-all hover:bg-rose-500/15 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                            title="Delete bucket"
                            aria-label={`Delete ${bucket.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-rose-300/70" />
                          </button>
                        </div>
                      )
                    })
                  )}
                </div>
              )}
            </div>

            {buckets.length > 0 && (
              <div className="flex h-[36px] flex-shrink-0 items-center border-t border-white/[0.06] px-4 text-[12px] tabular-nums text-zinc-500">
                {bucketFilter.trim()
                  ? `${visibleBuckets.length} of ${buckets.length}`
                  : `${buckets.length} bucket${buckets.length === 1 ? '' : 's'}`}
              </div>
            )}
          </div>

          {/* ── Object grid ────────────────────────────────── */}
          <div className={`min-w-0 flex-1 flex-col ${mobilePane === 'objects' ? 'flex' : 'hidden md:flex'}`}>
            {/* Toolbar */}
            <div className="flex h-[44px] flex-shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3 sm:px-4 md:gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  onClick={() => setMobilePane('buckets')}
                  className="-ml-1 flex items-center gap-1 rounded-[7px] bg-white/[0.04] px-2 py-1.5 text-[12.5px] font-medium text-zinc-200 transition-colors hover:bg-white/[0.07] md:hidden"
                  aria-label="Back to buckets"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  <span>Buckets</span>
                </button>
                <div className="flex min-w-0 items-baseline gap-2">
                  <h2 className={`truncate text-[13px] font-medium text-zinc-100 ${selectedBucket === ALL_BUCKETS ? '' : 'font-mono'}`}>
                    {selectedBucket === ALL_BUCKETS ? 'All buckets' : selectedBucket}
                  </h2>
                  <span className="whitespace-nowrap text-[12px] tabular-nums text-zinc-500">
                    {filteredFiles.length.toLocaleString()} {filteredFiles.length === 1 ? 'object' : 'objects'}
                  </span>
                  {selectedBucket !== ALL_BUCKETS && (
                    <span className="hidden sm:inline whitespace-nowrap text-[12px] tabular-nums text-zinc-600">
                      {formatFileSize(toNum(sizeFor(selectedBucket)))}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-shrink-0 items-center gap-2">
                {selectedFiles.size > 0 && (
                  <>
                    <span className="hidden sm:inline text-[12px] font-medium tabular-nums text-zinc-400">
                      {selectedFiles.size} selected
                    </span>
                    <KitButton variant="danger" size="sm" icon={Trash2} onClick={handleBulkDelete}>
                      <span className="hidden sm:inline">Delete</span>
                    </KitButton>
                    <span className="h-3 w-px bg-white/10" />
                  </>
                )}
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
                  <input
                    type="search"
                    aria-label="Search objects"
                    placeholder="Search objects…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className={`${INPUT_BASE} h-[30px] w-32 pl-8 pr-2.5 sm:w-56`}
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
                        <div className="flex w-full flex-col items-center gap-4">
                          <AgentPrompt prompt="Add profile photo uploads: a private bucket, and only the owner can read their files." />
                          <KitButton
                            icon={Sparkles}
                            onClick={() => router.push(projectId ? `/app/projects/${projectId}/connect` : '/app')}
                          >
                            Connect your agent
                          </KitButton>
                        </div>
                      ) : undefined
                    }
                  />
                </div>
              ) : (
                <div className="min-w-full overflow-x-auto">
                  {/* With the detail pane open the grid gives up Type and
                      Uploaded, both of which the pane shows, rather than
                      wrapping sizes and bucket names onto two lines. */}
                  <table className="w-full min-w-[540px] border-collapse md:min-w-full">
                    <thead className="sticky top-0 z-10">
                      <tr className={KIT.gridHead}>
                        <th className={`sticky left-0 z-20 w-10 border-b border-r border-white/[0.06] ${KIT.gridHead} px-2 text-center`}>
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={selectedFiles.size === filteredFiles.length && filteredFiles.length > 0}
                            aria-label={selectedFiles.size === filteredFiles.length ? 'Deselect all objects' : 'Select all objects'}
                            onClick={handleSelectAll}
                            className={`rounded-[4px] text-zinc-600 transition-colors hover:text-zinc-300 ${FOCUS_INSET}`}
                          >
                            {selectedFiles.size === filteredFiles.length && filteredFiles.length > 0 ? (
                              <CheckSquare className="h-3.5 w-3.5 text-violet-300" />
                            ) : (
                              <Square className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </th>
                        <th className={TH}>Name</th>
                        {selectedBucket === ALL_BUCKETS && <th className={TH}>Bucket</th>}
                        {!selectedFile && <th className={`${TH} hidden xl:table-cell`}>Type</th>}
                        <th className={`${TH_BASE} text-right`}>Size</th>
                        <th className={TH}>Access</th>
                        {!selectedFile && <th className={`${TH} hidden lg:table-cell`}>Uploaded</th>}
                        <th className={`${TH} w-20`}>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredFiles.map((file) => {
                        const isChecked = selectedFiles.has(file.id)
                        const isActive = selectedFileId === file.id
                        return (
                          <tr
                            key={file.id}
                            onClick={() => setSelectedFileId(file.id)}
                            aria-selected={isActive}
                            className={`group/row cursor-pointer transition-colors ${
                              isActive ? 'bg-white/[0.05]' : KIT.rowHoverOn
                            }`}
                          >
                            <td
                              className={`sticky left-0 z-10 border-b border-r border-white/[0.04] px-2 text-center transition-colors ${
                                isActive ? 'bg-[#141518]' : `${KIT.bg} ${KIT.rowHoverGroup}`
                              }`}
                            >
                              <button
                                type="button"
                                role="checkbox"
                                aria-checked={isChecked}
                                aria-label={`Select ${file.name}`}
                                onClick={(e) => { e.stopPropagation(); handleFileSelect(file.id) }}
                                className={`rounded-[4px] text-zinc-700 transition-colors hover:text-zinc-300 ${FOCUS_INSET}`}
                              >
                                {isChecked ? (
                                  <CheckSquare className="h-3.5 w-3.5 text-violet-300" />
                                ) : (
                                  <Square className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </td>
                            <td className={`${TD} max-w-0 w-full`}>
                              {/* The name is the row's keyboard target; the row itself is a mouse convenience. */}
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setSelectedFileId(file.id) }}
                                className={`flex min-w-0 max-w-full items-center gap-2.5 rounded-[5px] text-left ${FOCUS_INSET}`}
                              >
                                <FileTypeIcon mimeType={file.mimeType} className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600" />
                                <span className={`truncate font-mono text-[12.5px] ${isActive ? 'text-zinc-50' : 'text-zinc-200'}`} title={file.name}>
                                  {file.name}
                                </span>
                              </button>
                            </td>
                            {selectedBucket === ALL_BUCKETS && (
                              <td className={`${TD} font-mono text-[12px] text-zinc-500`}>{file.bucket}</td>
                            )}
                            {!selectedFile && (
                              <td className={`${TD} hidden font-mono text-[12px] text-zinc-500 xl:table-cell`}>
                                {shortType(file.mimeType)}
                              </td>
                            )}
                            <td className={`${TD} text-right text-[12.5px] tabular-nums text-zinc-300`}>
                              {formatFileSize(toNum(file.size))}
                            </td>
                            <td className={TD}>
                              <span className={`text-[12.5px] ${file.isPublic ? 'text-amber-200/90' : 'text-zinc-500'}`}>
                                {file.isPublic ? 'Public' : 'Private'}
                              </span>
                            </td>
                            {!selectedFile && (
                              <td className={`${TD} hidden text-[12.5px] tabular-nums text-zinc-500 lg:table-cell`}>
                                <time dateTime={new Date(file.createdAt).toISOString()} title={new Date(file.createdAt).toLocaleString()}>
                                  {timeAgo(file.createdAt)}
                                </time>
                              </td>
                            )}
                            <td className={`${TD} pr-2`}>
                              <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
                                <Tooltip content={copiedUrl === file.url ? 'Copied' : 'Copy URL'}>
                                  <button
                                    type="button"
                                    aria-label={`Copy URL for ${file.name}`}
                                    onClick={(e) => { e.stopPropagation(); handleCopyLink(file.url) }}
                                    className={`rounded-[6px] p-1.5 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 ${FOCUS_INSET}`}
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
                                    type="button"
                                    aria-label={`Delete ${file.name}`}
                                    onClick={(e) => { e.stopPropagation(); setFileToDelete(file) }}
                                    className={`rounded-[6px] p-1.5 text-zinc-500 transition-colors hover:bg-rose-500/[0.10] hover:text-rose-300 ${FOCUS_INSET}`}
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
                </div>
              )}
            </div>

            {/* Grid footer — counts, and live upload progress in the same strip. */}
            <div className="flex h-[36px] flex-shrink-0 items-center justify-between gap-4 border-t border-white/[0.06] px-4">
              <span className="text-[12px] tabular-nums text-zinc-500">
                {searchQuery.trim() && bucketFiles.length !== filteredFiles.length
                  ? `${filteredFiles.length.toLocaleString()} of ${bucketFiles.length.toLocaleString()} objects match`
                  : `${filteredFiles.length.toLocaleString()} ${filteredFiles.length === 1 ? 'object' : 'objects'}`}
              </span>

              {activeUploads.length > 0 && (
                <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
                  <span className="truncate font-mono text-[12px] text-zinc-500">
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
            <>
              {/* Mobile Backdrop Overlay */}
              <div
                className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
                onClick={() => setSelectedFileId(null)}
              />

              {/* Responsive Drawer / Right Rail */}
              <div className={`fixed inset-x-0 bottom-0 z-50 max-h-[85vh] rounded-t-2xl border-t border-white/10 md:static md:inset-auto md:z-auto md:flex md:w-[320px] md:max-h-none md:rounded-none md:border-t-0 md:border-l md:border-white/[0.06] flex-shrink-0 flex-col ${KIT.rail} shadow-2xl md:shadow-none pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-0`}>
                {/* Mobile Drag Handle */}
                <div className="flex md:hidden pt-2.5 pb-1 justify-center">
                  <div className="w-10 h-1 rounded-full bg-white/20" />
                </div>

                <div className="flex h-[44px] flex-shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] pl-4 pr-2">
                  <span className="text-[13px] font-medium text-zinc-200">Details</span>
                  <IconButton icon={X} label="Close details" onClick={() => setSelectedFileId(null)} />
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                  {/* Preview */}
                  <div className="border-b border-white/[0.06] p-3">
                    <ObjectPreview key={selectedFile.id} file={selectedFile} />
                    <p className="mt-2.5 break-all font-mono text-[12.5px] text-zinc-100">{selectedFile.name}</p>
                  </div>

                  {/* Metadata */}
                  <dl className="divide-y divide-white/[0.04]">
                    {[
                      ['Size', formatFileSize(toNum(selectedFile.size))],
                      ['Type', selectedFile.mimeType || 'Unknown'],
                      ['Bucket', selectedFile.bucket],
                      ['Access', selectedFile.isPublic ? 'Public' : 'Private'],
                      ['Uploaded', new Date(selectedFile.createdAt).toLocaleString()],
                    ].map(([label, value]) => (
                      <div key={label} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                        <dt className="flex-shrink-0 text-[12px] font-medium text-zinc-500">
                          {label}
                        </dt>
                        <dd
                          className={`min-w-0 truncate text-right text-[12.5px] tabular-nums ${
                            label === 'Access' && selectedFile.isPublic ? 'text-amber-200/90' : 'text-zinc-300'
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
                    <p className="mb-1.5 text-[12px] font-medium text-zinc-500">URL</p>
                    <div className="flex items-center gap-1.5">
                      <code className="min-w-0 flex-1 truncate rounded-md border border-white/[0.06] bg-[#08090a] px-2 py-1.5 font-mono text-[12px] text-zinc-400">
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
                    className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[12.5px] font-medium text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/[0.08]"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </a>
                  <button
                    onClick={() => setFileToDelete(selectedFile)}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-rose-500/25 bg-rose-500/[0.08] px-2.5 text-[12.5px] font-medium text-rose-300 transition-colors hover:border-rose-500/35 hover:bg-rose-500/[0.14]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                </div>
              </div>
            </>
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
          <div className="rounded-xl border border-dashed border-violet-400/30 bg-[#0f1012] px-14 py-12 text-center">
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

      {/* Who may read a bucket */}
      {bucketPolicyTarget && (
        <BucketPolicyDialog
          bucketName={bucketPolicyTarget.name}
          current={bucketPolicyTarget.accessPolicy ?? 'private'}
          // Read from the server's own view of its storage configuration, not
          // guessed in the browser: whether a CDN serves public objects decides
          // whether this policy can be revoked at all.
          cdnCaveat={cdnServesPublicObjects}
          onClose={() => setBucketPolicyTarget(null)}
          onSave={async (policy) => {
            await updateBucketPolicy(bucketPolicyTarget.id, policy)
            setBucketPolicyTarget(null)
            await fetchData()
          }}
        />
      )}

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
              <span className="text-[12px] tabular-nums text-zinc-600">{countFor(b.name)} files</span>
            </button>
          ))}
        </div>
      </KitModal>
    </div>
  )
}

/**
 * The object preview. An image renders itself; anything else, and any image
 * the browser cannot decode or is not allowed to fetch, shows its type icon
 * rather than a broken-image glyph.
 */
function ObjectPreview({ file }: { file: StorageFile }) {
  const [failed, setFailed] = useState(false)
  if (file.mimeType?.startsWith('image/') && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={file.url}
        alt=""
        onError={() => setFailed(true)}
        className="max-h-56 w-full rounded-[8px] border border-white/[0.06] bg-[#08090a] object-contain"
      />
    )
  }
  return (
    <div className="flex h-28 flex-col items-center justify-center gap-2 rounded-[8px] border border-white/[0.06] bg-[#08090a]">
      <FileTypeIcon mimeType={file.mimeType} className="h-5 w-5 text-zinc-600" strokeWidth={1.5} />
      <span className="text-[12px] text-zinc-600">{failed ? 'No preview available' : shortType(file.mimeType)}</span>
    </div>
  )
}
