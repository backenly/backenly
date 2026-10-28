import type { ReactNode } from 'react'

/**
 * Formerly the landing page's quiet rise for every block below the hero. It
 * is now a plain element, because the landing dropped section entrances
 * (Impeccable polish, 2026-10-14): one identical fade-up on every section is a
 * generated-page tell, it ran framer's JavaScript on every scrolled block, and
 * the page reads faster with the content simply there. The props stay so the
 * subpages that wrap their blocks in it keep compiling; `delay` is ignored.
 */
export function Reveal({
  children,
  className = '',
  as: Component = 'div',
}: {
  children: ReactNode
  className?: string
  delay?: number
  /** The element to render. A list item or section keeps its semantics. */
  as?: 'div' | 'li' | 'section' | 'article'
}) {
  return <Component className={`min-w-0 ${className}`.trim()}>{children}</Component>
}
