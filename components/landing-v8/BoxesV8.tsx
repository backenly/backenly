'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  Activity,
  Archive,
  ArrowRight,
  Code2,
  Database,
  FlaskConical,
  Gauge,
  GitBranch,
  Github,
  History,
  LineChart,
  List,
  Lock,
  Map,
  RotateCcw,
  Ruler,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Split,
  Undo2,
  Users,
  Wrench,
} from 'lucide-react'
import { ROUTES } from '@/components/site/SiteShell'
import { TEXT_LINK } from './tokens'
import { BOX_BODY, BOX_TITLE, Box, BoxHead, Cells, Tag } from './Box'
import { RegionsSunline } from './RegionsSunline'
import { RepairChart } from './autonomy/RepairChart'
import { HistoryRecord } from './autonomy/HistoryRecord'
import { RestructurePlan } from './autonomy/RestructurePlan'
import { AuthDiagram, DatabaseDiagram, FunctionsDiagram, RealtimeDiagram, RestApiDiagram, StorageDiagram } from './diagrams'

const databaseFacts = ['Standard PostgreSQL', 'pgvector', 'Direct connection strings', 'pg_dump exports']

/*
 * Everything a production backend needs (founders, 2026-11-15: "old one in
 * backenly.com is better ... make it more apt and professional to current
 * landing page"). The live bento, kept: its cells, copy, fact chips and line
 * figures (./diagrams), set 2+1 / 1+1+1 / 1+2 so the grid has a rhythm. Moved
 * into this page's box: one frame, cells split by hairlines, 10px corners, the
 * page's type. Fixed on the way: the token shows the claims sign-in really
 * issues, Realtime lights once instead of blinking forever, Storage's link
 * meter runs on hover, Functions never overflows a narrow cell, tags are
 * lowercase.
 */
const PRIMITIVES = {
  database: { title: 'Postgres, a schema of your own', body: 'Tables, relations, indexes, constraints and pgvector, in a PostgreSQL schema per project. Isolation is a Postgres grant, not a WHERE clause.' },
  auth: { title: 'Auth', body: 'Sign-up, OAuth, magic links and verification emails for your users. Each project signs with its own secret.', Diagram: AuthDiagram },
  rest: { title: 'REST APIs', body: 'PostgREST serves every table from the catalog: filters, ordering, pagination, embedded resources, OpenAPI.', Diagram: RestApiDiagram },
  realtime: { title: 'Realtime', body: 'Inserts, updates and deletes as they land, plus presence and broadcast. Delivered over SSE, with no socket server to run.', Diagram: RealtimeDiagram },
  storage: { title: 'Storage', body: 'Buckets, uploads, metadata and expiring signed URLs, on local disk or any S3-compatible provider.', Diagram: StorageDiagram },
  functions: { title: 'Functions and triggers', body: 'Run code on insert, update, delete or signup, or on a cron schedule. Webhooks and rate limits included.', Diagram: FunctionsDiagram },
}

const ALSO_BUILT_IN = [
  { icon: ShieldCheck, title: 'Row-level security by description', body: 'Say who can read and write what. Backenly writes and enforces the Postgres policies.' },
  { icon: GitBranch, title: 'Branches for risky work', body: 'Clone the backend, let your agent experiment, review the diff, merge what works.' },
  { icon: Users, title: 'Teams and organizations', body: 'Invite teammates with roles. Every actor writes to the same change ledger.' },
]

/** One bento cell: the box's own ground, split from its neighbours by the grid's hairlines. `group` lets a figure answer hover. */
function Bento({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`group relative flex min-w-0 flex-col overflow-hidden bg-[#0b0c0f] p-[24px] sm:p-[28px] lg:p-[32px] ${className}`}>{children}</div>
}

const BENTO_TITLE = 'text-[16px] font-medium tracking-[-0.012em] text-white'
const BENTO_BODY = 'mt-[10px] text-[15px] leading-[1.6] text-zinc-400 [text-wrap:pretty]'

function PrimitiveCell({ p, className = '' }: { p: { title: string; body: string; Diagram: () => JSX.Element }; className?: string }) {
  return (
    <Bento className={className}>
      <h3 className={BENTO_TITLE}>{p.title}</h3>
      {/* A three-line floor, so a row's figures share one baseline. */}
      <p className={`${BENTO_BODY} md:min-h-[72px]`}>{p.body}</p>
      <div className="mt-auto">
        <p.Diagram />
      </div>
    </Bento>
  )
}

export function PlatformBox() {
  const { database, auth, rest, realtime, storage, functions } = PRIMITIVES
  return (
    <Box id="platform-heading" light={{ art: 'a' }}>
      <div className="p-[24px] sm:p-[32px] lg:p-[48px]">
        <div className="grid gap-[20px] lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:items-end lg:gap-[48px]">
          <div>
            <Tag icon={Database}>Platform</Tag>
            <h2 id="platform-heading" className={`mt-[24px] ${BOX_TITLE}`}>
              Everything a production backend needs
            </h2>
          </div>
          <p className={BOX_BODY}>Wired to one Postgres schema per project from the first table.</p>
        </div>
      </div>
      <div className="grid gap-px border-t border-white/[0.10] bg-white/[0.08] md:grid-cols-2 lg:grid-cols-3">
        {/* The lead: the database, twice as wide, words and drawing side by side. */}
        <Bento className="md:col-span-2">
          <div className="grid h-full gap-[8px] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-end lg:gap-[32px]">
            <div className="flex h-full flex-col">
              <h3 className={BENTO_TITLE}>{database.title}</h3>
              <p className={`${BENTO_BODY} max-w-[46ch]`}>{database.body}</p>
              <ul className="mt-auto flex flex-wrap gap-[8px] pt-[24px]">
                {databaseFacts.map((fact) => (
                  <li key={fact} className="rounded-[6px] border border-white/[0.08] bg-white/[0.03] px-[10px] py-[4px] text-[13px] text-zinc-300">
                    {fact}
                  </li>
                ))}
              </ul>
            </div>
            <DatabaseDiagram />
          </div>
        </Bento>
        <PrimitiveCell p={auth} />
        <PrimitiveCell p={rest} />
        <PrimitiveCell p={realtime} />
        <PrimitiveCell p={storage} />
        <PrimitiveCell p={functions} className="md:col-span-2 lg:col-span-1" />
        <Bento className="md:col-span-2">
          <div className="flex items-baseline justify-between gap-[24px]">
            <h3 className={BENTO_TITLE}>Also built in</h3>
            <Link href={ROUTES.features} className={TEXT_LINK}>
              Every feature
              <ArrowRight aria-hidden className="h-[15px] w-[15px] text-violet-300 transition-transform duration-150 [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-[3px]" />
            </Link>
          </div>
          <div className="mt-[24px] grid gap-x-[32px] gap-y-[28px] sm:grid-cols-3">
            {ALSO_BUILT_IN.map((item) => (
              <div key={item.title} className="border-t border-white/[0.08] pt-[20px]">
                <item.icon aria-hidden className="h-[18px] w-[18px] text-violet-300" strokeWidth={1.75} />
                <h4 className="mt-[16px] text-[15px] font-medium tracking-[-0.01em] text-white">{item.title}</h4>
                <p className="mt-[8px] text-[14px] leading-[1.65] text-zinc-400 [text-wrap:pretty]">{item.body}</p>
              </div>
            ))}
          </div>
        </Bento>
      </div>
    </Box>
  )
}

export function RepairBox() {
  return (
    <Box id="heal-heading" light={{ art: 'c' }}>
      <BoxHead
        id="heal-heading"
        layout="stacked"
        tag={{ icon: Activity, label: 'Autonomy' }}
        title="Your backend repairs itself"
        body="Backenly checks it every minute, fixes what is safe on its own and holds risky changes for you."
        visual={<RepairChart />}
      />
      {/* Approval lives in the next box and undo in History, so this box says neither (designers' review, 2026-11-15). */}
      <Cells
        items={[
          { icon: Gauge, title: '27 checks', body: 'Indexes, constraints, policies and errors, checked on every project every minute.', href: '/docs/autonomy' },
          { icon: Wrench, title: 'Fixed, then re-checked', body: 'Safe fixes ship on their own; the check that found the problem runs again.', href: '/docs/autonomy' },
          { icon: ShieldCheck, title: 'Risky changes wait', body: "Destructive, auth and irreversible changes wait for you, including your agent's.", href: '/docs/autonomy' },
          { icon: SlidersHorizontal, title: 'You set how far', body: 'Autopilot, Review-only or off, for each project.', href: '/docs/autonomy' },
        ]}
      />
    </Box>
  )
}

export function RestructureBox() {
  return (
    <Box id="restructuring-heading" light={{ art: 'a', flip: true }}>
      <BoxHead
        id="restructuring-heading"
        layout="stacked"
        tag={{ icon: Split, label: 'Restructuring' }}
        title="Your schema restructures itself"
        body="When a table starts doing two jobs, Backenly separates them once you approve. Your apps keep working."
        visual={<RestructurePlan />}
      />
      <Cells
        items={[
          { icon: Ruler, title: 'Measured first', body: 'It acts on a measured cost, like changes that keep locking a table, never on size alone.', href: '/features/self-restructuring-schema', link: 'How it works' },
          { icon: FlaskConical, title: 'Rehearsed on a copy', body: 'The whole change runs on a copy of the real rows, then rolls back.', href: '/features/self-restructuring-schema', link: 'How it works' },
          { icon: Code2, title: 'Apps keep working', body: 'Old and new code both work; the old columns stay until you remove them.', href: '/features/self-restructuring-schema', link: 'How it works' },
          { icon: LineChart, title: 'Judged afterwards', body: 'It measures the result and says plainly whether it helped.', href: '/features/self-restructuring-schema', link: 'How it works' },
        ]}
      />
    </Box>
  )
}

export function HistoryBox() {
  return (
    <Box id="history-heading" light={{ art: 'b' }}>
      <BoxHead
        id="history-heading"
        layout="stacked"
        tag={{ icon: History, label: 'History' }}
        title="Every change on the record"
        body="Your agent, Backenly and your team write to one history. Restore one change without rolling back the rest."
        visual={<HistoryRecord />}
      />
      <Cells
        items={[
          { icon: List, title: 'One history', body: 'Database, auth, storage, functions, webhooks, environment and keys: one entry per change, with who made it.', href: '/features/undo-and-rollback', link: 'How it works' },
          { icon: Archive, title: 'Kept, not deleted', body: 'Dropped tables and columns are kept, so a restore brings them back: 7 days on Free, 30 on Pro.', href: '/features/undo-and-rollback', link: 'How it works' },
          { icon: Undo2, title: 'Restore one change', body: 'Checked before it runs. If it would remove or overwrite newer data, a person approves first.', href: '/features/undo-and-rollback', link: 'How it works' },
          { icon: RotateCcw, title: 'Restore to a point', body: 'Undo everything after a change, checked as a whole before any step runs. Agents can ask; only a person decides.', href: '/features/undo-and-rollback', link: 'How it works' },
        ]}
      />
    </Box>
  )
}

export function ScaleBox() {
  return (
    <Box id="scale-heading" light={{ art: 'c', flip: true }}>
      <BoxHead
        id="scale-heading"
        layout="stacked"
        tag={{ icon: Server, label: 'Infrastructure' }}
        title="Five regions, every project isolated"
        body="Run each project in Oregon, Virginia, Frankfurt, Mumbai or Singapore, with its own Postgres schema, signing secret and scoped agent keys."
        extra={
          <Link
            href={ROUTES.github}
            target="_blank"
            rel="noopener noreferrer"
            className="group mt-[18px] inline-flex items-center gap-[8px] rounded-[3px] text-[15px] font-medium text-zinc-100 transition-colors duration-150 [@media(hover:hover)_and_(pointer:fine)]:hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            Read the code on GitHub
            <ArrowRight aria-hidden className="h-[15px] w-[15px] text-violet-300 transition-transform duration-150 [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-[3px]" />
            <span className="sr-only"> (opens in a new tab)</span>
          </Link>
        }
        visual={
          <div className="overflow-hidden rounded-[8px] border border-white/[0.07] bg-[#0a0a0d]">
            <RegionsSunline />
          </div>
        }
      />
      <Cells
        items={[
          { icon: Lock, title: 'Isolated by Postgres', body: 'Each project is its own schema. Isolation is a Postgres grant, not a WHERE clause.', href: '/docs/database' },
          { icon: Map, title: 'A stack per region', body: 'Each region runs its own database, API and file storage. You choose one per project.' },
          { icon: ShieldCheck, title: 'Scoped access', body: "An agent's key can request a destructive change, never approve one.", href: '/docs/autonomy' },
          { icon: Github, title: 'Open source', body: 'Apache-2.0. Read every line, or run it on your own servers.', href: ROUTES.github, link: 'View on GitHub' },
        ]}
      />
    </Box>
  )
}
