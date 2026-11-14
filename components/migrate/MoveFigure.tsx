'use client'

import { useState } from 'react'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import { useOnScreen } from '@/components/landing-v7/shared'
import { IllustrativeNote, PlayPause } from '@/components/landing-v7/scene-ui'
import { MoveLedger } from './MoveLedger'
import { DEMO_PLANS, durationOf, progressAt } from './plan'
import type { SourceId } from './sources'
import { usePlayhead } from './usePlayhead'

/**
 * The move screen's ledger, playing an example project on a loop while it is
 * on screen: the picture on a /migrate page. Reduced motion shows the
 * finished move, the state worth reading.
 */
export function MoveFigure({ source }: { source: SourceId }) {
  const quiet = useSettledReducedMotion()
  const [paused, setPaused] = useState(false)
  const [ref, onScreen] = useOnScreen<HTMLDivElement>('0px')
  const plan = DEMO_PLANS[source]
  const duration = durationOf(plan)
  const t = usePlayhead({ duration, running: onScreen && !paused && !quiet, loop: true, hold: 3.2, resetKey: source })

  return (
    <div ref={ref}>
      <MoveLedger plan={plan} progress={progressAt(plan, quiet ? duration : t)} />
      <div className="mt-4 flex items-center gap-3">
        {!quiet && <PlayPause what="example move" paused={paused} onToggle={() => setPaused((v) => !v)} />}
        <IllustrativeNote>An example project, played on a loop.</IllustrativeNote>
      </div>
    </div>
  )
}
