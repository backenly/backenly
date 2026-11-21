'use client'

import { type ReactNode } from 'react'
import { FileJson } from 'lucide-react'
import { KitButton } from '@/components/inspector/kit'
import { FOCUS_INSET } from '@/components/console/tokens'
import { DEMO_PLANS, bytes, n, plural, rowsTotal, type MovePlan } from './plan'
import { SourceMark, type SourceId } from './sources'

/* ─────────────────────────────────────────────────────────────
   The migration guide's pictures of the move (/migrate): what a move
   carries (WhatMoves) and the first screen of connecting (ConnectPreview),
   with the demo plans in ./plan.

   The console's own first run and import flow moved to components/onboarding
   (2026-11-16): the question "How do you want to start?" on the Projects
   page, and the import page at /app/org/[orgId]/import, wired to the import
   API. /app/welcome forwards there. What is left here is only what the
   guide shows, kept exactly as it renders today.
───────────────────────────────────────────────────────────── */

const PANEL = 'overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#0f1012]'

function Radio({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full border transition-colors duration-150 ${
        on ? 'border-violet-300 bg-violet-400/20' : 'border-white/20'
      }`}
    >
      {on && <span className="h-[6px] w-[6px] rounded-full bg-violet-200" />}
    </span>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-4 px-5 py-2.5 sm:grid-cols-[132px_minmax(0,1fr)]">
      <dt className="text-[12.5px] leading-[20px] text-faint">{label}</dt>
      <dd className="text-[13px] leading-[20px] text-zinc-200">{children}</dd>
    </div>
  )
}

/** What a move carries, as the review lists it. Also shown on /migrate/<source>. */
export function WhatMoves({ plan }: { plan: MovePlan }) {
  return (
    <dl className={`${PANEL} divide-y divide-white/[0.06]`}>
      <Fact label={plan.tableWord.many.charAt(0).toUpperCase() + plan.tableWord.many.slice(1)}>
        {plural(plan.tables.length, plan.tableWord.one, plan.tableWord.many)}, {n(rowsTotal(plan))} rows
        {plan.source === 'firebase' && <span className="text-faint">, each becoming a table</span>}
      </Fact>
      {plan.users !== undefined && <Fact label="Users">{n(plan.users)}, with the passwords they have</Fact>}
      {plan.files && (
        <Fact label="Files">
          {plural(plan.files.buckets, 'bucket', 'buckets')}, {n(plan.files.count)} files, {bytes(plan.files.bytes)}
        </Fact>
      )}
      {plan.rules && (
        <Fact label="Access rules">
          {n(plan.rules.count)} {plan.rules.word}, translated for Backenly. Until you approve them, only your server key can read
          or write those tables.
        </Fact>
      )}
      {plan.staysBehind && (
        <Fact label="Stays behind">
          <span className="text-zinc-400">
            {n(plan.staysBehind.count)} {plan.staysBehind.word}. Your agent can rebuild them as Backenly functions.
          </span>
        </Fact>
      )}
    </dl>
  )
}

/* ── Connect panels, shared with /migrate/<source> ─────────────────────── */

/**
 * Supabase as the import's Connect step reads it: the project's Session pooler
 * connection string (it works on every network; the direct host is IPv6 only)
 * and what Backenly found there. No password is shown; the importer only reads
 * with it, keeps it sealed while the move runs and erases it when it ends
 * (lib/import/sandbox.ts).
 */
function SupabaseFound({ plan }: { plan: MovePlan }) {
  return (
    <div className={PANEL}>
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-3">
        <SourceMark id="supabase" className="h-[14px] w-[14px] shrink-0 text-zinc-400" />
        <p className="min-w-0 flex-1 truncate font-mono text-[12.5px] leading-[20px] text-zinc-100">
          postgresql://postgres.qwertyuiop@aws-0-us-east-1.pooler.supabase.com:5432/postgres
        </p>
      </div>
      <dl className="divide-y divide-white/[0.06]">
        <Fact label="Project">
          {plan.project} <span className="text-faint">{plan.sourceWhere}</span>
        </Fact>
        <Fact label="Tables">
          {plural(plan.tables.length, 'table', 'tables')}, {n(rowsTotal(plan))} rows
        </Fact>
        <Fact label="Authentication">{n(plan.users ?? 0)} users, with their password hashes</Fact>
        <Fact label="Storage">
          {plural(plan.files?.count ?? 0, 'file', 'files')}, {bytes(plan.files?.bytes ?? 0)}
        </Fact>
        <Fact label="Access">Reads only, never writes</Fact>
      </dl>
    </div>
  )
}

function FirebaseKey({ plan, onReplace }: { plan: MovePlan; onReplace?: () => void }) {
  return (
    <div className={PANEL}>
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-3">
        <FileJson aria-hidden className="h-[15px] w-[15px] shrink-0 text-zinc-400" strokeWidth={1.75} />
        <p className="min-w-0 flex-1 truncate font-mono text-[12.5px] leading-[20px] text-zinc-100">courtside-7f3c2-firebase-adminsdk.json</p>
        {onReplace && (
          <KitButton variant="ghost" size="sm" onClick={onReplace}>
            Replace
          </KitButton>
        )}
      </div>
      <dl className="divide-y divide-white/[0.06]">
        <Fact label="Project">
          Courtside <span className="font-mono text-[12px] text-faint">{plan.sourceWhere}</span>
        </Fact>
        <Fact label="Firestore">
          {plural(plan.tables.length, 'collection', 'collections')}, {n(rowsTotal(plan))} documents
        </Fact>
        <Fact label="Authentication">{n(plan.users ?? 0)} users, with their password hashes</Fact>
        <Fact label="Storage">
          {plural(plan.files?.count ?? 0, 'file', 'files')}, {bytes(plan.files?.bytes ?? 0)}
        </Fact>
      </dl>
    </div>
  )
}

function PostgresFound({ plan }: { plan: MovePlan }) {
  return (
    <div className={PANEL}>
      <div className="border-b border-white/[0.06] px-5 py-3">
        <p className="truncate font-mono text-[12.5px] leading-[20px] text-zinc-100">
          postgresql://courtside_ro@ep-misty-river-a5k2…/courtside
        </p>
      </div>
      <dl className="divide-y divide-white/[0.06]">
        <Fact label="Host">{plan.sourceWhere}</Fact>
        <Fact label="Tables">
          {plural(plan.tables.length, 'table', 'tables')}, {n(rowsTotal(plan))} rows
        </Fact>
        <Fact label="Access">Reads only, never writes</Fact>
      </dl>
    </div>
  )
}

/**
 * The connect step's panel as it looks once connected, for the /migrate
 * pages: the first screen of the move, shown beside the pitch.
 */
export function ConnectPreview({ source }: { source: SourceId }) {
  const plan = DEMO_PLANS[source]
  if (source === 'supabase') return <SupabaseFound plan={plan} />
  if (source === 'firebase') return <FirebaseKey plan={plan} />
  return <PostgresFound plan={plan} />
}
