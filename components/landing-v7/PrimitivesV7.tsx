'use client'

import Link from 'next/link'
import { ArrowRight, GitBranch, ShieldCheck, Users } from 'lucide-react'
import {
  AuthDiagram,
  DatabaseDiagram,
  FunctionsDiagram,
  RealtimeDiagram,
  RestApiDiagram,
  StorageDiagram,
} from '@/components/landing/CapabilityDiagrams'
import { ROUTES } from '@/components/site/SiteShell'
import { HEADING } from '@/components/site/tokens'
import { BentoCell, CellBody, CellTitle, CONTAINER, SECTION, SECTION_BODY_GAP, SECTION_TITLE, TEXT_LINK } from './shared'

/* ─────────────────────────────────────────────────────────────
   Primitives (founders, 2026-10-14, with a screenshot of the live bento: "i
   prefer this style for the boxes").

   So the boxes are the LIVE bento, unchanged: the same cells, copy, fact chips,
   spotlight hover and the line-art figures in
   components/landing/CapabilityDiagrams (origin/main app/page.tsx,
   PrimitivesSection, at 85bfbf5b). Only the headline above them is v7's.
   Set 2+1 / 1+1+1 / 1+2 so the grid has a rhythm instead of six equal tiles.
───────────────────────────────────────────────────────────── */

type Primitive = {
  title: string
  body: string
  diagram: () => JSX.Element
}

const primitives: Primitive[] = [
  {
    title: 'Postgres, a schema of your own',
    body: 'Tables, relations, indexes, constraints and pgvector, in a PostgreSQL schema per project. Isolation is a Postgres grant, not a WHERE clause.',
    diagram: DatabaseDiagram,
  },
  {
    title: 'Auth',
    body: 'Sign-up, OAuth, magic links and verification emails for your users. Each project signs with its own secret.',
    diagram: AuthDiagram,
  },
  {
    title: 'REST APIs',
    body: 'PostgREST serves every table from the catalog: filters, ordering, pagination, embedded resources, OpenAPI.',
    diagram: RestApiDiagram,
  },
  {
    title: 'Realtime',
    body: 'Inserts, updates and deletes as they land, plus presence and broadcast. Delivered over SSE, with no socket server to run.',
    diagram: RealtimeDiagram,
  },
  {
    title: 'Storage',
    body: 'Buckets, uploads, metadata and expiring signed URLs, on local disk or any S3-compatible provider.',
    diagram: StorageDiagram,
  },
  {
    title: 'Functions and triggers',
    body: 'Run code on insert, update, delete or signup, or on a cron schedule. Webhooks and rate limits included.',
    diagram: FunctionsDiagram,
  },
]

const alsoBuiltIn = [
  {
    icon: ShieldCheck,
    title: 'Row-level security by description',
    body: 'Say who can read and write what. Backenly writes and enforces the Postgres policies.',
  },
  {
    icon: GitBranch,
    title: 'Branches for risky work',
    body: 'Clone the backend, let your agent experiment, review the diff, merge what works.',
  },
  {
    icon: Users,
    title: 'Teams and organizations',
    body: 'Invite teammates with roles. Every actor writes to the same change ledger.',
  },
]

const databaseFacts = ['Standard PostgreSQL', 'pgvector', 'Direct connection strings', 'pg_dump exports']


export function PrimitivesV7() {
  const [database, auth, rest, realtime, storage, functions] = primitives

  return (
    // font-light: on the live page these cells inherit SiteShell's weight 300,
    // and the boxes are meant to match it exactly.
    <section id="platform" aria-labelledby="platform-heading" className={`${SECTION} scroll-mt-[92px] font-light`}>
      <div className={CONTAINER}>
        <div>
          <h2
            id="platform-heading"
            className={SECTION_TITLE}
          >
            Everything a production backend needs.{' '}
            <span className="text-zinc-500">Wired to one Postgres schema per project from the first table.</span>
          </h2>
        </div>

        <div className={`${SECTION_BODY_GAP} grid gap-3 md:grid-cols-2 lg:grid-cols-3`}>
          {/* Lead cell: the database, twice as wide, text and drawing side by side. */}
          <BentoCell className="md:col-span-2">
            <div className="grid h-full gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-end">
              <div className="flex h-full flex-col">
                <CellTitle>{database.title}</CellTitle>
                <CellBody>{database.body}</CellBody>
                <ul className="mt-auto flex flex-wrap gap-2 pt-6">
                  {databaseFacts.map((fact) => (
                    <li
                      key={fact}
                      className="rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[12.5px] text-zinc-300"
                    >
                      {fact}
                    </li>
                  ))}
                </ul>
              </div>
              <database.diagram />
            </div>
          </BentoCell>

          <PrimitiveCell primitive={auth} />
          <PrimitiveCell primitive={rest} />
          <PrimitiveCell primitive={realtime} />
          <PrimitiveCell primitive={storage} />
          <PrimitiveCell primitive={functions} />

          <BentoCell className="md:col-span-2">
            <div className="flex items-baseline justify-between gap-6">
              <CellTitle>Also built in</CellTitle>
              <Link href={ROUTES.features} className={TEXT_LINK}>
                Every feature
                <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </Link>
            </div>
            <div className="mt-6 grid gap-x-8 gap-y-7 sm:grid-cols-3">
              {alsoBuiltIn.map((item) => {
                const ItemIcon = item.icon
                return (
                  <div key={item.title} className="border-t border-white/[0.08] pt-5">
                    <ItemIcon aria-hidden className="h-[18px] w-[18px] text-violet-300" strokeWidth={1.75} />
                    <h4 className={`mt-4 text-[15px] text-white ${HEADING}`}>{item.title}</h4>
                    <p className="mt-2 text-[14px] leading-[1.65] text-zinc-400">{item.body}</p>
                  </div>
                )
              })}
            </div>
          </BentoCell>
        </div>
      </div>
    </section>
  )
}

function PrimitiveCell({ primitive }: { primitive: Primitive }) {
  const Diagram = primitive.diagram
  return (
    <BentoCell>
      <CellTitle>{primitive.title}</CellTitle>
      {/* Three-line floor, so the drawings (bottom-aligned) sit on one line
          across a row even when one paragraph wraps shorter. */}
      <CellBody className="md:min-h-[81px]">{primitive.body}</CellBody>
      <div className="mt-auto">
        <Diagram />
      </div>
    </BentoCell>
  )
}
