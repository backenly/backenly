'use client'

/**
 * Storage: the project's buckets and the files in them, as an instrument.
 *
 *   Storage  312.4 MB of 1 GB ━━──                                    [Upload]
 *   All files  274 │ posters  240 files  288 MB  Read access: Public  ⋯  [Search files] ⟳
 *   posters    240 │ ☐  sinners.jpg                  1.6 MB   Console          25 min ago  ⋯
 *   avatars     30 │ ☐  old-cut.jpg   Private        1.2 MB   —                3 d ago     ⋯
 *   exports      4 │ 200 of 240                                                [Load more]
 *
 * One bar (project decision 2): the title, the quota as its fact, and Upload.
 * The rail lists the buckets with their server counts; the pane shows one
 * bucket's files, read from the SERVER for that bucket and that search; a file
 * opens in a drawer beside the list (decision 6). The bucket's actions sit
 * behind its ⋯, never in icons that appear on hover.
 *
 * What a person may do follows their role (decision 9): viewers read, and
 * nothing that would be refused is offered; deleting a bucket is for admins.
 *
 * The inner layer is absolutely positioned: without it a wide grid's intrinsic
 * width propagates up through the app shell's flex chain and scrolls the
 * whole page sideways.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Upload } from 'lucide-react'
import {
  deleteBucket,
  deleteFile,
  deleteFiles,
  getBucketsWithCaveat,
  getFiles,
  getStorageStats,
  updateBucketPolicy,
  uploadFile,
  type StorageBucket,
  type StorageFile,
  type StorageStats,
} from '@/lib/api/storage'
import { getCurrentProjectId } from '@/lib/api/client'
import { getProject } from '@/lib/api/projects'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { useAgentConnection } from '@/lib/hooks/useAgentConnection'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { KIT, KitConfirmDialog, KitModal } from '@/components/inspector/kit'
import { InstrumentBar, type BarFact } from '@/components/console/InstrumentBar'
import { recordNav, useRecordParam } from '@/components/console/RecordDrawer'
import { EmptyPanel, ErrorRow } from '@/components/console/states'
import { FOCUS_INSET, RULE } from '@/components/console/tokens'
import { BucketPolicyDialog } from './BucketPolicyDialog'
import { BucketsRail } from './BucketsRail'
import { FileDrawer } from './FileDrawer'
import { FilesPane } from './FilesPane'
import { QuotaFact, quotaOf } from './parts'
import { filesWord, isPublicPolicy, toNum } from './format'

/** Files read per page; the route clamps at 500. */
const FILE_PAGE_SIZE = 200
/** The most a refresh re-reads at once, so a list grown by Load more keeps its length. */
const FILE_PAGE_MAX = 500

/** The files on screen, and which bucket and search they were read for. */
interface FilesView {
  key: string
  files: StorageFile[]
  total: number
  at: number
}

const errorText = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback)

export function StorageWorkbench({ projectId: projectIdProp }: { projectId?: string }) {
  const router = useRouter()
  const [projectId, setProjectId] = useState<string | null>(projectIdProp ?? null)
  useEffect(() => {
    if (projectIdProp) {
      setProjectId(projectIdProp)
      return
    }
    let cancelled = false
    getCurrentProjectId()
      .then((pid) => {
        if (cancelled) return
        if (pid) setProjectId(pid)
        else router.push('/app')
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectIdProp, router])

  const role = useProjectRole(projectId)
  const agent = useAgentConnection(projectId)
  const canWrite = role.canWrite
  const canAdminister = role.canAdminister

  // ── Where you are: the bucket and the open file live in the URL ────────────
  const [bucketParam, openBucketParam, closeBucketParam] = useRecordParam('bucket')
  const [fileParam, openFile, closeFile] = useRecordParam('file')
  // Phones show one pane at a time: the buckets first, unless a link named a bucket or a file.
  const [pane, setPane] = useState<'buckets' | 'files'>(() => (bucketParam || fileParam ? 'files' : 'buckets'))

  // ── Buckets, their server counts, and the project's limit ──────────────────
  const [buckets, setBuckets] = useState<StorageBucket[] | null>(null)
  const [cdnServesPublicObjects, setCdnServesPublicObjects] = useState(false)
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [limit, setLimit] = useState<number | null>(null)
  const [metaFailed, setMetaFailed] = useState(false)
  const [metaAt, setMetaAt] = useState<number | null>(null)

  const loadMeta = useCallback(async (pid: string): Promise<boolean> => {
    const [b, s] = await Promise.allSettled([getBucketsWithCaveat(pid), getStorageStats(pid)])
    if (s.status === 'fulfilled') setStats(s.value)
    if (b.status === 'fulfilled') {
      setBuckets(b.value.buckets)
      setCdnServesPublicObjects(b.value.cdnServesPublicObjects)
      setMetaFailed(false)
      setMetaAt(Date.now())
      return true
    }
    setMetaFailed(true)
    return false
  }, [])

  useEffect(() => {
    if (!projectId) return
    void loadMeta(projectId)
    getProject(projectId)
      .then((p) => setLimit(p.storageLimit ? toNum(p.storageLimit) : null))
      .catch(() => setLimit(null))
  }, [projectId, loadMeta])

  // Bucket counts come from the SERVER's per-bucket stats, never from the
  // loaded page: counting the loaded array under-reported every bucket past
  // the first page, including the delete-bucket confirmation.
  const countFor = useCallback(
    (bucketName: string) =>
      toNum(buckets?.find((b) => b.name === bucketName)?.fileCount ?? stats?.buckets.find((b) => b.name === bucketName)?.fileCount),
    [buckets, stats],
  )
  const sizeFor = useCallback(
    (bucketName: string) =>
      toNum(buckets?.find((b) => b.name === bucketName)?.totalSize ?? stats?.buckets.find((b) => b.name === bucketName)?.totalSize),
    [buckets, stats],
  )
  const policyFor = useCallback((bucketName: string) => buckets?.find((b) => b.name === bucketName)?.accessPolicy, [buckets])
  const totalFiles = stats?.totalFiles ?? (buckets ?? []).reduce((s, b) => s + toNum(b.fileCount), 0)
  const usedBytes = stats ? toNum(stats.totalSize) : buckets ? buckets.reduce((s, b) => s + toNum(b.totalSize), 0) : null

  const bucket = bucketParam && buckets ? buckets.find((b) => b.name === bucketParam) ?? null : null
  // A bucket named in the URL that the project no longer has: All files.
  useEffect(() => {
    if (bucketParam && buckets && !buckets.some((b) => b.name === bucketParam)) closeBucketParam()
  }, [bucketParam, buckets, closeBucketParam])

  // ── The files of this bucket and this search, from the server ──────────────
  const [search, setSearch] = useState('')
  const [committedSearch, setCommittedSearch] = useState('')
  useEffect(() => {
    const term = search.trim()
    const t = setTimeout(() => setCommittedSearch(term), term ? 300 : 0)
    return () => clearTimeout(t)
  }, [search])

  const scopeBucketId = bucket?.id ?? null
  const scopeKey = `${scopeBucketId ?? '*'}\u0000${committedSearch}`
  // A bucket in the URL needs its id before its files can be asked for.
  const scopeReady = !!projectId && (!bucketParam || buckets !== null)

  const [view, setView] = useState<FilesView | null>(null)
  const [filesLoading, setFilesLoading] = useState(true)
  const [filesFailedKey, setFilesFailedKey] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  // Each read is numbered; an answer that a newer read overtook is dropped.
  const seq = useRef(0)

  const loadFiles = useCallback(
    async (pid: string, bucketId: string | null, term: string, key: string, size = FILE_PAGE_SIZE): Promise<boolean> => {
      const mine = ++seq.current
      setFilesLoading(true)
      try {
        const page = await getFiles({ projectId: pid, bucketId: bucketId ?? undefined, search: term || undefined, limit: size })
        if (mine !== seq.current) return true
        setView({ key, files: page.files, total: page.total, at: Date.now() })
        setFilesFailedKey(null)
        return true
      } catch {
        if (mine !== seq.current) return true
        setFilesFailedKey(key)
        return false
      } finally {
        if (mine === seq.current) setFilesLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (!scopeReady || !projectId) return
    void loadFiles(projectId, scopeBucketId, committedSearch, scopeKey)
  }, [scopeReady, projectId, scopeBucketId, committedSearch, scopeKey, loadFiles])

  const files = view && view.key === scopeKey ? view.files : null
  const filesTotal = view && view.key === scopeKey ? view.total : 0

  const [actionError, setActionError] = useState<string | null>(null)

  const loadMoreFiles = async () => {
    if (!projectId || !view || view.key !== scopeKey || loadingMore || view.files.length >= view.total) return
    const mine = seq.current
    setLoadingMore(true)
    try {
      const page = await getFiles({
        projectId,
        bucketId: scopeBucketId ?? undefined,
        search: committedSearch || undefined,
        limit: FILE_PAGE_SIZE,
        offset: view.files.length,
      })
      if (mine !== seq.current) return
      setView((v) => {
        if (!v || v.key !== scopeKey) return v
        const have = new Set(v.files.map((f) => f.id))
        return { ...v, files: [...v.files, ...page.files.filter((f) => !have.has(f.id))], total: page.total }
      })
    } catch (err) {
      setActionError(`Could not load more files. ${errorText(err, '')}`.trim())
    } finally {
      setLoadingMore(false)
    }
  }

  // ── Refresh: the bar's data and the list, together ─────────────────────────
  const [refreshing, setRefreshing] = useState(false)
  const [metaStaleAt, setMetaStaleAt] = useState<number | null>(null)
  const refresh = useCallback(async () => {
    if (!projectId) return
    setRefreshing(true)
    const keep = view && view.key === scopeKey ? Math.min(FILE_PAGE_MAX, Math.max(FILE_PAGE_SIZE, view.files.length)) : FILE_PAGE_SIZE
    const [metaOk] = await Promise.all([
      loadMeta(projectId),
      scopeReady ? loadFiles(projectId, scopeBucketId, committedSearch, scopeKey, keep) : Promise.resolve(true),
    ])
    setMetaStaleAt(metaOk ? null : metaAt)
    setRefreshing(false)
  }, [projectId, view, scopeKey, loadMeta, scopeReady, loadFiles, scopeBucketId, committedSearch, metaAt])

  // Agents and functions write files too; the console's own writes announce themselves here.
  useEffect(() => {
    const onChanged = () => void refresh()
    window.addEventListener('backenly:storage-changed', onChanged)
    return () => window.removeEventListener('backenly:storage-changed', onChanged)
  }, [refresh])

  // ── Selection, kept with the list it was made in ───────────────────────────
  const [picked, setPicked] = useState<{ key: string; ids: Set<string> }>({ key: '', ids: new Set() })
  const selection = useMemo(() => (picked.key === scopeKey ? picked.ids : new Set<string>()), [picked, scopeKey])
  const toggle = (id: string) => {
    const next = new Set(selection)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked({ key: scopeKey, ids: next })
  }
  const toggleAll = () => {
    if (!files) return
    const all = files.length > 0 && files.every((f) => selection.has(f.id))
    setPicked({ key: scopeKey, ids: all ? new Set() : new Set(files.map((f) => f.id)) })
  }
  const clearSelection = () => setPicked({ key: scopeKey, ids: new Set() })

  // ── Moving around ──────────────────────────────────────────────────────────
  const selectBucket = (name: string | null) => {
    if (name === null) closeBucketParam()
    else openBucketParam(name)
    closeFile()
    setSearch('')
    setCommittedSearch('')
    setActionError(null)
    setPane('files')
  }

  const nav = recordNav(files ?? [], (f) => f.id, fileParam, openFile)

  // ── Deleting ───────────────────────────────────────────────────────────────
  const [toDelete, setToDelete] = useState<StorageFile[] | null>(null)
  const [deletingFiles, setDeletingFiles] = useState(false)
  const confirmDeleteFiles = async () => {
    if (!toDelete || toDelete.length === 0) return
    setDeletingFiles(true)
    setActionError(null)
    const ids = toDelete.map((f) => f.id)
    try {
      if (ids.length === 1) await deleteFile(ids[0])
      else await deleteFiles(ids)
      if (fileParam && ids.includes(fileParam)) closeFile()
      setPicked({ key: scopeKey, ids: new Set([...selection].filter((id) => !ids.includes(id))) })
      setToDelete(null)
      await refresh()
    } catch (err) {
      setToDelete(null)
      setActionError(errorText(err, ids.length === 1 ? 'The file was not deleted.' : 'The files were not deleted.'))
    } finally {
      setDeletingFiles(false)
    }
  }

  const [bucketToDelete, setBucketToDelete] = useState<StorageBucket | null>(null)
  const [deletingBucket, setDeletingBucket] = useState(false)
  const confirmDeleteBucket = async () => {
    if (!bucketToDelete) return
    setDeletingBucket(true)
    setActionError(null)
    try {
      await deleteBucket(bucketToDelete.id)
      if (bucketParam === bucketToDelete.name) {
        closeBucketParam()
        closeFile()
      }
      setBucketToDelete(null)
      await refresh()
    } catch (err) {
      setBucketToDelete(null)
      setActionError(errorText(err, 'The bucket was not deleted.'))
    } finally {
      setDeletingBucket(false)
    }
  }

  // ── Who can read a bucket ──────────────────────────────────────────────────
  const [policyTarget, setPolicyTarget] = useState<StorageBucket | null>(null)

  // ── Uploading ──────────────────────────────────────────────────────────────
  const quota = quotaOf(usedBytes ?? 0, limit)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [pendingUpload, setPendingUpload] = useState<File[] | null>(null)
  const [dragging, setDragging] = useState(false)
  const hasBuckets = !!buckets && buckets.length > 0
  const canUpload = canWrite && hasBuckets

  const performUpload = async (list: File[], target: StorageBucket) => {
    setUploading(true)
    setActionError(null)
    try {
      for (const file of list) {
        const id = `${Date.now()}-${file.name}`
        await uploadFile({ file, bucketId: target.id }, (p) => setProgress((prev) => ({ ...prev, [id]: p })))
        setProgress((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
    } catch (err) {
      // The server's words: a blocked type, a file over the bucket's limit, a full quota.
      setActionError(errorText(err, 'The upload did not finish.'))
      setProgress({})
    } finally {
      setUploading(false)
      await refresh()
    }
  }

  const handleUpload = (list: File[]) => {
    if (list.length === 0 || !canUpload || !buckets) return
    if (quota.full) {
      setActionError('Storage is full, so uploads are blocked. Delete files to make room.')
      return
    }
    const target = bucket ?? (buckets.length === 1 ? buckets[0] : null)
    if (!target) {
      setPendingUpload(list)
      return
    }
    void performUpload(list, target)
  }

  const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const dropHandlers = canUpload
    ? {
        onDragOver: (e: DragEvent) => {
          if (!carriesFiles(e)) return
          e.preventDefault()
          if (!dragging) setDragging(true)
        },
        onDrop: (e: DragEvent) => {
          if (!carriesFiles(e)) return
          e.preventDefault()
          setDragging(false)
          handleUpload(Array.from(e.dataTransfer.files))
        },
      }
    : {}

  // ── What the bar says ──────────────────────────────────────────────────────
  const free = useFreePlan(role.organizationId, quota.warning)
  const upgradeHref = free ? (role.organizationId ? `/app/org/${role.organizationId}/billing` : '/app/billing') : null
  const facts: Array<BarFact | null> = [
    usedBytes !== null ? { text: <QuotaFact quota={quota} upgradeHref={upgradeHref} />, tone: quota.full ? 'danger' : quota.warning ? 'attention' : 'neutral' } : null,
    role.role !== null && !canWrite ? { text: 'Read only' } : null,
  ]

  const firstLoad = buckets === null && !metaFailed
  const metaError = buckets === null && metaFailed
  const noBuckets = !!buckets && buckets.length === 0

  const retryAll = () => {
    if (!projectId) return
    void loadMeta(projectId)
    if (scopeReady) void loadFiles(projectId, scopeBucketId, committedSearch, scopeKey)
  }

  const filesStale =
    filesFailedKey === scopeKey && files ? { things: 'files', at: view!.at } : metaStaleAt !== null ? { things: 'buckets', at: metaStaleAt } : null

  const uploads = Object.values(progress)
  const deleteTitle = (list: StorageFile[]) => {
    if (list.length === 1) return `Delete ${list[0].name}?`
    const from = new Set(list.map((f) => f.bucket))
    return from.size === 1 ? `Delete ${filesWord(list.length)} from ${[...from][0]}?` : `Delete ${filesWord(list.length)}?`
  }
  const bucketFiles = bucketToDelete ? countFor(bucketToDelete.name) : 0

  return (
    <div className={`console-fill flex flex-col overflow-hidden ${KIT.bg}`} {...dropHandlers}>
      <input ref={fileInputRef} type="file" multiple tabIndex={-1} aria-hidden className="hidden" onChange={(e) => {
        if (e.target.files) handleUpload(Array.from(e.target.files))
        e.target.value = ''
      }} />

      <InstrumentBar
        title="Storage"
        loading={firstLoad}
        facts={facts}
        create={
          canUpload
            ? {
                label: uploading ? 'Uploading…' : 'Upload',
                icon: Upload,
                primary: true,
                disabled: uploading || quota.full,
                onClick: () => fileInputRef.current?.click(),
              }
            : undefined
        }
      />

      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex">
          {metaError ? (
            <div className="min-w-0 flex-1">
              <ErrorRow things="buckets" onRetry={retryAll} />
            </div>
          ) : noBuckets ? (
            <div className="min-w-0 flex-1 overflow-y-auto">
              <EmptyPanel
                title="No buckets yet"
                sentence="Your agent creates a bucket when your app needs to store files."
                requests={['Add profile photo uploads: a private bucket, and only the owner can read their files.']}
                agent={role.loading ? null : { status: agent.status, client: agent.client }}
                canConnect={canAdminister}
                docs={{ label: 'Storage docs', slug: 'storage' }}
                headingLevel={2}
              />
            </div>
          ) : (
            <>
              <BucketsRail
                buckets={buckets ?? []}
                loading={firstLoad}
                selected={bucket?.name ?? (firstLoad ? bucketParam : null)}
                totalFiles={totalFiles}
                countFor={countFor}
                onSelect={selectBucket}
                className={`w-full flex-shrink-0 md:w-[248px] ${KIT.rail} ${pane === 'files' ? 'hidden md:flex' : 'flex'}`}
              />
              <section
                aria-label={bucket ? `Files in ${bucket.name}` : 'All files'}
                className={`min-w-0 flex-1 flex-col ${pane === 'buckets' ? 'hidden md:flex' : 'flex'}`}
              >
                <FilesPane
                  bucket={bucket}
                  scopeCount={bucket ? countFor(bucket.name) : totalFiles}
                  scopeSize={bucket ? sizeFor(bucket.name) : null}
                  policyFor={policyFor}
                  files={files}
                  total={filesTotal}
                  loading={filesLoading}
                  failed={filesFailedKey === scopeKey}
                  staleAt={filesStale?.at ?? null}
                  staleThings={filesStale?.things}
                  onRetry={() => void refresh()}
                  onLoadMore={() => void loadMoreFiles()}
                  loadingMore={loadingMore}
                  onRefresh={() => void refresh()}
                  refreshing={refreshing}
                  search={search}
                  onSearch={setSearch}
                  committedSearch={committedSearch}
                  selection={selection}
                  onToggle={toggle}
                  onToggleAll={toggleAll}
                  onClearSelection={clearSelection}
                  canWrite={canWrite}
                  canAdminister={canAdminister}
                  openFileId={nav.item?.id ?? null}
                  onOpen={openFile}
                  onDeleteFiles={(list) => setToDelete(list)}
                  onDeleteBucket={() => bucket && setBucketToDelete(bucket)}
                  onEditPolicy={() => bucket && setPolicyTarget(bucket)}
                  onBack={() => setPane('buckets')}
                  actionError={actionError}
                  onDismissError={() => setActionError(null)}
                  uploads={uploads}
                />
              </section>
            </>
          )}
        </div>
      </div>

      <FileDrawer
        file={nav.item}
        bucketPolicy={nav.item ? policyFor(nav.item.bucket) : null}
        onClose={closeFile}
        onPrev={nav.onPrev}
        onNext={nav.onNext}
        position={nav.position}
        canWrite={canWrite}
        onDelete={(f) => setToDelete([f])}
      />

      {/* Drop anywhere: the files go to the bucket in view, or you choose one. */}
      {dragging && canUpload && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-[#08090a]/85 p-[24px]"
          onDragOver={(e) => {
            e.preventDefault()
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDragging(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            handleUpload(Array.from(e.dataTransfer.files))
          }}
        >
          <div className="pointer-events-none rounded-[14px] border border-dashed border-white/25 bg-[#0f1012] px-[48px] py-[36px] text-center">
            <p className="text-[15px] font-medium text-white">Drop to upload</p>
            <p className="mt-[4px] text-[13px] text-zinc-400">
              {bucket ? (
                <>
                  To <span className="font-mono text-[12.5px] text-zinc-200">{bucket.name}</span>
                </>
              ) : buckets && buckets.length === 1 ? (
                <>
                  To <span className="font-mono text-[12.5px] text-zinc-200">{buckets[0].name}</span>
                </>
              ) : (
                'You choose the bucket next.'
              )}
            </p>
          </div>
        </div>
      )}

      {/* Files: deleted for good, so the confirm says so (decision 8). */}
      <KitConfirmDialog
        open={!!toDelete}
        onCancel={() => !deletingFiles && setToDelete(null)}
        onConfirm={confirmDeleteFiles}
        title={toDelete ? deleteTitle(toDelete) : ''}
        undoable={false}
        confirmLabel={toDelete && toDelete.length > 1 ? `Delete ${filesWord(toDelete.length)}` : 'Delete file'}
        danger
        busy={deletingFiles}
      />

      {/* A bucket: an empty one comes back from History; one with files does not
          (lib/changes/resources/storage.ts), because its files went with it. */}
      <KitConfirmDialog
        open={!!bucketToDelete}
        onCancel={() => !deletingBucket && setBucketToDelete(null)}
        onConfirm={confirmDeleteBucket}
        title={
          bucketToDelete ? (
            <>
              Delete bucket <span className="font-mono text-[14px]">{bucketToDelete.name}</span>?
            </>
          ) : (
            ''
          )
        }
        // History brings the bucket back, but only empty: its files went with it.
        undoable={bucketFiles > 0 ? undefined : true}
        description={
          bucketFiles > 0 ? `Its ${filesWord(bucketFiles)} are deleted for good. Undo in History brings back only the empty bucket.` : 'It holds no files.'
        }
        confirmLabel="Delete bucket"
        danger
        busy={deletingBucket}
      />

      {policyTarget && (
        <BucketPolicyDialog
          bucketName={policyTarget.name}
          current={policyTarget.accessPolicy ?? 'private'}
          // The server's own view of its storage: whether a CDN serves public
          // files decides whether this rule can be revoked at all.
          cdnCaveat={cdnServesPublicObjects}
          onClose={() => setPolicyTarget(null)}
          onSave={async (policy) => {
            await updateBucketPolicy(policyTarget.id, policy)
            setPolicyTarget(null)
            await refresh()
          }}
        />
      )}

      {/* An upload with no bucket in view, in a project with several: where to. */}
      <KitModal
        open={!!pendingUpload}
        onClose={() => setPendingUpload(null)}
        title="Choose a bucket"
        description={pendingUpload ? `Where should ${pendingUpload.length === 1 ? 'this file' : `these ${pendingUpload.length} files`} go?` : undefined}
      >
        <ul className={`-mx-[20px] divide-y divide-white/[0.06] border-y ${RULE}`}>
          {(buckets ?? []).map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => {
                  const list = pendingUpload
                  setPendingUpload(null)
                  if (list) void performUpload(list, b)
                }}
                className={`flex w-full items-center gap-[12px] px-[20px] py-[11px] text-left transition-colors duration-150 hover:bg-white/[0.035] ${FOCUS_INSET}`}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-zinc-100">{b.name}</span>
                {isPublicPolicy(b.accessPolicy) && <span className="text-[12px] text-faint">Public</span>}
                <span className="text-[12px] tabular-nums text-faint">{filesWord(countFor(b.name))}</span>
              </button>
            </li>
          ))}
        </ul>
      </KitModal>
    </div>
  )
}

/**
 * Whether the project's team is on Free, asked only when it matters (the
 * quota is nearly full) and only on Cloud, where plans exist. False until
 * known, so the upgrade link appears only when it is true.
 */
function useFreePlan(orgId: string | null, needed: boolean): boolean {
  const [free, setFree] = useState(false)
  useEffect(() => {
    if (!needed || !CLOUD_CONTROL_PLANE) return
    let cancelled = false
    fetch(orgId ? `/api/billing/current?orgId=${encodeURIComponent(orgId)}` : '/api/billing/current', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setFree(d?.displayName === 'Free')
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [orgId, needed])
  return free
}
