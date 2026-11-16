'use client'

/**
 * The files pane: one toolbar (the bucket, its count, ⋯, search, refresh), the
 * grid, and the footer that says how much of the list is loaded.
 *
 * Every list it shows came from the server for exactly this bucket and this
 * search. It used to filter the first 200 files of the whole project in the
 * browser, so a bucket of 240 read "166 of 240 loaded" and a search missed
 * whatever was not loaded yet.
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, Copy, Download, KeyRound, Trash2 } from 'lucide-react'
import { GridFooter, PaneToolbar, type MenuItems } from '@/components/console/InstrumentBar'
import { ErrorRow, RefusedLine } from '@/components/console/states'
import { Time } from '@/components/console/Time'
import { FOCUS, FOCUS_INSET, GRID_HEAD, RULE } from '@/components/console/tokens'
import { KIT, KitButton, KitCheckbox, OverflowMenu, Skeleton } from '@/components/inspector/kit'
import type { StorageBucket, StorageFile } from '@/lib/api/storage'
import { FileTypeIcon } from './parts'
import {
  POLICY_WORDS,
  absoluteUrl,
  downloadFile,
  filesWord,
  formatBytes,
  narrowerAccess,
  policyOf,
  uploaderLabel,
  uploaderTitle,
} from './format'

export interface FilesPaneProps {
  /** The bucket in view; null is All files. */
  bucket: StorageBucket | null
  /** How many files the scope holds on the server (the bucket's count, or the project's). */
  scopeCount: number
  /** The bucket's size, from the server. */
  scopeSize: number | null
  /** A file's bucket policy, by bucket name: says where a file is narrower than its bucket. */
  policyFor: (bucketName: string) => string | null | undefined

  /** The loaded files for this bucket and search; null while there are none to show yet. */
  files: StorageFile[] | null
  /** How many match on the server. */
  total: number
  loading: boolean
  /** The first read of this list failed: nothing to show, an error row instead. */
  failed: boolean
  /** A refresh failed while rows from an earlier read are on screen. */
  staleAt: number | null
  /** What could not be refreshed: "files", or "buckets" when the rail's read failed. */
  staleThings?: string
  onRetry: () => void
  onLoadMore: () => void
  loadingMore: boolean
  onRefresh: () => void
  refreshing: boolean

  search: string
  onSearch: (value: string) => void
  /** The search the list was read with. */
  committedSearch: string

  selection: ReadonlySet<string>
  onToggle: (id: string) => void
  onToggleAll: () => void
  onClearSelection: () => void

  canWrite: boolean
  canAdminister: boolean
  openFileId: string | null
  onOpen: (id: string) => void
  onDeleteFiles: (files: StorageFile[]) => void
  onDeleteBucket: () => void
  onEditPolicy: () => void

  /** Phone: back to the buckets list. */
  onBack: () => void
  /** A refused action, in the server's words. */
  actionError: string | null
  onDismissError: () => void
  /** Uploads in flight: their progress, 0-100. */
  uploads: number[]
}

export function FilesPane(props: FilesPaneProps) {
  const {
    bucket,
    scopeCount,
    scopeSize,
    policyFor,
    files,
    total,
    loading,
    failed,
    staleAt,
    staleThings = 'files',
    onRetry,
    onLoadMore,
    loadingMore,
    onRefresh,
    refreshing,
    search,
    onSearch,
    committedSearch,
    selection,
    onToggle,
    onToggleAll,
    onClearSelection,
    canWrite,
    canAdminister,
    openFileId,
    onOpen,
    onDeleteFiles,
    onDeleteBucket,
    onEditPolicy,
    onBack,
    actionError,
    onDismissError,
    uploads,
  } = props

  // "Copied" beside the row whose URL was just copied, for a moment.
  const [copied, setCopied] = useState<string | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  const copyUrl = (file: StorageFile) => {
    navigator.clipboard?.writeText(absoluteUrl(file.url)).then(
      () => {
        setCopied(file.id)
        clearTimeout(copiedTimer.current)
        copiedTimer.current = setTimeout(() => setCopied(null), 1600)
      },
      () => {},
    )
  }

  const selected = files ? files.filter((f) => selection.has(f.id)) : []
  const selecting = canWrite && selected.length > 0
  const policy = bucket ? policyOf(bucket.accessPolicy) : null

  const bucketMenu: MenuItems | undefined =
    bucket && !selecting
      ? [
          { label: 'Copy name', icon: Copy, onClick: () => void navigator.clipboard?.writeText(bucket.name).catch(() => {}) },
          ...(canWrite ? [{ label: 'Read access…', icon: KeyRound, onClick: onEditPolicy }] : []),
          ...(canAdminister ? [{ separator: true } as const, { label: 'Delete bucket…', icon: Trash2, danger: true, onClick: onDeleteBucket }] : []),
        ]
      : undefined

  const searching = committedSearch.trim() !== ''
  const facts = selecting ? (
    <span className="text-zinc-300">{selected.length.toLocaleString('en-US')} selected</span>
  ) : (
    <>
      <span>{searching ? `${total.toLocaleString('en-US')} of ${filesWord(scopeCount)}` : filesWord(scopeCount)}</span>
      {bucket && scopeSize !== null && <span className="ml-[12px] hidden sm:inline">{formatBytes(scopeSize)}</span>}
      {bucket && policy && (
        <span className="ml-[12px] hidden md:inline">
          {canWrite ? (
            <button
              type="button"
              onClick={onEditPolicy}
              className={`rounded-[4px] text-zinc-300 underline decoration-white/20 underline-offset-[3px] transition-colors duration-150 hover:text-white hover:decoration-white/50 ${FOCUS}`}
            >
              Read access: {POLICY_WORDS[policy].title}
            </button>
          ) : (
            <>Read access: {POLICY_WORDS[policy].title}</>
          )}
        </span>
      )}
    </>
  )

  const hasRows = !!files && files.length > 0
  const allChecked = hasRows && files!.every((f) => selection.has(f.id))
  const someChecked = hasRows && !allChecked && files!.some((f) => selection.has(f.id))

  return (
    <>
      {/* Phone: the buckets list is the first screen; this is the way back to it. */}
      <div className={`flex h-[40px] flex-shrink-0 items-center border-b ${RULE} px-[8px] md:hidden`}>
        <button
          type="button"
          onClick={onBack}
          className={`inline-flex h-[30px] items-center gap-[4px] rounded-[7px] px-[8px] text-[13px] font-medium text-zinc-300 transition-colors duration-150 hover:bg-white/[0.05] hover:text-zinc-100 ${FOCUS}`}
        >
          <ChevronLeft aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.75} />
          Buckets
        </button>
      </div>

      <PaneToolbar
        title={bucket ? bucket.name : 'All files'}
        mono={!!bucket}
        count={facts}
        menu={bucketMenu}
        menuLabel={bucket ? `Actions for bucket ${bucket.name}` : undefined}
        search={{ value: search, onChange: onSearch, placeholder: 'Search files' }}
        action={
          selecting ? (
            <>
              <KitButton size="sm" variant="danger" icon={Trash2} onClick={() => onDeleteFiles(selected)}>
                Delete {filesWord(selected.length)}
              </KitButton>
              <KitButton size="sm" variant="ghost" onClick={onClearSelection}>
                Clear
              </KitButton>
            </>
          ) : undefined
        }
        onRefresh={onRefresh}
        refreshing={refreshing}
      />

      {actionError && (
        <div className={`flex flex-shrink-0 items-start gap-[12px] border-b ${RULE} px-[16px] py-[8px] sm:px-[20px]`}>
          <RefusedLine className="min-w-0 flex-1 pt-[5px]">{actionError}</RefusedLine>
          <KitButton size="sm" variant="ghost" onClick={onDismissError}>
            Dismiss
          </KitButton>
        </div>
      )}

      {staleAt !== null && files && <ErrorRow things={staleThings} staleAt={staleAt} onRetry={onRetry} retrying={refreshing} />}

      <div className="min-h-0 flex-1 overflow-auto">
        {files === null ? (
          failed ? (
            <ErrorRow things="files" onRetry={onRetry} retrying={loading} />
          ) : (
            <GridSkeleton canWrite={canWrite} />
          )
        ) : files.length === 0 ? (
          searching ? (
            <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px] px-[16px] py-[14px] sm:px-[20px]">
              <p className="text-[13px] leading-[20px] text-zinc-400">No files match “{committedSearch.trim()}”.</p>
              <KitButton size="sm" onClick={() => onSearch('')}>
                Clear search
              </KitButton>
            </div>
          ) : (
            <p className="px-[16px] py-[14px] text-[13px] leading-[20px] text-zinc-400 sm:px-[20px]">
              {bucket ? (
                <>
                  No files in <span className="font-mono text-[12.5px] text-zinc-300">{bucket.name}</span> yet.
                </>
              ) : (
                'No files yet.'
              )}
              {canWrite && ' Drop files here or use Upload.'}
            </p>
          )
        ) : (
          <table className={`w-full border-separate border-spacing-0 transition-opacity duration-150 ${loading ? 'opacity-60' : ''}`}>
            <thead className="sticky top-0 z-10">
              <tr className={GRID_HEAD}>
                {canWrite && (
                  <th scope="col" className={`w-[44px] border-b ${RULE} ${GRID_HEAD} py-0 pl-[16px] pr-[4px] text-left sm:pl-[20px]`}>
                    <KitCheckbox
                      checked={allChecked}
                      indeterminate={someChecked}
                      onChange={onToggleAll}
                      aria-label={allChecked ? 'Clear the selection' : 'Select all loaded files'}
                    />
                  </th>
                )}
                <th scope="col" className={`${TH} ${canWrite ? 'pl-[8px]' : 'pl-[16px] sm:pl-[20px]'}`}>
                  Name
                </th>
                {!bucket && (
                  <th scope="col" className={`${TH} hidden w-[120px] md:table-cell`}>
                    Bucket
                  </th>
                )}
                <th scope="col" className={`${TH} hidden w-[96px] text-right md:table-cell`}>
                  Size
                </th>
                <th scope="col" className={`${TH} hidden w-[200px] lg:table-cell`}>
                  Uploaded by
                </th>
                <th scope="col" className={`${TH} hidden w-[112px] md:table-cell`}>
                  Uploaded
                </th>
                <th scope="col" className={`${TH} w-[48px] pr-[12px]`}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => {
                const isOpen = openFileId === file.id
                const isChecked = selection.has(file.id)
                const access = narrowerAccess(file, bucket ? bucket.accessPolicy : policyFor(file.bucket))
                const rowMenu: MenuItems = [
                  { label: 'Copy URL', icon: Copy, onClick: () => copyUrl(file) },
                  { label: 'Download', icon: Download, onClick: () => downloadFile(file) },
                  ...(canWrite ? [{ separator: true } as const, { label: 'Delete…', icon: Trash2, danger: true, onClick: () => onDeleteFiles([file]) }] : []),
                ]
                return (
                  <tr
                    key={file.id}
                    aria-current={isOpen || undefined}
                    onClick={() => onOpen(file.id)}
                    className={`group/row cursor-pointer transition-colors duration-150 ${isOpen ? 'bg-white/[0.045]' : isChecked ? 'bg-white/[0.025]' : KIT.rowHoverOn}`}
                  >
                    {canWrite && (
                      <td className={`${TD} py-0 pl-[16px] pr-[4px] sm:pl-[20px]`} onClick={(e) => e.stopPropagation()}>
                        <KitCheckbox checked={isChecked} onChange={() => onToggle(file.id)} aria-label={`Select ${file.name}`} />
                      </td>
                    )}
                    <td className={`${TD} max-w-0 ${canWrite ? 'pl-[8px]' : 'pl-[16px] sm:pl-[20px]'}`}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpen(file.id)
                        }}
                        title={file.name}
                        className={`flex w-full min-w-0 items-start gap-[10px] rounded-[5px] py-[2px] text-left md:items-center ${FOCUS_INSET}`}
                      >
                        <span className="mt-[1px] flex md:mt-0">
                          <FileTypeIcon mimeType={file.mimeType} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-[8px]">
                            <span className={`min-w-0 truncate font-mono text-[12.5px] ${isOpen ? 'text-zinc-50' : 'text-zinc-200'}`}>{file.name}</span>
                            {access && <span className="flex-shrink-0 text-[12px] text-faint">{access}</span>}
                            {copied === file.id && (
                              <span role="status" className="flex-shrink-0 text-[12px] text-zinc-300">
                                Copied
                              </span>
                            )}
                          </span>
                          {/* Phone: the facts the columns carry at wider sizes, on a second line. */}
                          <span className="mt-[2px] flex gap-[12px] text-[12px] leading-[16px] tabular-nums text-faint md:hidden">
                            <span>{formatBytes(file.size)}</span>
                            <Time iso={file.createdAt} />
                          </span>
                        </span>
                      </button>
                    </td>
                    {!bucket && <td className={`${TD} hidden truncate font-mono text-[12px] text-faint md:table-cell`}>{file.bucket}</td>}
                    <td className={`${TD} hidden text-right text-[12.5px] tabular-nums text-zinc-300 md:table-cell`}>{formatBytes(file.size)}</td>
                    <td className={`${TD} hidden max-w-[200px] lg:table-cell`}>
                      <span className="block truncate text-[12.5px] text-zinc-400" title={uploaderTitle(file)}>
                        {uploaderLabel(file)}
                      </span>
                    </td>
                    <td className={`${TD} hidden text-[12.5px] text-faint md:table-cell`}>
                      <Time iso={file.createdAt} />
                    </td>
                    <td className={`${TD} py-0 pr-[12px] text-right`} onClick={(e) => e.stopPropagation()}>
                      <span className="inline-flex">
                        <OverflowMenu label={`Actions for ${file.name}`} items={rowMenu} />
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {uploads.length > 0 && (
        <div role="status" className={`flex min-h-[36px] flex-shrink-0 items-center gap-[12px] border-t ${RULE} px-[16px] text-[12.5px] text-faint sm:px-[20px]`}>
          <span className="whitespace-nowrap">Uploading {filesWord(uploads.length)}</span>
          <span className="relative h-[3px] w-[120px] overflow-hidden rounded-full bg-white/[0.08]" aria-hidden>
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-zinc-300 transition-[width] duration-200"
              style={{ width: `${uploads.reduce((s, p) => s + p, 0) / uploads.length}%` }}
            />
          </span>
        </div>
      )}

      {hasRows && <GridFooter mode="more" shown={files!.length} total={total} hasMore={files!.length < total} onLoadMore={onLoadMore} loading={loadingMore} />}
    </>
  )
}

const TH = `h-[36px] whitespace-nowrap border-b ${RULE} px-[12px] text-left text-[12px] font-normal text-faint`
const TD = 'h-[40px] border-b border-white/[0.04] px-[12px] py-[6px]'

function GridSkeleton({ canWrite }: { canWrite: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading files">
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <div key={i} aria-hidden className="flex h-[40px] items-center gap-[12px] border-b border-white/[0.04] px-[16px] sm:px-[20px]">
          {canWrite && <Skeleton className="h-[14px] w-[14px] flex-shrink-0" />}
          <Skeleton className="h-[14px] w-[14px] flex-shrink-0" />
          <Skeleton className={`h-[12px] ${i % 3 === 0 ? 'w-[38%]' : i % 3 === 1 ? 'w-[28%]' : 'w-[46%]'}`} />
          <Skeleton className="ml-auto hidden h-[12px] w-[56px] md:block" />
          <Skeleton className="hidden h-[12px] w-[72px] md:block" />
        </div>
      ))}
    </div>
  )
}
