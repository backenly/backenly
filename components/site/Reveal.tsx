'use client'

import type { ReactNode } from 'react'
import { motion, type Variants } from 'framer-motion'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'

/**
 * The landing page's quiet rise, for any block below the hero.
 *
 * One motion, used everywhere, so the site has one way of arriving rather than
 * a different entrance per section. It plays once, when the block is first
 * 15% on screen, and reduced-motion visitors get the resting state.
 */
const EASE_OUT = [0.16, 1, 0.3, 1] as const

const rise: Variants = {
  hidden: { opacity: 0, y: 22 },
  visible: { opacity: 1, y: 0 },
}

export function Reveal({
  children,
  className = '',
  delay = 0,
  as = 'div',
}: {
  children: ReactNode
  className?: string
  delay?: number
  /** The element to render. A list item or section keeps its semantics. */
  as?: 'div' | 'li' | 'section' | 'article'
}) {
  const quiet = useSettledReducedMotion()
  const Component = motion[as]

  return (
    <Component
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.15, margin: '0px 0px -8% 0px' }}
      variants={rise}
      transition={{ duration: quiet ? 0 : 0.9, delay: quiet ? 0 : delay, ease: EASE_OUT }}
      className={`min-w-0 ${className}`.trim()}
    >
      {children}
    </Component>
  )
}
