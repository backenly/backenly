'use client'

/**
 * Small pieces of the Storage page: a file's kind icon, its preview, and the
 * quota said in the instrument bar.
 */

import { useState } from 'react'
import Link from 'next/link'
import { File, FileSpreadsheet, FileText, Image as ImageIcon } from 'lucide-react'
import { FOCUS, WELL, EDGE, R_CONTROL } from '@/components/console/tokens'
import type { StorageFile } from '@/lib/api/storage'
import { fileKind, formatBytes, shortType } from './format'

/** A file's kind as a bare 16px icon: the row's lead (project decision 7). */
export function FileTypeIcon({ mimeType, className = 'h-4 w-4' }: { mimeType: string | null; className?: string }) {
  const kind = fileKind(mimeType)
  const Icon = kind === 'image' ? ImageIcon : kind === 'document' ? FileText : kind === 'data' ? FileSpreadsheet : File
  return <Icon aria-hidden className={`flex-shrink-0 text-zinc-500 ${className}`} strokeWidth={1.75} />
}

/**
 * The preview in the file drawer. An image shows itself; anything else, and an
 * image the browser cannot decode or may not fetch, says its type beside the
 * kind icon instead of a broken-image glyph.
 */
export function FilePreview({ file }: { file: StorageFile }) {
  const [failed, setFailed] = useState(false)
  if (file.mimeType?.startsWith('image/') && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={file.url}
        alt=""
        onError={() => setFailed(true)}
        className={`max-h-[260px] w-full ${R_CONTROL} border ${EDGE} ${WELL} object-contain`}
      />
    )
  }
  return (
    <p className={`flex items-center gap-[10px] ${R_CONTROL} border ${EDGE} ${WELL} px-[12px] py-[10px] text-[12.5px] leading-[18px] text-faint`}>
      <FileTypeIcon mimeType={file.mimeType} />
      {failed ? 'No preview for this image' : `No preview for ${shortType(file.mimeType)} files`}
    </p>
  )
}

/** Where the project stands against its storage limit, as the bar says it. */
export interface Quota {
  used: number
  /** Null while the project's limit is unknown. */
  limit: number | null
  /** The deployment sets no cap (2^63-1 from lib/services/storageQuota.ts). */
  unlimited: boolean
  percent: number
  /** 80% and over: a brighter meter, "Nearly full". */
  warning: boolean
  /** 95% and over: a white meter, uploads are refused. */
  full: boolean
}

export function quotaOf(used: number, limit: number | null): Quota {
  const unlimited = limit !== null && limit > Number.MAX_SAFE_INTEGER
  const percent = limit && !unlimited && limit > 0 ? (used / limit) * 100 : 0
  return { used, limit, unlimited, percent, warning: percent >= 80, full: percent >= 95 }
}

/**
 * The bar's quota fact: "312.4 MB of 1 GB" and a 4px meter. In white with
 * "Nearly full" from 80%, and with "Full. Uploads are blocked." from 95%, the
 * meter brightening with it (the words carry the meaning, not a hue), and on
 * Free the way to more room. A deployment with no cap says so instead of
 * drawing a meter that can never move.
 */
export function QuotaFact({ quota, upgradeHref }: { quota: Quota; upgradeHref?: string | null }) {
  const { used, limit, unlimited, percent, warning, full } = quota
  if (limit === null) return <span>{formatBytes(used)} used</span>
  if (unlimited) return <span>{formatBytes(used)} used, no limit</span>
  const fill = full ? 'bg-zinc-50' : warning ? 'bg-zinc-200' : 'bg-zinc-400'
  return (
    <span className="inline-flex items-center gap-[8px]">
      <span>
        {formatBytes(used)} of {formatBytes(limit)}
      </span>
      {used > 0 && (
        <span
          role="meter"
          aria-label="Storage used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          aria-valuetext={`${percent.toFixed(percent < 10 ? 1 : 0)}% of the storage limit`}
          className="relative h-[4px] w-[56px] overflow-hidden rounded-full bg-white/[0.08]"
        >
          <span className={`absolute inset-y-0 left-0 rounded-full ${fill}`} style={{ width: `${Math.max(Math.min(percent, 100), 3)}%` }} />
        </span>
      )}
      {warning && (
        <span className="font-medium">
          <span className="sm:hidden">{full ? 'Full' : 'Nearly full'}</span>
          <span className="hidden sm:inline">{full ? 'Full. Uploads are blocked.' : 'Nearly full'}</span>
        </span>
      )}
      {warning && upgradeHref && (
        <Link
          href={upgradeHref}
          className={`hidden rounded-[3px] font-medium text-zinc-100 underline decoration-white/25 underline-offset-[3px] transition-colors duration-150 hover:decoration-white/60 sm:inline ${FOCUS}`}
        >
          Upgrade to Pro
        </Link>
      )}
    </span>
  )
}
