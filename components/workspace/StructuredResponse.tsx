'use client'

import React from 'react'
import { motion } from 'framer-motion'
import {
  parseVerificationFence,
  stripVerificationFence,
  type VerificationEvidencePayload,
} from '@/lib/ai/verification-evidence'

interface TableInfo {
  name: string
  fields: string[]
  description?: string
}

interface StructuredResponseProps {
  content: string
}

/**
 * Renders inline markdown segments:
 *   `code`      → styled <code> element (no backticks shown)
 *   **bold**    → <strong>
 *   *italic*    → <em>
 *   plain       → text node
 *
 * The **bold** matcher must come BEFORE the *italic* matcher in the regex
 * alternation so `**foo**` is consumed as one bold span rather than two
 * orphan italics. Single-asterisk italic also requires the closing star to
 * NOT be followed by another star (negative lookahead) so it doesn't eat the
 * second pair of a bold span.
 */
function renderInline(text: string): React.ReactNode {
  // Order matters: code, bold, italic. Italic uses a negative-lookahead so
  // it doesn't swallow the inner of `**bold**`.
  const segments = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*(?!\*)[^*\n]+\*(?!\*))/g)
  if (segments.length === 1) return text

  return (
    <>
      {segments.map((seg, i) => {
        if (!seg) return null
        if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) {
          return (
            <code
              key={i}
              className="px-1.5 py-0.5 bg-white/[0.04] text-zinc-300 rounded text-[12px] font-mono border border-white/[0.06] align-middle"
            >
              {seg.slice(1, -1)}
            </code>
          )
        }
        if (seg.startsWith('**') && seg.endsWith('**') && seg.length > 4) {
          return (
            <strong key={i} className="font-semibold text-white">
              {seg.slice(2, -2)}
            </strong>
          )
        }
        if (seg.startsWith('*') && seg.endsWith('*') && seg.length > 2) {
          return (
            <em key={i} className="italic text-zinc-200">
              {seg.slice(1, -1)}
            </em>
          )
        }
        return seg
      })}
    </>
  )
}

export function StructuredResponse({ content }: StructuredResponseProps) {
  const lines = content.split('\n')

  const hasStructure = lines.some(line =>
    line.includes('Tables') ||
    line.includes('Relationships') ||
    line.includes('Fields:') ||
    line.includes('→')
  )

  if (!hasStructure) {
    return (
      <div className="text-[13px] text-gray-200 whitespace-pre-wrap leading-[1.72] tracking-[-0.01em]">
        {content}
      </div>
    )
  }

  const sections: Array<{ type: 'header' | 'table' | 'relationship' | 'divider' | 'text'; content: string }> = []
  let currentTable: TableInfo | null = null

  lines.forEach((line) => {
    const trimmed = line.trim()

    if (trimmed.match(/^(Backend Overview|Tables|Relationships|APIs|Authentication)/i)) {
      sections.push({ type: 'header', content: trimmed })
      return
    }

    if (trimmed.match(/^[-─]+$/)) {
      sections.push({ type: 'divider', content: '' })
      return
    }

    if (trimmed.match(/^Fields:/i)) {
      const fields = trimmed.replace(/^Fields:/i, '').split(',').map(f => f.trim()).filter(Boolean)
      if (currentTable) {
        currentTable.fields = fields
        sections.push({ type: 'table', content: JSON.stringify(currentTable) })
        currentTable = null
      }
      return
    }

    if (trimmed.includes('→')) {
      sections.push({ type: 'relationship', content: trimmed })
      return
    }

    if (trimmed && !trimmed.includes(':') && !trimmed.includes('→')) {
      currentTable = { name: trimmed, fields: [] }
      return
    }

    if (trimmed) {
      sections.push({ type: 'text', content: trimmed })
    }
  })

  return (
    <div className="space-y-3">
      {sections.map((section, idx) => {
        switch (section.type) {
          case 'header':
            return (
              <motion.h3
                key={idx}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mt-4 first:mt-0"
              >
                {section.content}
              </motion.h3>
            )

          case 'divider':
            return <div key={idx} className="border-b border-slate-800/60" />

          case 'table':
            try {
              const table: TableInfo = JSON.parse(section.content)
              return (
                <motion.div
                  key={idx}
                  initial={{ opacity: 0, x: -5 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="pl-3 border-l-2 border-slate-700/60"
                >
                  <p className="text-sm font-semibold text-gray-200">{table.name}</p>
                  {table.fields.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {table.fields.map((field, fidx) => (
                        <span
                          key={fidx}
                          className="text-[11px] px-1.5 py-0.5 bg-slate-800/70 text-slate-400 rounded border border-slate-700/40 font-mono"
                        >
                          {field}
                        </span>
                      ))}
                    </div>
                  )}
                </motion.div>
              )
            } catch {
              return null
            }

          case 'relationship':
            return (
              <motion.div
                key={idx}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-2 text-sm font-mono"
              >
                <span className="text-slate-400">{section.content.split('→')[0]?.trim()}</span>
                <span className="text-slate-600">→</span>
                <span className="text-slate-400">{section.content.split('→')[1]?.trim()}</span>
              </motion.div>
            )

          case 'text':
            return (
              <p key={idx} className="text-[13.5px] text-gray-300 leading-[1.7]">
                {renderInline(section.content)}
              </p>
            )

          default:
            return null
        }
      })}
    </div>
  )
}

/**
 * Simple formatter for inline use — converts structured text to JSX.
 * Handles bullet lists, section headers, inline code/bold, and plain paragraphs.
 */
// Strips known filler openers from a line, returning the remainder (or null if the entire
// line was filler and should be dropped).
function stripFillerOpener(text: string): string | null {
  // Pure filler with nothing substantive after — drop entirely
  if (/^(Great!?|Absolutely!?|Sure!?|Of course!?|Certainly!?|Perfect!?|Sounds good!?|Happy to help!?)[\s!.]*$/i.test(text)) return null
  // Filler prefix followed by real content — strip just the prefix
  return text
    .replace(/^(Great!?\s*[—–-]?\s*|Absolutely!?\s*[—–-]?\s*|Sure!?\s*[—–-]?\s*|Of course!?\s*[—–-]?\s*|Certainly!?\s*[—–-]?\s*|Perfect!?\s*[—–-]?\s*)/i, '')
    .trim() || null
}

export function formatStructuredResponse(content: string): React.ReactNode {
  if (!content) return null

  // Verification evidence fence — extracted BEFORE line parsing so the JSON
  // payload never leaks into the prose renderer. Rendered as a dedicated
  // evidence card after the prose.
  const verificationPayload = parseVerificationFence(content)
  if (verificationPayload) content = stripVerificationFence(content)

  const rawLines = content.split('\n').filter(line => line.trim() !== '')

  // Strip filler openers from the very first line
  const lines: string[] = []
  let firstContentLine = true
  for (const line of rawLines) {
    if (firstContentLine) {
      const stripped = stripFillerOpener(line.trim())
      firstContentLine = false
      if (stripped) lines.push(stripped)
      // else: drop the filler-only line entirely
    } else {
      lines.push(line)
    }
  }

  const sections: Array<{
    type: 'section-header' | 'action-item' | 'code-block' | 'list' | 'table-group' | 'text'
    content: string
    items?: string[]
    title?: string
  }> = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // Markdown ## headers (e.g. "## Proposed Architecture") → section-header
    if (trimmed.match(/^#{1,3}\s+/)) {
      sections.push({ type: 'section-header', content: trimmed.replace(/^#{1,3}\s+/, '') })
      i++
      continue
    }

    // Bold label headers (e.g. "**Architecture:**") → section-header
    if (trimmed.match(/^\*\*[^*]+:\*\*$/)) {
      sections.push({ type: 'section-header', content: trimmed.replace(/\*\*/g, '').replace(/:$/, '') })
      i++
      continue
    }

    // Main section headers
    if (trimmed.match(/^(Tables|Relationships|APIs|Authentication|Backend Overview|Summary|Status|Next Steps|Changes Made|Your app can now|Architecture|Steps|Readiness)/i)) {
      sections.push({ type: 'section-header', content: trimmed })
      i++
      continue
    }

    // Bullet / numbered / em-dash list items — collect consecutive lines
    if (trimmed.match(/^[-•*—]\s+/) || trimmed.match(/^\d+\.\s+/)) {
      const listItems: string[] = []
      while (i < lines.length && lines[i].trim().match(/^[-•*—]\s+|^\d+\.\s+/)) {
        listItems.push(lines[i].trim().replace(/^[-•*—]\s+|^\d+\.\s+/, ''))
        i++
      }
      sections.push({ type: 'list', content: '', items: listItems })
      continue
    }

    // Fields line
    if (trimmed.match(/^Fields:/i)) {
      const fields = trimmed.replace(/^Fields:/i, '').split(',').map(f => f.trim()).filter(Boolean)
      sections.push({ type: 'table-group', content: 'fields', items: fields })
      i++
      continue
    }

    // Relationship arrows
    if (trimmed.includes('→')) {
      sections.push({ type: 'table-group', content: 'relationship', items: [trimmed] })
      i++
      continue
    }

    // Table names (single identifier word)
    if (trimmed && !trimmed.includes(':') && !trimmed.includes('→') && trimmed.match(/^[A-Za-z_][A-Za-z0-9_]*$/)) {
      sections.push({ type: 'table-group', content: 'table-name', items: [trimmed] })
      i++
      continue
    }

    // Action items
    if (trimmed.match(/^(Create|Update|Delete|Add|Remove|Configure|Enable|Disable|Generate)/i)) {
      sections.push({ type: 'action-item', content: trimmed })
      i++
      continue
    }

    // Default paragraph
    sections.push({ type: 'text', content: trimmed })
    i++
  }

  return (
    <div className="space-y-4">
      {sections.map((section, idx) => {
        switch (section.type) {
          case 'section-header':
            return (
              <motion.div
                key={idx}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mt-4 first:mt-0"
              >
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-gray-600">
                  {section.content}
                </h3>
              </motion.div>
            )

          case 'action-item':
            return (
              <motion.div
                key={idx}
                initial={{ opacity: 0, x: -5 }}
                animate={{ opacity: 1, x: 0 }}
                className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl border border-emerald-500/15 bg-emerald-500/[0.04]"
              >
                <svg className="w-3.5 h-3.5 text-emerald-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-[13px] text-gray-200 leading-[1.6]">
                  {renderInline(section.content)}
                </span>
              </motion.div>
            )

          case 'table-group':
            if (section.content === 'fields' && section.items) {
              return (
                <motion.div
                  key={idx}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-wrap gap-1.5"
                >
                  {section.items.map((field, fidx) => (
                    <span
                      key={fidx}
                      className="inline-flex items-center px-2 py-1 bg-blue-500/10 border border-blue-500/30 rounded text-[11px] font-mono text-blue-300"
                    >
                      {field}
                    </span>
                  ))}
                </motion.div>
              )
            } else if (section.content === 'relationship' && section.items) {
              const [from, to] = section.items[0]?.split('→').map(s => s.trim()) || ['', '']
              return (
                <motion.div
                  key={idx}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-gray-800/30 border border-gray-700/30"
                >
                  <span className="text-[12px] font-mono text-slate-200">{from}</span>
                  <span className="text-gray-600 text-xs">→</span>
                  <span className="text-[12px] font-mono text-slate-200">{to}</span>
                </motion.div>
              )
            } else if (section.content === 'table-name' && section.items) {
              return (
                <motion.div
                  key={idx}
                  initial={{ opacity: 0, x: -5 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="inline-block px-2.5 py-1 bg-slate-800/50 rounded border border-slate-700/50 text-[13px] font-semibold text-slate-200"
                >
                  {section.items[0]}
                </motion.div>
              )
            }
            return null

          case 'list':
            return (
              <motion.ul
                key={idx}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="space-y-2"
              >
                {section.items?.map((item, itemIdx) => (
                  <motion.li
                    key={itemIdx}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: itemIdx * 0.03 }}
                    className="flex items-start gap-2.5 text-[13px] text-gray-200 leading-[1.65]"
                  >
                    <span className="mt-[7px] w-[4px] h-[4px] rounded-full bg-gray-600 flex-shrink-0" />
                    <span>{renderInline(item)}</span>
                  </motion.li>
                ))}
              </motion.ul>
            )

          case 'text':
            return (
              <motion.p
                key={idx}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-[13px] text-gray-300 leading-[1.7] tracking-[-0.01em]"
              >
                {renderInline(section.content)}
              </motion.p>
            )

          default:
            return null
        }
      })}
      {verificationPayload && <VerificationEvidenceCard payload={verificationPayload} />}
    </div>
  )
}

// ─── Verification evidence card ───────────────────────────────────────────────
// Renders the behavioral verifier's real evidence: per check, the actual
// assertions that ran against the live runtime ("✓ Signup: test user created",
// "✓ User B correctly denied — 0 rows returned"). This is the "not a mock"
// proof — failed checks default open, passed checks expand on click.

function VerificationEvidenceCard({ payload }: { payload: VerificationEvidencePayload }) {
  const allPassed = payload.passed === payload.total && payload.total > 0
  const [open, setOpen] = React.useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {}
    for (const c of payload.checks) if (c.status === 'failed') initial[c.name] = true
    return initial
  })

  const ran = payload.checks.filter(c => c.status !== 'skipped')
  const skipped = payload.checks.filter(c => c.status === 'skipped')

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.015]"
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 border-b border-white/[0.05] px-3.5 py-2.5">
        <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ${allPassed ? 'bg-emerald-500/15' : 'bg-violet-500/15'}`}>
          <svg className={`h-3 w-3 ${allPassed ? 'text-emerald-400' : 'text-violet-300'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            {allPassed
              ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m0 3.75h.008M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />}
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400">
            Verified against the live runtime
          </p>
          <p className="mt-0.5 text-[10.5px] text-zinc-600">
            Real requests — signup, CRUD, cross-user isolation, live HTTP — not simulations
          </p>
        </div>
        <span className={`flex-shrink-0 font-mono text-[11.5px] font-medium tabular-nums ${allPassed ? 'text-emerald-400' : 'text-violet-300'}`}>
          {payload.passed}/{payload.total}
        </span>
        {payload.repaired > 0 && (
          <span className="flex-shrink-0 rounded-md border border-violet-400/20 bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] text-violet-300">
            {payload.repaired} auto-repaired
          </span>
        )}
      </div>

      {/* Check rows */}
      <div className="divide-y divide-white/[0.04]">
        {ran.map(check => {
          const isOpen = !!open[check.name]
          const hasEvidence = check.evidence.length > 0 || !!check.note
          return (
            <div key={check.name}>
              <button
                type="button"
                onClick={() => hasEvidence && setOpen(prev => ({ ...prev, [check.name]: !prev[check.name] }))}
                className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors ${hasEvidence ? 'hover:bg-white/[0.02]' : 'cursor-default'}`}
              >
                <span className={`h-[6px] w-[6px] flex-shrink-0 rounded-full ${check.status === 'passed' ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                <span className={`min-w-0 flex-1 truncate text-[12px] ${check.status === 'passed' ? 'text-zinc-300' : 'text-rose-300'}`}>
                  {check.name}
                </span>
                {hasEvidence && (
                  <svg
                    className={`h-3 w-3 flex-shrink-0 text-zinc-600 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                )}
              </button>
              {isOpen && hasEvidence && (
                <div className="space-y-1 bg-black/[0.18] px-3.5 py-2 pl-[30px]">
                  {check.evidence.map((line, i) => (
                    <p key={i} className="font-mono text-[10.5px] leading-4 text-zinc-500">
                      {line}
                    </p>
                  ))}
                  {check.note && (
                    <p className="font-mono text-[10.5px] leading-4 text-rose-400/80">
                      {check.note}
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {skipped.length > 0 && (
        <p className="border-t border-white/[0.04] px-3.5 py-1.5 text-[10px] text-zinc-700">
          Not applicable yet: {skipped.map(s => s.name).join(' · ')}
        </p>
      )}
    </motion.div>
  )
}
