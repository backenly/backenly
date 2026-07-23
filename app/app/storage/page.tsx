'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  Upload, Download, Trash2, Copy, Search, Folder, File,
  Image as ImageIcon, FileText, CheckSquare, Square,
  AlertTriangle, Globe, Activity, Sparkles, Check,
} from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { Tooltip } from '@/components/ui/Tooltip'
import { GlobalLoading } from '@/components/ui/GlobalLoading'
import {
  getBuckets, getFiles, uploadFile, deleteFile, deleteFiles,
  getStorageStats, deleteBucket,
  type StorageBucket, type StorageFile, type StorageStats,
} from '@/lib/api/storage'
import { getCurrentProjectId } from '@/lib/api/client'
import { getProject, type Project } from '@/lib/api/projects'
import { InspectorGovernanceFooter } from '@/components/inspector/InspectorPageHeader'
import {
  KitCard, KitCardHeader,
  KitButton, KitBadge,
  KitNote, KitModal, KitConfirmDialog,
  EmptyState,
  SectionLabel, KIT,
} from '@/components/inspector/kit'

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

export default function StoragePage() {
  const router = useRouter()
  const [selectedBucket, setSelectedBucket] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [isDragging, setIsDragging] = useState(false)
  const [showDropZone, setShowDropZone] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [buckets, setBuckets] = useState<StorageBucket[]>([])
  const [files, setFiles] = useState<StorageFile[]>([])
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [selectedBucketId, setSelectedBucketId] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [project, setProject] = useState<Project | null>(null)

  // Kit-dialog state — replaces the native alert()/confirm()/prompt() flows.
  const [actionError, setActionError] = useState<string | null>(null)
  const [fileToDelete, setFileToDelete] = useState<StorageFile | null>(null)
  const [deletingFile, setDeletingFile] = useState(false)
  const [bucketToDelete, setBucketToDelete] = useState<{ id: string; name: string; fileCount: number } | null>(null)
  const [deletingBucket, setDeletingBucket] = useState(false)
  const [pendingUpload, setPendingUpload] = useState<File[] | null>(null)

  useEffect(() => {
    const init = async () => {
      try {
        const pid = await getCurrentProjectId()
        if (!pid) {
          router.push('/app')
          return
        }
        setProjectId(pid)
        const [projectData] = await Promise.all([
          getProject(pid),
          fetchData(pid),
        ])
        setProject(projectData)
      } catch (error) {
        console.error('Failed to initialize storage page:', error)
        setLoading(false)
      }
    }
    init()
  }, [])

  useEffect(() => {
    const onStorageChanged = () => { fetchData() }
    window.addEventListener('backenly:storage-changed', onStorageChanged)
    return () => window.removeEventListener('backenly:storage-changed', onStorageChanged)
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
      if (bucketsData.length > 0 && !selectedBucketId) {
        setSelectedBucketId(bucketsData[0].id)
      }
    } catch (error) {
      console.error('Failed to fetch storage data:', error)
    } finally {
      setLoading(false)
    }
  }

  const filteredFiles = files.filter(file => {
    const matchesBucket = selectedBucket === 'all' || file.bucket === selectedBucket
    const matchesSearch = file.name.toLowerCase().includes(searchQuery.toLowerCase())
    return matchesBucket && matchesSearch
  })

  const totalStorage = stats?.totalSize || 0
  const totalFiles = stats?.totalFiles || files.length
  const totalBuckets = buckets.length
  const publicFiles = files.filter(f => f.isPublic).length

  const handleFileSelect = (fileId: string) => {
    const newSelected = new Set(selectedFiles)
    if (newSelected.has(fileId)) newSelected.delete(fileId)
    else newSelected.add(fileId)
    setSelectedFiles(newSelected)
  }

  const handleSelectAll = () => {
    if (selectedFiles.size === filteredFiles.length) setSelectedFiles(new Set())
    else setSelectedFiles(new Set(filteredFiles.map(f => f.id)))
  }

  const handleBulkDelete = async () => {
    if (selectedFiles.size === 0) return
    try {
      await deleteFiles(Array.from(selectedFiles))
      setSelectedFiles(new Set())
      await fetchData()
    } catch (error) {
      console.error('Failed to delete files:', error)
      setActionError('Failed to delete the selected files. Try again.')
    }
  }

  const handleCopyLink = (url: string) => {
    navigator.clipboard.writeText(url)
  }

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
    setShowDropZone(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    setShowDropZone(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    setShowDropZone(false)
    const droppedFiles = Array.from(e.dataTransfer.files)
    handleFileUpload(droppedFiles)
  }, [])

  const handleUploadClick = () => {
    setShowDropZone(true)
    fileInputRef.current?.click()
  }

  const performUpload = async (filesToUpload: File[], bucketId: string) => {
    setUploading(true)
    try {
      for (const file of filesToUpload) {
        const fileId = `upload-${Date.now()}-${file.name}`
        await uploadFile(
          { file, bucketId, isPublic: false },
          (progress) => {
            setUploadProgress(prev => ({ ...prev, [fileId]: progress }))
          }
        )
        setTimeout(() => {
          setUploadProgress(prev => {
            const newProgress = { ...prev }
            delete newProgress[fileId]
            return newProgress
          })
        }, 1000)
      }
      await fetchData()
      setShowDropZone(false)
    } catch (error) {
      console.error('Failed to upload files:', error)
      setActionError('Failed to upload files. Try again.')
    } finally {
      setUploading(false)
    }
  }

  const handleFileUpload = async (filesToUpload: File[]) => {
    setActionError(null)
    let bucketId = selectedBucketId
    if (!bucketId || selectedBucket === 'all') {
      if (buckets.length === 0) {
        setActionError('Create a bucket first. Describe what your app stores and Backenly sets one up.')
        return
      }
      if (buckets.length === 1) {
        bucketId = buckets[0].id
      } else {
        // More than one bucket and none selected — ask via the picker modal.
        setPendingUpload(filesToUpload)
        return
      }
    }
    await performUpload(filesToUpload, bucketId)
  }

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFileUpload(Array.from(e.target.files))
  }

  const maxStorage = project?.storageLimit ? Number(project.storageLimit) : 1 * 1024 * 1024 * 1024
  const storagePercentage = maxStorage > 0 ? (totalStorage / maxStorage) * 100 : 0
  const isStorageWarning = storagePercentage >= 80
  const isStorageCritical = storagePercentage >= 95

  if (loading) return <GlobalLoading message="Loading storage..." />

  return (
    <div
      className="px-8 py-7"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input ref={fileInputRef} type="file" multiple onChange={handleFileInputChange} className="hidden" />

      {/* Inline metadata + upload — replaces "Storage Runtime" duplicate hero.
          InspectorPageHeader already says Storage · Governed; we don't repeat it. */}
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex items-baseline gap-1.5">
            <span className="font-mono text-[14px] font-medium tabular-nums text-white">{totalFiles.toLocaleString()}</span>
            <span className="text-[11px] text-zinc-500">files</span>
          </span>
          <span className="w-px h-3 bg-white/10" />
          <span className="flex items-baseline gap-1.5">
            <span className="font-mono text-[14px] font-medium tabular-nums text-white">{totalBuckets}</span>
            <span className="text-[11px] text-zinc-500">bucket{totalBuckets === 1 ? '' : 's'}</span>
          </span>
          <span className="w-px h-3 bg-white/10" />
          <span className="flex items-baseline gap-1.5">
            <span className="font-mono text-[14px] font-medium tabular-nums text-white">{formatFileSize(totalStorage)}</span>
            <span className="font-mono text-[11px] text-zinc-600 tabular-nums">of {formatFileSize(maxStorage)}</span>
          </span>
        </div>
        <KitButton
          variant="primary"
          icon={Upload}
          onClick={handleUploadClick}
          disabled={uploading || isStorageCritical}
        >
          {uploading ? 'Uploading…' : 'Upload files'}
        </KitButton>
      </div>

      {/* Action errors — upload/delete failures surface here, not in alert() */}
      {actionError && (
        <div className="mb-4">
          <KitNote
            tone="danger"
            icon={AlertTriangle}
            actions={
              <button
                onClick={() => setActionError(null)}
                className="text-zinc-500 hover:text-zinc-200 transition-colors text-[11px] font-medium focus:outline-none"
              >
                Dismiss
              </button>
            }
          >
            {actionError}
          </KitNote>
        </div>
      )}

      {/* Quota warning */}
      <AnimatePresence>
        {isStorageWarning && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={`mb-4 rounded-lg px-4 py-3 border flex items-start gap-3 ${
              isStorageCritical
                ? 'bg-rose-500/[0.04] border-rose-500/15'
                : 'bg-amber-500/[0.04] border-amber-500/15'
            }`}
          >
            <AlertTriangle className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${isStorageCritical ? 'text-rose-300' : 'text-amber-500'}`} />
            <div>
              <p className={`text-[12.5px] font-semibold ${isStorageCritical ? 'text-rose-300' : 'text-amber-500'}`}>
                {isStorageCritical ? 'Storage quota critical' : 'Storage quota warning'}
              </p>
              <p className="text-[12px] text-zinc-400 mt-0.5">
                {formatFileSize(totalStorage)} / {formatFileSize(maxStorage)} used ({storagePercentage.toFixed(1)}%)
                {isStorageCritical && '. Uploads will be blocked when the quota is exceeded.'}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Quota progress bar — slim version. The counts moved to the metadata
          row above; only the visual progress remains here for at-a-glance health. */}
      <div className="mb-4 flex items-center gap-3">
        <div className="flex-1 h-[3px] bg-white/[0.05] rounded-full overflow-hidden">
          <motion.div
            className={`h-full rounded-full transition-all duration-500 ${
              isStorageCritical ? 'bg-rose-400' : isStorageWarning ? 'bg-amber-400' : 'bg-violet-400/50'
            }`}
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(storagePercentage, 100)}%` }}
          />
        </div>
        <span className={`font-mono text-[10.5px] tabular-nums font-medium ${
          isStorageCritical ? 'text-rose-300' : isStorageWarning ? 'text-amber-500' : 'text-zinc-600'
        }`}>{storagePercentage.toFixed(1)}%</span>
      </div>

      {/* Search + bucket pills */}
      <KitCard className="p-3 mb-4">
        <div className="flex items-center gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-600" />
            <input
              type="text"
              placeholder="Search files by name…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-8 pl-9 pr-3 bg-[#0f1015] border border-white/[0.07] rounded-lg text-[12.5px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15 transition-colors"
            />
          </div>
          {selectedFiles.size > 0 && (
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="font-mono text-[11px] text-zinc-400 font-medium tabular-nums">{selectedFiles.size} selected</span>
              <KitButton variant="danger" size="sm" icon={Trash2} onClick={handleBulkDelete}>
                Delete
              </KitButton>
            </div>
          )}
        </div>

        {buckets.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mt-3 pt-3 border-t border-white/[0.05]">
            <button
              onClick={() => { setSelectedBucket('all'); setSelectedBucketId(null) }}
              className={`text-[11px] font-medium px-2.5 py-1 rounded-md border transition-colors ${
                selectedBucket === 'all'
                  ? 'bg-white/[0.06] border-white/[0.10] text-zinc-100'
                  : 'border-white/[0.07] text-zinc-500 hover:text-zinc-300 hover:border-white/[0.14]'
              }`}
            >
              All buckets <span className="font-mono tabular-nums text-zinc-500 ml-1">{totalFiles}</span>
            </button>
            {buckets.map(b => {
              const active = selectedBucket === b.name
              const count = files.filter(f => f.bucket === b.name).length
              return (
                <button
                  key={b.id}
                  onClick={() => { setSelectedBucket(active ? 'all' : b.name); setSelectedBucketId(active ? null : b.id) }}
                  className={`text-[11px] font-mono font-medium px-2.5 py-1 rounded-md border transition-colors ${
                    active
                      ? 'bg-white/[0.06] border-violet-400/30 text-violet-200'
                      : 'border-white/[0.07] text-zinc-500 hover:text-zinc-300 hover:border-white/[0.14]'
                  }`}
                >
                  {b.name} <span className="opacity-60 ml-0.5 tabular-nums">{count}</span>
                </button>
              )
            })}
          </div>
        )}
      </KitCard>

      {/* Upload progress */}
      <AnimatePresence>
        {Object.keys(uploadProgress).length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
          >
            <KitCard className="p-4 mb-4">
              <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-[0.14em] mb-3 flex items-center gap-2">
                <Activity className="w-3 h-3" /> Uploading
              </p>
              {Object.entries(uploadProgress).map(([fileId, progress]) => (
                <div key={fileId} className="mb-2 last:mb-0">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11.5px] text-zinc-400 font-mono truncate pr-3">{fileId.includes('-') ? fileId.split('-').slice(2).join('-') : 'File'}</span>
                    <span className="font-mono text-[11px] text-violet-300 font-medium tabular-nums">{Math.round(progress)}%</span>
                  </div>
                  <div className="h-[3px] bg-white/[0.05] rounded-full overflow-hidden">
                    <motion.div
                      className="h-full bg-violet-400/60 rounded-full"
                      initial={{ width: 0 }}
                      animate={{ width: `${progress}%` }}
                      transition={{ duration: 0.2 }}
                    />
                  </div>
                </div>
              ))}
            </KitCard>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Files */}
      <KitCard className="mb-4">
        <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12.5px] font-semibold text-zinc-100">Files</h2>
            <span className="font-mono text-[11px] text-zinc-500 tabular-nums">{filteredFiles.length} object{filteredFiles.length === 1 ? '' : 's'}</span>
          </div>
          {filteredFiles.length > 0 && (
            <button
              onClick={handleSelectAll}
              className="text-[11.5px] text-zinc-500 hover:text-zinc-200 transition-colors font-medium focus:outline-none"
            >
              {selectedFiles.size === filteredFiles.length ? 'Deselect all' : 'Select all'}
            </button>
          )}
        </div>

        {filteredFiles.length === 0 ? (
          <EmptyState
            icon={File}
            title={searchQuery ? 'Nothing matches' : totalBuckets === 0 ? 'No storage yet' : 'Empty bucket'}
            description={
              searchQuery
                ? 'Clear the search or try a different term.'
                : totalBuckets === 0
                ? 'Ask your coding agent for file uploads and Backenly sets up a bucket with governed access.'
                : 'Files your users upload will show up here. Drop files anywhere on this page, or click Upload Files.'
            }
            action={totalBuckets === 0 ? (
              <KitButton variant="primary" icon={Sparkles} onClick={() => router.push(projectId ? `/app/projects/${projectId}/connect` : '/app')}>
                Connect your agent
              </KitButton>
            ) : undefined}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <th className="px-4 py-2 text-left w-10">
                    <button onClick={handleSelectAll} className="text-zinc-600 hover:text-zinc-300 transition-colors">
                      {selectedFiles.size === filteredFiles.length && filteredFiles.length > 0 ? (
                        <CheckSquare className="w-3.5 h-3.5" />
                      ) : (
                        <Square className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </th>
                  <th className="px-4 py-2 text-left text-[9.5px] font-semibold text-zinc-600 uppercase tracking-[0.1em]">Name</th>
                  <th className="px-4 py-2 text-left text-[9.5px] font-semibold text-zinc-600 uppercase tracking-[0.1em]">Bucket</th>
                  <th className="px-4 py-2 text-left text-[9.5px] font-semibold text-zinc-600 uppercase tracking-[0.1em]">Size</th>
                  <th className="px-4 py-2 text-left text-[9.5px] font-semibold text-zinc-600 uppercase tracking-[0.1em]">Uploaded</th>
                  <th className="px-4 py-2 text-right text-[9.5px] font-semibold text-zinc-600 uppercase tracking-[0.1em]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {filteredFiles.map((file) => {
                  const FileIconComp = getFileIcon(file.mimeType)
                  const isSelected = selectedFiles.has(file.id)
                  return (
                    <tr
                      key={file.id}
                      className={`transition-colors ${isSelected ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]'}`}
                    >
                      <td className="px-4 py-[9px]">
                        <button onClick={() => handleFileSelect(file.id)} className="text-zinc-600 hover:text-zinc-300 transition-colors">
                          {isSelected ? <CheckSquare className="w-3.5 h-3.5 text-violet-300" /> : <Square className="w-3.5 h-3.5" />}
                        </button>
                      </td>
                      <td className="px-4 py-[9px]">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <FileIconComp className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />
                          <span className="text-[12px] text-zinc-200 font-mono truncate">{file.name}</span>
                          {file.isPublic && <span className="font-mono text-[10px] text-emerald-300/80">public</span>}
                        </div>
                      </td>
                      <td className="px-4 py-[9px]">
                        <span className="font-mono text-[11px] text-zinc-500">{file.bucket}</span>
                      </td>
                      <td className="px-4 py-[9px] font-mono text-[11px] text-zinc-500 tabular-nums">
                        {formatFileSize(Number(BigInt(file.size)))}
                      </td>
                      <td className="px-4 py-[9px] font-mono text-[10.5px] text-zinc-600 tabular-nums">
                        {timeAgo(file.createdAt)}
                      </td>
                      <td className="px-4 py-[9px]">
                        <div className="flex items-center justify-end gap-0.5">
                          <Tooltip content="Download">
                            <a href={file.url} download={file.name} className="p-1.5 text-zinc-600 hover:text-zinc-100 hover:bg-white/[0.04] rounded-md transition-colors inline-flex">
                              <Download className="w-3.5 h-3.5" />
                            </a>
                          </Tooltip>
                          <Tooltip content="Copy URL">
                            <button onClick={() => handleCopyLink(file.url)} className="p-1.5 text-zinc-600 hover:text-zinc-100 hover:bg-white/[0.04] rounded-md transition-colors">
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                          </Tooltip>
                          <Tooltip content="Delete">
                            <button
                              onClick={() => setFileToDelete(file)}
                              className="p-1.5 text-zinc-600 hover:text-rose-300 hover:bg-rose-500/[0.08] rounded-md transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
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
      </KitCard>

      {/* Buckets */}
      <KitCard className="mb-4">
        <KitCardHeader
          title="Buckets"
          description="Created automatically based on your app's file domains."
          actions={<span className="font-mono text-[11px] text-zinc-500 tabular-nums">{totalBuckets}</span>}
        />
        <div className="px-1 py-1">
          {(stats?.buckets ?? []).length === 0 ? (
            <div className="px-4 py-5 text-[12px] text-zinc-500">
              Buckets appear when your app needs them.
            </div>
          ) : (
            <div className="divide-y divide-white/[0.04]">
              {stats!.buckets.map(bucket => {
                const bucketSize = bucket.totalSize || 0
                const percentage = totalStorage > 0 ? (bucketSize / totalStorage) * 100 : 0
                const isSelected = selectedBucket === bucket.name
                const bucketData = buckets.find(b => b.name === bucket.name)
                return (
                  <div
                    key={bucket.name}
                    className={`flex items-center gap-3 py-[9px] px-3 rounded-md transition-colors cursor-pointer group ${
                      isSelected ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]'
                    }`}
                    onClick={() => setSelectedBucket(bucket.name === selectedBucket ? 'all' : bucket.name)}
                  >
                    <Folder className={`w-3.5 h-3.5 flex-shrink-0 ${isSelected ? 'text-violet-300' : 'text-zinc-600'}`} />
                    <span className="text-[12px] text-zinc-200 font-mono min-w-[120px] truncate">{bucket.name}</span>
                    <span className="font-mono text-[11px] text-zinc-500 tabular-nums w-16">{bucket.fileCount} file{bucket.fileCount === 1 ? '' : 's'}</span>
                    <div className="flex-1 mx-2 h-[3px] bg-white/[0.05] rounded-full overflow-hidden">
                      <motion.div
                        className="h-full bg-violet-400/50 rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${percentage}%` }}
                        transition={{ duration: 0.5, delay: 0.2 }}
                      />
                    </div>
                    <span className="font-mono text-[11px] text-zinc-500 min-w-[64px] text-right tabular-nums">{formatFileSize(bucketSize)}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        if (bucketData?.id) {
                          setBucketToDelete({ id: bucketData.id, name: bucket.name, fileCount: bucket.fileCount })
                        }
                      }}
                      className="p-1.5 text-zinc-700 group-hover:text-zinc-500 hover:!text-rose-300 hover:bg-rose-500/[0.08] rounded-md transition-colors flex-shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </KitCard>

      <InspectorGovernanceFooter />

      {/* Drag overlay — calm, no glow */}
      <AnimatePresence>
        {isDragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className="fixed inset-0 z-50 bg-[#09090b]/90 flex items-center justify-center"
          >
            <div className="bg-[#16171d] border border-dashed border-violet-400/30 rounded-xl px-14 py-12 text-center">
              <Upload className="w-4 h-4 text-violet-300 mx-auto mb-3" />
              <p className="text-[14px] font-semibold text-zinc-50 tracking-[-0.01em] mb-1">Drop to upload</p>
              <p className="text-[12px] text-zinc-500">Release to start uploading.</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete file confirmation */}
      <KitConfirmDialog
        open={!!fileToDelete}
        onCancel={() => setFileToDelete(null)}
        onConfirm={async () => {
          if (!fileToDelete) return
          setDeletingFile(true)
          try {
            await deleteFile(fileToDelete.id)
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

      {/* Delete bucket confirmation */}
      <KitConfirmDialog
        open={!!bucketToDelete}
        onCancel={() => setBucketToDelete(null)}
        onConfirm={async () => {
          if (!bucketToDelete) return
          setDeletingBucket(true)
          try {
            await deleteBucket(bucketToDelete.id)
            if (selectedBucket === bucketToDelete.name) {
              setSelectedBucket('all')
              setSelectedBucketId(null)
            }
            setBucketToDelete(null)
            await fetchData()
          } catch (error: any) {
            setBucketToDelete(null)
            setActionError(error.message || 'Failed to delete the bucket. Try again.')
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

      {/* Bucket picker — replaces the prompt() flow when uploading with no bucket selected */}
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
          {buckets.map(b => (
            <button
              key={b.id}
              onClick={() => {
                const filesToSend = pendingUpload
                setPendingUpload(null)
                if (filesToSend) performUpload(filesToSend, b.id)
              }}
              className="w-full flex items-center gap-3 px-4 py-[11px] text-left transition-colors hover:bg-white/[0.025] focus:outline-none"
            >
              <Folder className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />
              <span className="flex-1 text-[12.5px] font-mono text-zinc-200 truncate">{b.name}</span>
              <span className="font-mono text-[10.5px] tabular-nums text-zinc-600">
                {files.filter(f => f.bucket === b.name).length} files
              </span>
            </button>
          ))}
        </div>
      </KitModal>
    </div>
  )
}
