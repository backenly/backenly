'use client'

/**
 * One file, opened beside the list you keep scanning (project decision 6):
 * its preview, what it is, who sent it, and its address, with Download and
 * Delete at the foot. ↑/↓ move to the next file, Esc closes, and the open file
 * is in the URL (?file=).
 */

import type { ReactNode } from 'react'
import { Download, Trash2 } from 'lucide-react'
import { CopyField, KitButton } from '@/components/inspector/kit'
import { RecordDrawer } from '@/components/console/RecordDrawer'
import { Time } from '@/components/console/Time'
import type { StorageFile } from '@/lib/api/storage'
import { FilePreview } from './parts'
import { absoluteUrl, downloadFile, formatBytes, narrowerAccess, uploaderLabel, uploaderTitle } from './format'

export function FileDrawer({
  file,
  bucketPolicy,
  onClose,
  onPrev,
  onNext,
  position,
  canWrite,
  onDelete,
}: {
  file: StorageFile | null
  /** The policy of the bucket the file is in, to say when the file is narrower. */
  bucketPolicy: string | null | undefined
  onClose: () => void
  onPrev?: (() => void) | null
  onNext?: (() => void) | null
  position?: { index: number; total: number }
  canWrite: boolean
  onDelete: (file: StorageFile) => void
}) {
  const access = file ? narrowerAccess(file, bucketPolicy) : null
  return (
    <RecordDrawer
      open={!!file}
      onClose={onClose}
      title={file ? <span className="font-mono text-[14px]">{file.name}</span> : ''}
      label={file?.name}
      onPrev={onPrev}
      onNext={onNext}
      position={position}
      footer={
        file ? (
          <>
            {canWrite && (
              <KitButton variant="danger" icon={Trash2} onClick={() => onDelete(file)} className="mr-auto">
                Delete
              </KitButton>
            )}
            <KitButton icon={Download} onClick={() => downloadFile(file)}>
              Download
            </KitButton>
          </>
        ) : undefined
      }
    >
      {file && (
        <div className="space-y-[18px]">
          <FilePreview key={file.id} file={file} />
          <dl className="divide-y divide-white/[0.06] text-[13px] leading-[20px]">
            <Fact term="Size">{formatBytes(file.size)}</Fact>
            <Fact term="Type">
              <span className="font-mono text-[12.5px]">{file.mimeType || 'Unknown'}</span>
            </Fact>
            <Fact term="Bucket">
              <span className="font-mono text-[12.5px]">{file.bucket}</span>
            </Fact>
            {access && <Fact term="Access">{access}</Fact>}
            <Fact term="Uploaded">
              <Time iso={file.createdAt} mode="dateTime" />
            </Fact>
            <Fact term="Uploaded by" title={uploaderTitle(file)}>
              {uploaderLabel(file)}
            </Fact>
          </dl>
          <div>
            <p className="mb-[6px] text-[13px] leading-[20px] text-faint">URL</p>
            <CopyField value={absoluteUrl(file.url)} label="Copy URL" />
          </div>
        </div>
      )}
    </RecordDrawer>
  )
}

/** One fact about the file: the term, then its value as the next sibling. */
function Fact({ term, title, children }: { term: string; title?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-[12px] py-[9px] first:pt-0">
      <dt className="text-faint">{term}</dt>
      <dd className="min-w-0 text-zinc-200 [overflow-wrap:anywhere]" title={title}>
        {children}
      </dd>
    </div>
  )
}
