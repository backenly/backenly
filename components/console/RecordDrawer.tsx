'use client'

/**
 * RecordDrawer: one record from a list you keep scanning (a table row, a
 * user, a file, a realtime event, a History change), opened beside the list
 * instead of over it (project decision 6).
 *
 *   ┌ list stays visible and usable ┐┌ movies · Past Lives      ↑ ↓ × ┐
 *   │ ● Past Lives            2024  ││ id   m0000001-4c1e…      Copy  │
 *   │ ● Aftersun              2022  ││ title  Past Lives               │
 *   └───────────────────────────────┘└─────────────── [Cancel] [Save] ┘
 *
 * - 420-480px on the right of the canvas, non-modal: the list behind it keeps
 *   working, and clicking another row shows that record. On a phone it is a
 *   full-height sheet, and modal, since nothing behind it is visible.
 * - ↑ / ↓ move to the previous / next record while focus is in the drawer
 *   (never while typing in a field); Esc closes it (in a field, Esc first
 *   leaves the field). A dialog or menu opened from the drawer keeps its keys.
 * - Focus moves to the record's title when the drawer opens and returns to
 *   the row that opened it when it closes. Moving between records is
 *   announced to screen readers.
 * - The open record lives in the URL (useRecordParam), so it can be linked
 *   and survives a reload: ?row=, ?user=, ?file=, ?change=.
 *
 *   const [rowId, openRow, closeRow] = useRecordParam('row')
 *   const nav = recordNav(rows, (r) => r.id, rowId, openRow)
 *   <RecordDrawer open={!!nav.item} onClose={closeRow} title={…} label={…}
 *     onPrev={nav.onPrev} onNext={nav.onNext} position={nav.position} footer={…}>…</RecordDrawer>
 */

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { motion, useReducedMotion } from 'framer-motion'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { IconButton, Skeleton } from '@/components/inspector/kit'
import { EDGE, PLATE, RULE } from './tokens'

// ─── URL ─────────────────────────────────────────────────────────────────────

/**
 * The open record as a URL parameter: [id or null, open(id), close()].
 *
 * The open record is held here and follows each move at once; the URL is
 * written with history.replaceState, which Next's router picks up without a
 * round trip to the server. Replacing rather than pushing means ↑/↓ through
 * fifty records leaves no fifty steps for Back. A URL this hook did not write
 * (a link to ?row=…, a reload) is followed.
 */
export function useRecordParam(param: string): [string | null, (id: string) => void, () => void] {
  const search = useSearchParams()
  const fromUrl = search?.get(param) ?? null
  const [current, setCurrent] = useState<string | null>(fromUrl)
  const [seen, setSeen] = useState<string | null>(fromUrl)
  // What this hook wrote, so the router catching up with an earlier write is
  // not mistaken for a new link and does not pull the drawer back a record.
  const [written, setWritten] = useState<ReadonlyArray<string | null>>([])
  if (fromUrl !== seen) {
    setSeen(fromUrl)
    if (!written.includes(fromUrl) && fromUrl !== current) setCurrent(fromUrl)
  }
  const write = useCallback(
    (id: string | null) => {
      setCurrent(id)
      setWritten((w) => [...w.slice(-31), id])
      if (typeof window === 'undefined') return
      const url = new URL(window.location.href)
      if (id === null) url.searchParams.delete(param)
      else url.searchParams.set(param, id)
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    },
    [param],
  )
  const open = useCallback((id: string) => write(id), [write])
  const close = useCallback(() => write(null), [write])
  return [current, open, close]
}

/**
 * Where the open record sits in the list the drawer moves through, and the
 * moves it has. `item` is null when the id is not in the list (yet).
 */
export function recordNav<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  current: string | null,
  open: (id: string) => void,
): { item: T | null; index: number; onPrev: (() => void) | null; onNext: (() => void) | null; position?: { index: number; total: number } } {
  const index = current === null ? -1 : items.findIndex((t) => idOf(t) === current)
  if (index < 0) return { item: null, index, onPrev: null, onNext: null }
  return {
    item: items[index],
    index,
    onPrev: index > 0 ? () => open(idOf(items[index - 1])) : null,
    onNext: index < items.length - 1 ? () => open(idOf(items[index + 1])) : null,
    position: { index, total: items.length },
  }
}

// ─── Phone ───────────────────────────────────────────────────────────────────

const PHONE = '(max-width: 767px)'

function subscribePhone(onChange: () => void) {
  const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE) : null
  mq?.addEventListener('change', onChange)
  return () => mq?.removeEventListener('change', onChange)
}
const phoneNow = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE).matches : false)
const phoneOnServer = () => false

function useIsPhone(): boolean {
  return useSyncExternalStore(subscribePhone, phoneNow, phoneOnServer)
}

// ─── Drawer ──────────────────────────────────────────────────────────────────

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
/** Where arrow keys already mean something to the control that has focus. */
const OWNS_ARROWS = '[role="radiogroup"], [role="tablist"], [role="slider"], [role="spinbutton"], [role="combobox"], [role="listbox"], [role="grid"], [role="tree"], [role="menu"]'

export interface RecordDrawerProps {
  open: boolean
  onClose: () => void
  /** The record's name: a row's key, a user's email, a file's name. */
  title: ReactNode
  /** The title in plain words, announced when ↑/↓ moves to another record. Defaults to the title when it is text. */
  label?: string
  /** One line under the title (an id, a path). */
  subtitle?: ReactNode
  /** Facts under the title (<Facts>/<Fact> from components/autonomy/rows). */
  facts?: ReactNode
  /** The previous / next record; null or absent at the ends of the list. */
  onPrev?: (() => void) | null
  onNext?: (() => void) | null
  /** "3 of 50": the record's place in the list (0-based index). */
  position?: { index: number; total: number }
  /** Actions for the record, at the foot (Delete on the left, Save on the right). */
  footer?: ReactNode
  children?: ReactNode
  /** The record is still being read: placeholders in the body. */
  loading?: boolean
  className?: string
}

export function RecordDrawer({
  open,
  onClose,
  title,
  label,
  subtitle,
  facts,
  onPrev,
  onNext,
  position,
  footer,
  children,
  loading = false,
  className = '',
}: RecordDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const phone = useIsPhone()
  const reduce = useReducedMotion()
  const spoken = label ?? (typeof title === 'string' ? title : '')
  const [announcement, setAnnouncement] = useState('')

  // The latest handlers, read by the key listener without re-attaching it.
  const handlers = useRef({ onClose, onPrev, onNext })
  useEffect(() => {
    handlers.current = { onClose, onPrev, onNext }
  }, [onClose, onPrev, onNext])

  // Focus in when it opens; back to whatever had it outside when it closes.
  useEffect(() => {
    if (!open) return
    const active = document.activeElement as HTMLElement | null
    openerRef.current = active && active !== document.body ? active : null
    headingRef.current?.focus({ preventScroll: true })
    // Clicking another row while it is open makes that row the one to return to.
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null
      if (t && panelRef.current && !panelRef.current.contains(t) && t !== document.body) openerRef.current = t
    }
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      // Opened from a link, there is no row to go back to: the page's main region takes focus.
      const back = openerRef.current?.isConnected ? openerRef.current : document.getElementById('console-main')
      back?.focus({ preventScroll: true })
    }
  }, [open])

  // A move to another record is said aloud; the first opening is said by the focus move.
  const lastSpoken = useRef<string | null>(null)
  useEffect(() => {
    if (!open) {
      lastSpoken.current = null
      return
    }
    if (lastSpoken.current !== null && spoken && spoken !== lastSpoken.current) setAnnouncement(spoken)
    lastSpoken.current = spoken
  }, [open, spoken])

  // Keys: Esc closes, ↑/↓ move.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const panel = panelRef.current
      if (!panel) return
      const target = e.target instanceof HTMLElement ? e.target : null
      // A dialog or a menu opened from the drawer handles its own keys.
      const modal = target?.closest('[aria-modal="true"]')
      if (modal && modal !== panel) return
      if (target?.closest('[role="menu"]')) return
      const inside = !!target && panel.contains(target)
      const onBody = !target || target === document.body || target === document.documentElement
      const editable = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      if (e.key === 'Escape') {
        if (editable) {
          // Esc in a field of the drawer leaves the field first, so a half-typed edit is not thrown away.
          if (inside) {
            e.preventDefault()
            headingRef.current?.focus({ preventScroll: true })
          }
          return
        }
        e.preventDefault()
        handlers.current.onClose()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      if (editable || !(inside || onBody) || target?.closest(OWNS_ARROWS)) return
      const move = e.key === 'ArrowDown' ? handlers.current.onNext : handlers.current.onPrev
      if (!move) return
      e.preventDefault()
      move()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // On a phone the sheet covers the page: it holds focus and the page stops scrolling.
  useEffect(() => {
    if (!open || !phone) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open, phone])

  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!phone || e.key !== 'Tab' || !panelRef.current) return
    const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  if (!open) return null

  const moves = onPrev !== undefined || onNext !== undefined
  const from = reduce ? { opacity: 0 } : phone ? { opacity: 0, y: 24 } : { opacity: 0, x: 16 }
  return (
    <motion.div
      ref={panelRef}
      role="dialog"
      aria-modal={phone ? true : undefined}
      aria-labelledby={titleId}
      data-record-drawer=""
      onKeyDown={trapTab}
      initial={from}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration: reduce ? 0.12 : 0.18, ease: [0.16, 1, 0.3, 1] }}
      className={`fixed inset-0 z-[45] flex flex-col ${PLATE} md:inset-auto md:bottom-[calc(var(--console-gap)+1px)] md:right-[calc(var(--console-gap)+1px)] md:top-[calc(var(--console-bar)+1px)] md:z-[25] md:w-[clamp(420px,36vw,480px)] md:rounded-r-[13px] md:border-l ${EDGE} md:shadow-[-28px_0_56px_-28px_rgba(0,0,0,0.85)] ${className}`}
    >
      <div className={`flex flex-shrink-0 items-start gap-[12px] border-b ${RULE} px-[16px] pb-[14px] pt-[max(14px,env(safe-area-inset-top))] sm:px-[20px]`}>
        <div className="min-w-0 flex-1 pt-[3px]">
          <h2
            ref={headingRef}
            id={titleId}
            tabIndex={-1}
            className="text-[15px] font-medium leading-[22px] tracking-[-0.012em] text-white [overflow-wrap:anywhere] focus:outline-none"
          >
            {title}
          </h2>
          {subtitle && <div className="mt-[2px] text-[12.5px] leading-[18px] text-faint [overflow-wrap:anywhere]">{subtitle}</div>}
          {facts && <div className="[&>*:first-child]:mt-[8px]">{facts}</div>}
        </div>
        <div className="flex flex-shrink-0 items-center gap-[2px]">
          {position && position.total > 1 && (
            <span className="mr-[4px] hidden whitespace-nowrap text-[12px] tabular-nums text-faint sm:inline">
              {position.index + 1} of {position.total}
            </span>
          )}
          {moves && (
            <>
              <IconButton icon={ChevronUp} label="Previous record" onClick={onPrev ?? undefined} disabled={!onPrev} />
              <IconButton icon={ChevronDown} label="Next record" onClick={onNext ?? undefined} disabled={!onNext} />
            </>
          )}
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[16px] py-[16px] sm:px-[20px]">
        {loading ? (
          <div aria-busy="true" aria-label="Loading" className="space-y-[14px]">
            {['64%', '82%', '48%', '70%'].map((w) => (
              <div key={w} className="space-y-[7px]">
                <Skeleton className="h-[10px] w-[72px]" />
                <span className="block" style={{ width: w }}>
                  <Skeleton className="h-[13px]" />
                </span>
              </div>
            ))}
          </div>
        ) : (
          children
        )}
      </div>

      {footer && (
        <div
          className={`flex flex-shrink-0 flex-wrap items-center justify-end gap-[8px] border-t ${RULE} px-[16px] pb-[max(12px,env(safe-area-inset-bottom))] pt-[12px] sm:px-[20px]`}
        >
          {footer}
        </div>
      )}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </motion.div>
  )
}
