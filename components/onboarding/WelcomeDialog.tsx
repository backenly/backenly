'use client'

/**
 * The first run: "Create your first project", asked once, large.
 *
 * Backenly first (the founder's call, 2026-11-16): a new account is not asked
 * to choose between importing and starting fresh, as if Backenly were a place
 * to move a Supabase project into. It is asked to create its project, with
 * what that project is and what happens next beside the form. Importing is
 * one quiet line at the bottom for the people who already run a backend.
 *
 *   ┌────────────────────────────────────────┬──────────────────────────────┐
 *   │ ▣                                    × │                              │
 *   │ Create your first project              │ Your coding agent builds it  │
 *   │ A Postgres database, auth, storage,    │ ✳ ◩ ◎ ⋀                      │
 *   │ functions and realtime in one project. │ $ npx @backenly/mcp-server … │
 *   │                                        │                              │
 *   │ Project name  [my-app              ]   │ Backenly keeps it healthy    │
 *   │ Region        (•) Mumbai  ap-south-1   │ ●─ Check     every minute    │
 *   │               Not open yet …           │ ●─ Find      what broke      │
 *   │                                        │ ●─ Fix       the safe ones   │
 *   │ [Create project]                       │ ●─ Re-check  every fix       │
 *   ├────────────────────────────────────────┴──────────────────────────────┤
 *   │ Already on Supabase, Firebase or Postgres?  Import it                 │
 *   └───────────────────────────────────────────────────────────────────────┘
 *
 * Closing it is an answer too (useStartChoice records it); New project offers
 * the same form, and the same quiet import line, from then on.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import Link from 'next/link'
import { AlertTriangle, X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { KitButton, KitInput, KitNote } from '@/components/inspector/kit'
import { EDGE, FLOAT, FOCUS, RAISE, RULE, R_CONTROL, WELL } from '@/components/console/tokens'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'
import { SourceMark } from '@/components/migrate/sources'
import { AgentMark } from '@/components/connect/AgentSetup'
import { RegionPicker } from '@/components/projects/NewProjectDialog'
import { SelfHealingLoop, type LoopStage } from '@/components/workspace/SelfHealingLoop'

const TITLE = 'Create your first project'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The loop as a sentence: what Backenly does to the project once it exists. */
const STORY: LoopStage[] = [
  { key: 'check', label: 'Check', value: 'every minute' },
  { key: 'find', label: 'Find', value: 'what broke' },
  { key: 'fix', label: 'Fix', value: 'the safe ones' },
  { key: 'recheck', label: 'Re-check', value: 'every fix' },
]

export function WelcomeDialog({
  open,
  creating,
  error,
  onCreate,
  onClose,
  importHref,
}: {
  open: boolean
  creating: boolean
  error?: string | null
  onCreate: (input: { name: string; region: CloudRegionId | null }) => void
  /** Closed without creating: still an answer. */
  onClose: () => void
  /** Where importing starts; null where it is not offered. */
  importHref?: string | null
}) {
  const [name, setName] = useState('')
  const [region, setRegion] = useState<CloudRegionId>(HOME_REGION)
  const titleId = useId()
  const nameId = useId()
  const regionLabelId = useId()
  const regionHintId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const restore = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])
  // One pass of the loop as the dialog opens, then one a minute, like the real loop.
  const [anchor] = useState(() => new Date().toISOString())

  useEffect(() => {
    if (!open) return
    restore.current = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    const t = setTimeout(() => panel.current?.querySelector<HTMLInputElement>('input:not([disabled])')?.focus(), 30)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(t)
      restore.current?.focus?.()
    }
  }, [open])

  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panel.current) return
    const nodes = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const submit = () => {
    const trimmed = name.trim()
    if (trimmed && !creating) onCreate({ name: trimmed, region: CLOUD_CONTROL_PLANE ? region : null })
  }

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-black/70"
            onClick={onClose}
          />
          <motion.div
            ref={panel}
            tabIndex={-1}
            onKeyDown={trapTab}
            initial={{ opacity: 0, y: 14, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.99 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className={`relative flex max-h-[100dvh] w-full max-w-[980px] flex-col overflow-hidden rounded-t-[16px] ${RAISE} ${FLOAT} focus:outline-none sm:max-h-[min(860px,calc(100dvh-48px))] sm:rounded-[16px]`}
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className={`absolute right-[14px] top-[14px] z-10 flex h-[30px] w-[30px] items-center justify-center ${R_CONTROL} text-zinc-500 transition-colors duration-150 hover:bg-white/[0.06] hover:text-zinc-100 ${FOCUS}`}
            >
              <X className="h-4 w-4" />
            </button>

            <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)]">
              {/* The form: what the project is, its name, where it runs. */}
              <form
                className="flex min-w-0 flex-col px-[24px] pb-[28px] pt-[28px] sm:px-[36px] sm:pt-[36px]"
                onSubmit={(e) => {
                  e.preventDefault()
                  submit()
                }}
              >
                <img src="/backenly-icon-hd.svg" alt="" aria-hidden width={32} height={32} className="flex-shrink-0" />
                <h2 id={titleId} className="mt-[22px] text-[28px] font-normal leading-[34px] tracking-[-0.03em] text-white [text-wrap:balance]">
                  {TITLE}
                </h2>
                <p className="mt-[8px] max-w-[440px] text-[14.5px] leading-[23px] text-zinc-400 [text-wrap:pretty]">
                  A Postgres database, auth, storage, functions and realtime, in one project your coding agent builds.
                </p>

                <div className="mt-[28px] space-y-[22px]">
                  <div>
                    <label htmlFor={nameId} className="block text-[13px] font-medium leading-[20px] text-zinc-100">
                      Project name
                    </label>
                    <KitInput
                      id={nameId}
                      className="mt-[8px]"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="my-app"
                      maxLength={100}
                      disabled={creating}
                      autoComplete="off"
                    />
                  </div>
                  {CLOUD_CONTROL_PLANE && (
                    <div>
                      <p id={regionLabelId} className="text-[13px] font-medium leading-[20px] text-zinc-100">
                        Region
                      </p>
                      <p id={regionHintId} className="mt-[2px] text-[12.5px] leading-[18px] text-faint">
                        Where its database and API run.
                      </p>
                      <div className="mt-[10px]">
                        <RegionPicker value={region} onChange={setRegion} disabled={creating} labelledBy={regionLabelId} describedBy={regionHintId} />
                      </div>
                    </div>
                  )}
                </div>

                {error && (
                  <div className="mt-[18px]">
                    <KitNote icon={AlertTriangle} tone="danger">
                      {error}
                    </KitNote>
                  </div>
                )}

                <div className="mt-[28px]">
                  <KitButton type="submit" variant="primary" size="lg" disabled={!name.trim()} loading={creating}>
                    Create project
                  </KitButton>
                </div>
              </form>

              {/* What happens next, said by the product itself rather than a list of features. */}
              <aside
                aria-label="What happens next"
                className={`hidden min-w-0 flex-col justify-center gap-[34px] border-l ${RULE} ${WELL} px-[32px] py-[40px] md:flex`}
              >
                <div>
                  <p className="text-[13.5px] font-medium leading-[21px] text-zinc-100">Your coding agent builds it</p>
                  <div className="mt-[12px] flex items-center gap-[14px] text-zinc-300" aria-label="Claude Code, Cursor, Codex, Antigravity and other MCP clients">
                    {['claude-code', 'cursor', 'codex', 'antigravity'].map((id) => (
                      <AgentMark key={id} id={id} size={17} />
                    ))}
                    <span className="text-[12.5px] leading-[18px] text-faint">and any MCP client</span>
                  </div>
                  <div className={`mt-[14px] overflow-x-auto ${R_CONTROL} border ${EDGE} bg-black/40 px-[14px] py-[11px] font-mono text-[12.5px] leading-[19px] text-zinc-300`}>
                    <span className="select-none text-zinc-600">$ </span>
                    npx @backenly/mcp-server init
                  </div>
                </div>

                <div>
                  <p className="text-[13.5px] font-medium leading-[21px] text-zinc-100">Backenly keeps it healthy</p>
                  <div className="mt-[16px]">
                    <SelfHealingLoop stages={STORY} lastPassAt={anchor} animate />
                  </div>
                </div>
              </aside>
            </div>

            {importHref && (
              <div className={`flex flex-wrap items-center gap-x-[12px] gap-y-[6px] border-t ${RULE} px-[24px] py-[14px] sm:px-[36px]`}>
                <span className="flex items-center gap-[8px] text-zinc-500" aria-hidden>
                  <SourceMark id="supabase" className="h-[13px] w-[13px]" />
                  <SourceMark id="firebase" className="h-[13px] w-[13px]" />
                  <SourceMark id="postgres" className="h-[13px] w-[13px]" />
                </span>
                <span className="text-[13px] leading-[20px] text-zinc-400">Already on Supabase, Firebase or Postgres?</span>
                <Link
                  href={importHref}
                  className={`rounded-[4px] text-[13px] font-medium leading-[20px] text-zinc-100 underline decoration-white/25 underline-offset-[3px] transition-colors hover:decoration-white/70 ${FOCUS}`}
                >
                  Import it
                </Link>
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
