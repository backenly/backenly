'use client'

import { useId, useState } from 'react'
import Link from 'next/link'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Plus } from 'lucide-react'
import { ROUTES } from '@/components/site/SiteShell'
import { BODY, HEADING, MEASURE } from '@/components/site/tokens'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import { CONTAINER, SECTION, TEXT_LINK, TITLE_TYPE } from './shared'

/* ─────────────────────────────────────────────────────────────
   FAQ (founders, 2026-10-14, with a screenshot of the live page's end:
   "use the 2nd image as reference and make it professional").

   The live FAQ (origin/main app/page.tsx, FaqSection): the same layout,
   accordion, questions and FAQPage structured data. The title takes the
   page's section-title type, so it reads like every other headline here.

   Answers are the live ones, corrected only where the code says otherwise:
     · Not every destructive call waits. The gated set is named instead
       (lib/mcp/approvals.ts, lib/ai/brain/tools.ts DESTRUCTIVE_TOOLS), and row
       writes are said to run as normal.
     · "Every applied change captures a rollback snapshot" is false: a table
       drop takes none, so the request row itself says "not auto-reversible".
     · Verification of a schema change is a read-back from the live database,
       not "real requests".
     · The self-healing fixes are rule-based, but the loop also writes model
       diagnoses, so "runs no model" is out.
     · Review Queue and change history are retired names: requests wait under
       "Waiting on you", activity is the agent journal, and rollback is
       restore points.
   "The person who built it" became "the people": Backenly has two founders.
───────────────────────────────────────────────────────────── */

const EASE_OUT = [0.16, 1, 0.3, 1] as const

const faqs = [
  {
    q: 'How does my coding agent connect?',
    a: 'One command installs the Backenly MCP server for Claude Code, Cursor, Codex, Cline, or any MCP host. The key is scoped and revocable from your project dashboard. There is also a CLI (npx @backenly/cli) for schema, generated types, CI diffs, logs, and read-only SQL, and a canonical agent skill at backenly.com/skill.md.',
  },
  {
    q: 'What happens when the agent tries something destructive?',
    a: 'Dropping or emptying a table, dropping a column, deleting files and revoking keys do not run. Each parks as an approval request under “Waiting on you” in your dashboard, with the impact laid out (how many live rows, whether the data is recoverable), and waits for a person on the project to decide. The agent’s key can request and poll, never approve. Ordinary row inserts, updates and deletes run as normal.',
  },
  {
    q: 'Is this real production infrastructure, or a prototyping tool?',
    a: 'Real infrastructure: an isolated PostgreSQL schema per project, live REST endpoints, auth with per-project secrets, file storage, and realtime streams. Schema changes are read back from the live database before they count as done, and the autonomy loop keeps monitoring and repairing the backend after you ship.',
  },
  {
    q: 'Is Backenly open source? Can I self-host?',
    a: 'Yes. The entire platform is open source under Apache-2.0, including the autonomy engine, and the SDK, CLI, MCP server, and agent skill are MIT. Self-host everything on your own infrastructure, with your own Postgres. Or use Backenly Cloud, where we run the infrastructure and handle backups and upgrades. It is the same codebase either way, so you can move between the two.',
  },
  {
    q: 'How is this different from Supabase or Firebase?',
    a: 'Like Supabase, Backenly is open source, built on real PostgreSQL, and self-hostable. The difference is who operates it. Supabase and Firebase hand you excellent parts and leave the assembly, configuration, and upkeep to you. You are the operator. Backenly does not just generate resources; it manages backend change safely. Changes are planned, destructive ones wait for your approval, schema changes are read back from the live database, and a resident autonomy loop keeps fixing the running backend, with receipts, when no one is at the keyboard.',
  },
  {
    q: 'Am I locked in?',
    a: 'No. The contract is standard REST plus a typed SDK, and the database is standard PostgreSQL. Every plan, including Free, gets direct read-only and read-write connection strings (psql, TablePlus, any BI tool) and pg_dump exports that restore on any Postgres: RDS, Neon, your own server. And because the platform itself is open source, the exit path includes running Backenly on your own servers. Everything leaves with you, anytime.',
  },
  {
    q: 'What does it cost?',
    a: 'Self-hosting is free under Apache-2.0: you bring the servers, and an AI provider key (Claude or OpenAI) only for the features that use a model, such as the natural-language build tools. The self-healing fixes themselves are rule-based. On Backenly Cloud, the Free plan is genuinely free, with no credit card, and includes a real, permanent backend plus the self-healing loop every minute. Pro is $25/month and raises capacity, not the self-healing, which is never capped on any plan; Enterprise is custom. Driving the backend from your own coding agent through the typed MCP tools is never metered as AI, and autonomy is included on every Cloud tier.',
  },
  {
    q: 'If my agent does the building, what is the dashboard for?',
    a: 'Oversight. The dashboard is where you inspect every table, user, file, and function; approve or reject destructive requests under “Waiting on you”; read the agent journal and autonomy receipts; manage keys, teams, and branches; and restore earlier versions from restore points. Your agent operates; you stay in command.',
  },
]

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faqs.map((faq) => ({
    '@type': 'Question',
    name: faq.q,
    acceptedAnswer: { '@type': 'Answer', text: faq.a },
  })),
}

export function FaqV7() {
  const [openIndex, setOpenIndex] = useState<number | null>(0)

  return (
    // font-light: the live page's body copy inherits SiteShell's weight 300.
    <section id="faq" aria-labelledby="faq-heading" className={`${SECTION} scroll-mt-[92px] font-light`}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <div className={`${CONTAINER} grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16`}>
        <div className="lg:sticky lg:top-28 lg:self-start">
          <h2 id="faq-heading" className={`max-w-[14ch] [text-wrap:balance] ${TITLE_TYPE}`}>
            Questions before you trust us with production
          </h2>
          <p className="mt-5 max-w-[36ch] text-[15px] leading-[1.7] text-zinc-400">
            Anything else, ask the people who built it.
          </p>
          <div className="mt-7 flex flex-wrap gap-x-6 gap-y-3">
            <Link href={ROUTES.docs} className={TEXT_LINK}>
              Read the docs
              <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </Link>
            <a href={ROUTES.founder} target="_blank" rel="noopener noreferrer" className={TEXT_LINK}>
              Book 30 minutes
              <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </a>
          </div>
        </div>

        <div className="border-t border-white/[0.08]">
          {faqs.map((faq, index) => (
            <FaqItem
              key={faq.q}
              faq={faq}
              open={openIndex === index}
              onToggle={() => setOpenIndex(openIndex === index ? null : index)}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function FaqItem({
  faq,
  open,
  onToggle,
}: {
  faq: (typeof faqs)[number]
  open: boolean
  onToggle: () => void
}) {
  const panelId = useId()
  const quiet = useSettledReducedMotion()

  return (
    <div className="border-b border-white/[0.08]">
      <h3>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panelId}
          className="group flex w-full items-center justify-between gap-6 py-6 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300/70 md:py-7"
        >
          <span
            className={`min-w-0 text-[16px] transition-colors duration-200 md:text-[18px] ${HEADING} ${
              open ? 'text-white' : 'text-zinc-300 group-hover:text-white'
            }`}
          >
            {faq.q}
          </span>
          <span
            aria-hidden
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-[transform,border-color,background-color] duration-300 ${
              open ? 'rotate-45 border-white/25 bg-white/[0.06]' : 'border-white/[0.10] group-hover:border-white/25'
            }`}
          >
            <Plus className="h-3.5 w-3.5 text-zinc-300" />
          </span>
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: quiet ? 0 : 0.32, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <p className={`${MEASURE} pb-7 pr-12 ${BODY} text-zinc-400 [text-wrap:pretty]`}>{faq.a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
