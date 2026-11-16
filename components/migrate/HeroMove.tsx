'use client'

import { useState } from 'react'
import { MoveFigure } from './MoveFigure'
import { SOURCE_ORDER, SOURCES, SourceMark, type SourceId } from './sources'

/**
 * The /migrate hero's picture: the product's own move screen playing an
 * example project, with the source to play picked from a row of buttons. A
 * new source starts its move over (MoveFigure's playhead resets on it).
 */
export function HeroMove() {
  const [source, setSource] = useState<SourceId>('supabase')
  return (
    <div>
      <div role="group" aria-label="Example to play" className="mb-[14px] flex flex-wrap items-center gap-[8px]">
        <span className="mr-[4px] text-[13px] text-zinc-400">Moving from</span>
        {SOURCE_ORDER.map((id) => {
          const on = id === source
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              onClick={() => setSource(id)}
              className={`inline-flex h-[30px] items-center gap-[7px] rounded-[6px] border px-[10px] text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
                on
                  ? 'border-white/[0.22] bg-white/[0.08] text-white'
                  : 'border-white/[0.08] bg-white/[0.02] text-zinc-400 hover:border-white/[0.16] hover:text-white'
              }`}
            >
              <SourceMark id={id} className="h-[13px] w-[13px]" />
              {id === 'postgres' ? 'Any Postgres' : SOURCES[id].name}
            </button>
          )
        })}
      </div>
      <MoveFigure source={source} />
    </div>
  )
}
