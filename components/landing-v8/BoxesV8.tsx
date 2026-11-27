'use client'

import type { ReactNode } from 'react'
import {
  Activity,
  Archive,
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
import { BOX_BODY, BOX_TITLE, Box, BoxHead, BoxLink, Cells, Tag } from './Box'
import { RegionsSunline } from './RegionsSunline'
import { RepairChart } from './autonomy/RepairChart'
import { HistoryRecord } from './autonomy/HistoryRecord'
import { RestructurePlan } from './autonomy/RestructurePlan'
import { AuthDiagram, DatabaseDiagram, FunctionsDiagram, RealtimeDiagram, RestApiDiagram, StorageDiagram } from './diagrams'

/*
 * The database's facts, set two by two under its sentence. "Direct connection strings" left on 2026-11-28: on Backenly
 * Cloud a project still in its region's shared database has no connection string (lib/services/direct-access.ts), while
 * SQL migrations are true for every project (apply_migration, lib/mcp/catalog.ts).
 */
const databaseFacts = ['Standard PostgreSQL', 'pgvector', 'SQL migrations', 'pg_dump exports']

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
 *
 * Review of 2026-11-27: a phone shows the cells' words without the figures,
 * which at phone width were four screens of drawings with labels too small to
 * read, and "Isolation is a Postgres grant" is said once, in Infrastructure's
 * "Isolated by Postgres".
 *
 * 2026-11-28 (founders: open with this grid, "make that grid and things more
 * professional instead of replacing it"), from three designers' proposals and
 * their review of each other, every claim checked in the code:
 *   - the hairlines are opaque, so the head's painted light no longer shows
 *     through some of them and not others
 *   - every figure is the page's one example project, movie reviews, in
 *     Backenly's real request shapes (./diagrams); the copy says only what is
 *     true on Cloud (event triggers and webhooks are Pro, app/pricing/page.tsx)
 *   - the database's chips sit under its sentence; Functions sits beside its
 *     words where it spans the box; "Also built in" meets its row's floor with
 *     zinc icons like every other cell; the one link moves under the head's
 *     sentence, as in the other boxes
 */
const PRIMITIVES = {
  database: { title: 'Postgres, a schema of your own', body: 'Tables, relations, indexes, constraints and pgvector, in a PostgreSQL schema per project.' },
  auth: {
    title: 'Auth',
    body: 'Passwords, magic links and Google, GitHub, Discord or Facebook sign-in, with verification emails. Each project signs with its own secret.',
    Diagram: AuthDiagram,
  },
  rest: { title: 'REST APIs', body: 'PostgREST serves your tables: filters, ordering, pagination, embedded rows and OpenAPI. Row\u2011level security decides each row.', Diagram: RestApiDiagram },
  realtime: {
    title: 'Realtime',
    body: 'Inserts, updates and deletes over SSE, sent only to clients allowed to read the row. Presence and broadcast too, no socket server to run.',
    Diagram: RealtimeDiagram,
  },
  storage: {
    title: 'Storage',
    body: 'Buckets with read and upload rules, expiring signed links and optional WebP conversion, on S3 or any S3\u2011compatible store.',
    Diagram: StorageDiagram,
  },
  functions: {
    title: 'Functions and triggers',
    body: 'Run code on a sign-up, a row change, an HTTPS call or a cron schedule, with every run logged. Event triggers and webhooks are on Pro.',
    Diagram: FunctionsDiagram,
  },
}

const ALSO_BUILT_IN = [
  { icon: ShieldCheck, title: 'Row-level security by description', body: 'Say \u201canyone reads reviews; only the author edits one.\u201d Backenly writes the policy and Postgres enforces it.' },
  { icon: GitBranch, title: 'Branches for risky work', body: 'A copy of the schema, empty or with production\u2019s rows, for your agent to try a change on. Merging waits for your approval.' },
  { icon: Users, title: 'Teams and organizations', body: 'Owner, admin, developer and viewer roles, with access per project on Pro.' },
]

/** One bento cell: the box's own ground, split from its neighbours by the grid's hairlines. `group` lets a figure answer hover. */
function Bento({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`group relative flex min-w-0 flex-col overflow-hidden bg-[#0b0c0f] p-[24px] sm:p-[28px] lg:p-[32px] ${className}`}>{children}</div>
}

const BENTO_TITLE = 'text-[16px] font-medium tracking-[-0.012em] text-white'
/** A measure for the cells' sentences, so a cell that spans the box never runs one 100-character line. */
const BENTO_BODY = 'mt-[10px] max-w-[46ch] text-[15px] leading-[1.6] text-zinc-400 [text-wrap:pretty]'

function PrimitiveCell({
  p,
  className = '',
  split = false,
}: {
  p: { title: string; body: string; Diagram: () => JSX.Element }
  className?: string
  /** Where the cell spans the whole box (md to lg), words and figure sit side by side, as the database's do (the figure a
      little wider, so its chips fit whole at 768); from xl it is one column again. */
  split?: boolean
}) {
  const words = (
    <>
      <h3 className={BENTO_TITLE}>{p.title}</h3>
      {/* A three-line floor, so a row's figures share one baseline. */}
      <p className={`${BENTO_BODY} md:min-h-[72px]`}>{p.body}</p>
    </>
  )
  const figure = (
    <div className="mt-auto hidden sm:block">
      <p.Diagram />
    </div>
  )
  return (
    <Bento className={className}>
      {split ? (
        <div className="flex flex-1 flex-col md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] md:items-end md:gap-x-[32px] xl:flex xl:items-stretch">
          <div className="md:self-start">{words}</div>
          {figure}
        </div>
      ) : (
        <>
          {words}
          {figure}
        </>
      )}
    </Bento>
  )
}

export function PlatformBox() {
  const { database, auth, rest, realtime, storage, functions } = PRIMITIVES
  return (
    <Box id="platform-heading" anchor="platform" light={{ art: 'a' }}>
      <div className="p-[24px] sm:p-[32px] lg:p-[48px]">
        <div className="grid gap-[20px] lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:items-end lg:gap-[48px]">
          <div>
            <Tag icon={Database}>Platform</Tag>
            <h2 id="platform-heading" className={`mt-[24px] ${BOX_TITLE}`}>
              Everything a production backend needs
            </h2>
          </div>
          <div>
            <p className={`${BOX_BODY} [text-wrap:balance]`}>Your agent sets up each part over MCP. Underneath: Postgres, PostgREST, SSE and S3.</p>
            <BoxLink href={ROUTES.features}>Every feature</BoxLink>
          </div>
        </div>
      </div>
      {/* Two columns until xl: at 1024 a third of the box was too narrow for the figures' 12px labels (review of 2026-11-27).
          The hairlines are opaque (the same colours as before, made solid), so the head's light never shows through some of them. */}
      <div className="grid gap-px border-t border-[#232427] bg-[#1e1f22] md:grid-cols-2 xl:grid-cols-3">
        {/* The lead: the database, twice as wide, words and drawing side by side. */}
        <Bento className="md:col-span-2">
          <div className="grid h-full gap-[8px] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-end lg:gap-[32px]">
            <div className="flex h-full flex-col">
              <h3 className={BENTO_TITLE}>{database.title}</h3>
              <p className={BENTO_BODY}>{database.body}</p>
              <ul className="mt-[20px] flex flex-wrap gap-[8px] sm:grid sm:w-fit sm:grid-cols-2">
                {databaseFacts.map((fact) => (
                  <li key={fact} className="rounded-[6px] border border-white/[0.08] bg-white/[0.03] px-[10px] py-[4px] text-[13px] text-zinc-300">
                    {fact}
                  </li>
                ))}
              </ul>
            </div>
            <div className="hidden min-w-0 sm:block lg:w-full lg:max-w-[360px] lg:justify-self-end">
              <DatabaseDiagram />
            </div>
          </div>
        </Bento>
        <PrimitiveCell p={auth} />
        <PrimitiveCell p={rest} />
        <PrimitiveCell p={realtime} />
        <PrimitiveCell p={storage} />
        <PrimitiveCell p={functions} split className="md:col-span-2 xl:col-span-1" />
        <Bento className="md:col-span-2">
          <h3 className={BENTO_TITLE}>Also built in</h3>
          <div className="mt-auto grid gap-x-[32px] gap-y-[28px] pt-[24px] sm:grid-cols-3">
            {ALSO_BUILT_IN.map((item) => (
              <div key={item.title} className="border-t border-white/[0.08] pt-[20px]">
                <item.icon aria-hidden className="h-[18px] w-[18px] text-zinc-300" strokeWidth={1.75} />
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
        extra={<BoxLink href="/docs/autonomy">How autonomy works</BoxLink>}
        visual={<RepairChart />}
      />
      {/* Approval lives in the next box and undo in History, so this box says neither (designers' review, 2026-11-15).
          One link per box, under its sentence, named for where it goes (review of 2026-11-27: four "Read the docs" in a row). */}
      <Cells
        items={[
          { icon: Gauge, title: '27 checks', body: 'Indexes, constraints, policies and errors, checked on every project every minute.' },
          { icon: Wrench, title: 'Fixed, then re-checked', body: 'Safe fixes ship on their own; the check that found the problem runs again.' },
          { icon: ShieldCheck, title: 'Risky changes wait', body: "Destructive, auth and irreversible changes wait for you, including your agent's." },
          { icon: SlidersHorizontal, title: 'You set how far', body: 'Autopilot or Review-only, chosen for each project.' },
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
        title="Your schema restructures itself, once you approve"
        body="When a table starts doing two jobs, Backenly plans the split and asks you first. Your apps keep working."
        extra={<BoxLink href="/features/self-restructuring-schema">How restructuring works</BoxLink>}
        visual={<RestructurePlan />}
      />
      <Cells
        items={[
          { icon: Ruler, title: 'Measured first', body: 'It acts on a measured cost, like schema changes that keep locking a table, never on size alone.' },
          { icon: FlaskConical, title: 'Rehearsed on a copy', body: 'The whole change runs on a copy of the real rows, then rolls back.' },
          { icon: Code2, title: 'Apps keep working', body: 'Old and new code both work; the old columns stay until you remove them.' },
          { icon: LineChart, title: 'Judged afterwards', body: 'It measures the result and says plainly whether it helped.' },
        ]}
      />
    </Box>
  )
}

export function HistoryBox() {
  // reach 560: painting b's brightest run falls to the right edge, which beside this tall record showed only in the
  // 48px gutter, as a lit bar (review of 2026-11-27); a shorter reach keeps the light behind the head.
  return (
    <Box id="history-heading" light={{ art: 'b', reach: 560 }}>
      <BoxHead
        id="history-heading"
        layout="stacked"
        tag={{ icon: History, label: 'History' }}
        title="Every change on the record"
        body="Your agent, Backenly and your team write to one history. Restore one change without rolling back the rest."
        extra={<BoxLink href="/features/undo-and-rollback">How restore works</BoxLink>}
        visual={<HistoryRecord />}
      />
      <Cells
        items={[
          { icon: List, title: 'One history', body: 'Database, auth, storage, functions, webhooks, environment and keys: one entry per change, with who made it.' },
          { icon: Archive, title: 'Kept, not deleted', body: 'Dropped tables and columns are kept, so a restore brings them back: 7 days on Free, 30 on Pro.' },
          { icon: Undo2, title: 'Restore one change', body: 'Checked before it runs. If it would remove or overwrite newer data, a person approves first.' },
          { icon: RotateCcw, title: 'Restore to a point', body: 'Undo everything after a change, checked as a whole before any step runs. Agents can ask; only a person decides.' },
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
        extra={<BoxLink href={ROUTES.github}>Read the code on GitHub</BoxLink>}
        visual={
          <div className="overflow-hidden rounded-[8px] border border-white/[0.07] bg-[#0a0a0d]">
            <RegionsSunline />
          </div>
        }
      />
      <Cells
        items={[
          { icon: Lock, title: 'Isolated by Postgres', body: 'Each project is its own schema. Isolation is a Postgres grant, not a WHERE clause.' },
          { icon: Map, title: 'A stack per region', body: 'Each region runs its own database, API and file storage. You choose one per project.' },
          { icon: ShieldCheck, title: 'Scoped access', body: "An agent's key can request a destructive change, never approve one." },
          { icon: Github, title: 'Open source', body: 'Apache-2.0. Read every line, or run it on your own servers.' },
        ]}
      />
    </Box>
  )
}
