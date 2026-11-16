'use client'

/**
 * A text button that opens a small panel under it: the SQL toolbar's Snippets
 * and History, and the grid's Filter. The kit's OverflowMenu is the ⋯ icon
 * only; these say what they hold. Escape or a click outside closes them, and
 * focus goes back to the button.
 */

import { useCallback, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, type LucideIcon } from 'lucide-react'
import { KitButton, MenuItem, MenuSeparator, useDismiss } from '@/components/inspector/kit'
import { FLOAT, RAISE } from '@/components/console/tokens'

export type TextMenuItem = { separator: true } | { label: string; onClick: () => void; danger?: boolean; title?: string; mono?: boolean }

/** The panel, placed under its button. */
function Panel({ align, width, children, role }: { align: 'left' | 'right'; width: string; children: ReactNode; role?: string }) {
  return (
    <motion.div
      role={role}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
      className={`absolute top-full z-40 mt-[6px] ${align === 'right' ? 'right-0' : 'left-0'} ${width} max-w-[calc(100vw-32px)] overflow-hidden rounded-[10px] ${RAISE} ${FLOAT}`}
    >
      {children}
    </motion.div>
  )
}

/** "Snippets ▾": a list of choices under a labelled button. */
export function TextMenu({
  label,
  items,
  icon,
  align = 'right',
  width = 'w-[280px]',
  empty,
}: {
  label: string
  items: readonly TextMenuItem[]
  icon?: LucideIcon
  align?: 'left' | 'right'
  width?: string
  /** Said inside the menu when there is nothing to choose. */
  empty?: string
}) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLDivElement>(null)
  const close = useCallback(() => {
    setOpen(false)
    button.current?.querySelector('button')?.focus()
  }, [])
  const ref = useDismiss(open, close)
  return (
    <div ref={ref} className="relative">
      <div ref={button}>
        <KitButton size="sm" variant="ghost" icon={icon} iconRight={ChevronDown} onClick={() => setOpen((o) => !o)} aria-label={label}>
          {label}
        </KitButton>
      </div>
      <AnimatePresence>
        {open && (
          <Panel align={align} width={width} role="menu">
            <div className="max-h-[320px] overflow-y-auto p-[4px]">
              {items.length === 0 && empty ? (
                <p className="px-[10px] py-[8px] text-[12.5px] leading-[18px] text-faint">{empty}</p>
              ) : (
                items.map((item, i) =>
                  'separator' in item ? (
                    <MenuSeparator key={`sep-${i}`} />
                  ) : (
                    <MenuItem
                      key={`${i}-${item.label}`}
                      danger={item.danger}
                      onClick={() => {
                        setOpen(false)
                        item.onClick()
                      }}
                    >
                      <span title={item.title} className={item.mono ? 'font-mono text-[12px]' : undefined}>
                        {item.label}
                      </span>
                    </MenuItem>
                  ),
                )
              )}
            </div>
          </Panel>
        )}
      </AnimatePresence>
    </div>
  )
}

/** A labelled button with a panel of its own (the grid's Filter). */
export function PopoverButton({
  label,
  icon,
  open,
  onOpenChange,
  children,
  align = 'right',
  width = 'w-[300px]',
  pressed,
}: {
  label: ReactNode
  icon?: LucideIcon
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  align?: 'left' | 'right'
  width?: string
  /** Something is applied: the button reads as on. */
  pressed?: boolean
}) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const ref = useDismiss(open, close)
  return (
    <div ref={ref} className="relative">
      <KitButton size="sm" variant={pressed ? 'secondary' : 'ghost'} icon={icon} onClick={() => onOpenChange(!open)}>
        {label}
      </KitButton>
      <AnimatePresence>
        {open && (
          <Panel align={align} width={width} role="dialog">
            {children}
          </Panel>
        )}
      </AnimatePresence>
    </div>
  )
}
