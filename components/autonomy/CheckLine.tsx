'use client'

import type { ReactNode } from 'react'
import { RefusedLine } from '@/components/console/states'

/** One line of the Checks panel: how often, what it found, its one action. */
export function CheckLine({
  as = 'li',
  cadence,
  children,
  action,
  note,
  noteTone = 'faint',
}: {
  as?: 'li' | 'div'
  cadence: string
  children: ReactNode
  action?: ReactNode
  /** What the last action said, under the line (role=status). */
  note?: ReactNode
  noteTone?: 'faint' | 'refused'
}) {
  const Tag = as
  return (
    <Tag className="px-[20px] py-[12px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="w-[96px] flex-shrink-0 text-[12.5px] leading-[20px] text-faint">{cadence}</span>
        <p className="min-w-0 flex-[1_1_240px] text-[13px] leading-[20px] text-zinc-300">{children}</p>
        {action && <div className="flex flex-shrink-0 items-center">{action}</div>}
      </div>
      {note &&
        (noteTone === 'refused' ? (
          <RefusedLine className="mt-1.5 sm:pl-[112px]">{note}</RefusedLine>
        ) : (
          <p role="status" className="mt-1.5 text-[12.5px] leading-[18px] text-faint sm:pl-[112px]">
            {note}
          </p>
        ))}
    </Tag>
  )
}
