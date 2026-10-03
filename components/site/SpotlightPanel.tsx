'use client'

import { useRef, type PointerEvent, type ReactNode } from 'react'
import { PANEL } from '@/components/site/tokens'

/**
 * The landing bento cell: a raised panel whose border and surface pick up a
 * faint violet light under the cursor. The pointer position is written straight
 * to CSS custom properties on the element, never to React state, so moving the
 * mouse re-renders nothing. On touch there is no hover, and the panel simply
 * rests.
 */
export function SpotlightPanel({
  children,
  className = '',
  as = 'article',
}: {
  children: ReactNode
  className?: string
  as?: 'article' | 'div' | 'li'
}) {
  const ref = useRef<HTMLElement>(null)

  function onMove(event: PointerEvent<HTMLElement>) {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    el.style.setProperty('--x', `${event.clientX - rect.left}px`)
    el.style.setProperty('--y', `${event.clientY - rect.top}px`)
  }

  const Component = as as 'article'

  return (
    <Component
      ref={ref as React.Ref<HTMLElement>}
      onPointerMove={onMove}
      className={`group/spot relative flex min-w-0 flex-col overflow-hidden transition-[border-color] duration-300 hover:border-white/[0.13] ${PANEL} ${className}`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover/spot:opacity-100"
        style={{
          background: 'radial-gradient(420px circle at var(--x, 50%) var(--y, 0%), rgba(167,139,250,0.08), transparent 60%)',
        }}
      />
      <div className="relative flex h-full flex-col">{children}</div>
    </Component>
  )
}
