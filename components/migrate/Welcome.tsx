'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, Check, ChevronDown, FileJson, Upload } from 'lucide-react'
import { BUTTON_BASE, BUTTON_VARIANTS, KitButton, KitField, KitInput, INPUT_BASE, Spinner } from '@/components/inspector/kit'
import { FOCUS, FOCUS_INSET } from '@/components/console/tokens'
import { signOut } from '@/lib/api/auth'
import { CLOUD_REGIONS, regionLabel } from '@/lib/regions'
import { sharedRead } from '@/lib/client/shared-read'
import { MoveLedger } from './MoveLedger'
import { DEMO_PLANS, bytes, durationOf, n, plural, progressAt, rowsTotal, type MovePlan } from './plan'
import { BackenlyMark, SOURCE_ORDER, SOURCES, SourceMark, type SourceId } from './sources'
import { clockOf, usePlayhead } from './usePlayhead'

/* ─────────────────────────────────────────────────────────────
   First run (/app/welcome), between signing up and the console.

   One question first: start a new backend, or move one you already run.
   Moving is three steps: connect the source, review what moves and where,
   then the move itself, which plays as the ledger (./MoveLedger) and ends on
   the dashboard with the project under its own name.

   A focused page, not the console: no sidebar until there is something to
   put in it. The page ground is the console's chrome; panels are its plates.
   The violet accent appears once per screen: the chosen radio, or the
   "Moving" dot.

   Second pass (2026-11-14, "more professional, non AI slop"): no icon tiles
   anywhere. The question is one radio group, the way settings pages ask; the
   sources are a row of buttons inside the chosen option, with the next step
   named under them. The trail is words, not numbered circles on a line.

   Preview params (design review only): ?step=start|connect|review|move,
   &from=supabase|firebase|postgres, &connected=1, &at=<seconds into the move>,
   &speed=<playback speed>.
───────────────────────────────────────────────────────────── */

type Step = 'start' | 'connect' | 'review' | 'move'

const TRAIL: { id: Exclude<Step, 'start'>; label: string }[] = [
  { id: 'connect', label: 'Connect' },
  { id: 'review', label: 'Review' },
  { id: 'move', label: 'Move' },
]

/** What connecting will ask for, said under the chosen source before Continue. */
const NEXT: Record<SourceId, string> = {
  supabase: 'Next, you sign in to Supabase and pick the project.',
  firebase: 'Next, you upload a service account key from the Firebase console.',
  postgres: 'Next, you paste a connection string. A read-only user is enough.',
}

const PANEL = 'overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#0f1012]'
const BUTTON_LG = `${BUTTON_BASE} ${BUTTON_VARIANTS.primary} h-[40px] px-4 text-[14px]`

export function Welcome() {
  const params = useSearchParams()
  const router = useRouter()
  const [step, setStep] = useState<Step>((params.get('step') as Step) || 'start')
  const [choice, setChoice] = useState<'new' | 'move'>(params.get('from') || params.get('step') ? 'move' : 'new')
  const [source, setSource] = useState<SourceId>((params.get('from') as SourceId) || 'supabase')
  const [me, setMe] = useState<{ name?: string; email?: string } | null>(null)

  useEffect(() => {
    sharedRead('/api/auth/me')
      .then((r) => r.ok && setMe(r.data?.user ?? null))
      .catch(() => {})
  }, [])

  const plan = DEMO_PLANS[source]
  const first = me?.name?.trim().split(/\s+/)[0]

  return (
    <div className="min-h-screen bg-[#08090a] text-zinc-100 antialiased selection:bg-violet-400/30 selection:text-white">
      <header className="flex h-[56px] items-center justify-between border-b border-white/[0.06] px-4 sm:px-6">
        <Link href="/" aria-label="Backenly home" className={`flex items-center gap-2.5 rounded-[6px] ${FOCUS}`}>
          <BackenlyMark className="h-[24px] w-[24px]" />
          <span className="text-[15px] font-semibold tracking-[-0.02em] text-white">Backenly</span>
        </Link>
        <div className="flex items-center gap-3">
          {me?.email && <span className="hidden text-[12.5px] text-faint sm:inline">{me.email}</span>}
          <KitButton variant="ghost" size="sm" onClick={() => signOut().catch(() => {})}>
            Log out
          </KitButton>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[680px] px-4 pb-24 pt-10 sm:px-6 sm:pt-[72px]">
        {step !== 'start' && <Trail current={step} />}

        {step === 'start' && (
          <StartStep
            first={first}
            choice={choice}
            onChoice={setChoice}
            source={source}
            onSource={setSource}
            onContinue={() => (choice === 'move' ? setStep('connect') : router.push('/app/new-organization?first=1'))}
          />
        )}
        {step === 'connect' && (
          <ConnectStep
            source={source}
            plan={plan}
            email={me?.email}
            initiallyConnected={params.get('connected') === '1'}
            onBack={() => setStep('start')}
            onContinue={() => setStep('review')}
          />
        )}
        {step === 'review' && <ReviewStep plan={plan} onBack={() => setStep('connect')} onMove={() => setStep('move')} />}
        {step === 'move' && (
          <MoveStep
            plan={plan}
            email={me?.email}
            at={params.get('at') ? Number(params.get('at')) : undefined}
            speed={params.get('speed') ? Number(params.get('speed')) : 0.6}
            onOpen={() => router.push('/app?moved=1')}
          />
        )}
      </main>
    </div>
  )
}

/* ── Pieces ────────────────────────────────────────────────────────────── */

function Trail({ current }: { current: Step }) {
  const at = TRAIL.findIndex((s) => s.id === current)
  return (
    <ol aria-label="Steps" className="mb-7 flex items-center gap-5 text-[12.5px] leading-[18px]">
      {TRAIL.map((s, i) => {
        const done = i < at
        const now = i === at
        return (
          <li
            key={s.id}
            aria-current={now ? 'step' : undefined}
            className={`inline-flex items-center gap-1.5 ${now ? 'font-medium text-zinc-100' : done ? 'text-zinc-400' : 'text-faint'}`}
          >
            {done && <Check aria-hidden className="h-3 w-3 text-zinc-400" strokeWidth={2.5} />}
            {s.label}
          </li>
        )
      })}
    </ol>
  )
}

function Title({ children, lede }: { children: ReactNode; lede?: ReactNode }) {
  return (
    <div className="mb-8">
      <h1 className="text-[26px] font-semibold leading-[32px] tracking-[-0.026em] text-zinc-50 [text-wrap:balance] sm:text-[28px] sm:leading-[34px]">
        {children}
      </h1>
      {lede && <p className="mt-2.5 max-w-[58ch] text-[15px] leading-[24px] text-zinc-400 [text-wrap:pretty]">{lede}</p>}
    </div>
  )
}

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

function Footer({ back, children }: { back?: () => void; children: ReactNode }) {
  return (
    <div className="mt-8 flex items-center justify-between gap-3">
      {back ? (
        <KitButton variant="ghost" icon={ArrowLeft} onClick={back}>
          Back
        </KitButton>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}

/* ── 1. The question ───────────────────────────────────────────────────── */

function StartStep({
  first,
  choice,
  onChoice,
  source,
  onSource,
  onContinue,
}: {
  first?: string
  choice: 'new' | 'move'
  onChoice: (c: 'new' | 'move') => void
  source: SourceId
  onSource: (s: SourceId) => void
  onContinue: () => void
}) {
  return (
    <>
      <Title lede="Start a backend from nothing, or move one you already run. You can do the other later.">
        {first ? `Welcome to Backenly, ${first}` : 'Welcome to Backenly'}
      </Title>

      <div role="radiogroup" aria-label="How do you want to start?" className={PANEL}>
        <Option
          on={choice === 'new'}
          onSelect={() => onChoice('new')}
          title="Start a new backend"
          body="Your coding agent builds it from a description, and Backenly runs it."
        />
        <div className="border-t border-white/[0.06]" />
        <Option
          on={choice === 'move'}
          onSelect={() => onChoice('move')}
          title="Move an existing project"
          body="Its tables, rows, users and files come across in a few minutes."
        >
          {choice === 'move' && (
            <div className="motion-safe:animate-[slideUp_220ms_cubic-bezier(0.23,1,0.32,1)]">
              <p id="where-label" className="mb-2 mt-4 text-[12.5px] text-zinc-400">
                Where is it now?
              </p>
              <div role="radiogroup" aria-labelledby="where-label" className="flex flex-wrap gap-2">
                {SOURCE_ORDER.map((id) => {
                  const on = id === source
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => onSource(id)}
                      className={`inline-flex h-[34px] items-center gap-2 rounded-[7px] border px-3 text-[13px] transition-[background-color,border-color,color] duration-150 ${FOCUS} ${
                        on
                          ? 'border-white/[0.24] bg-white/[0.08] font-medium text-white'
                          : 'border-white/[0.08] bg-white/[0.02] text-zinc-400 hover:border-white/[0.14] hover:text-zinc-200'
                      }`}
                    >
                      <SourceMark id={id} className="h-[14px] w-[14px]" />
                      {SOURCES[id].name}
                    </button>
                  )
                })}
              </div>
              <p className="mt-3 text-[12.5px] leading-[18px] text-faint">{NEXT[source]}</p>
            </div>
          )}
        </Option>
      </div>

      <Footer>
        <KitButton variant="primary" onClick={onContinue}>
          Continue
        </KitButton>
      </Footer>
    </>
  )
}

/**
 * One option of the question. The whole row selects; a nested control (the
 * source buttons) sits inside the chosen row, under its words.
 */
function Option({
  on,
  onSelect,
  title,
  body,
  children,
}: {
  on: boolean
  onSelect: () => void
  title: string
  body: string
  children?: ReactNode
}) {
  return (
    <div className={`transition-colors duration-150 ${on ? 'bg-white/[0.025]' : ''}`}>
      <button
        type="button"
        role="radio"
        aria-checked={on}
        onClick={onSelect}
        className={`flex w-full items-start gap-3.5 px-5 pt-[18px] text-left ${children && on ? 'pb-0' : 'pb-[18px]'} ${FOCUS_INSET} ${
          on ? '' : 'hover:bg-white/[0.02]'
        }`}
      >
        <span className="pt-[3px]">
          <Radio on={on} />
        </span>
        <span className="min-w-0">
          <span className="block text-[14.5px] font-semibold leading-[22px] tracking-[-0.01em] text-zinc-50">{title}</span>
          <span className="mt-0.5 block text-[13px] leading-[20px] text-zinc-400 [text-wrap:pretty]">{body}</span>
        </span>
      </button>
      {children && on && <div className="pb-[18px] pl-[50px] pr-5">{children}</div>}
    </div>
  )
}

/* ── 2. Connect ────────────────────────────────────────────────────────── */

const SUPABASE_PROJECTS = [
  { name: 'courtside', where: 'East US (North Virginia)', tables: 9, size: 2.1e9 },
  { name: 'courtside-staging', where: 'East US (North Virginia)', tables: 9, size: 8.6e7 },
  { name: 'marketing-site', where: 'Central EU (Frankfurt)', tables: 2, size: 4.2e6 },
]

function ConnectStep({
  source,
  plan,
  email,
  initiallyConnected,
  onBack,
  onContinue,
}: {
  source: SourceId
  plan: MovePlan
  email?: string
  initiallyConnected: boolean
  onBack: () => void
  onContinue: () => void
}) {
  const [connected, setConnected] = useState(initiallyConnected)
  const [waiting, setWaiting] = useState(false)
  const [pick, setPick] = useState(SUPABASE_PROJECTS[0].name)
  const [conn, setConn] = useState('postgresql://courtside_ro@ep-misty-river-a5k2.us-east-2.aws.neon.tech/courtside')
  // Supabase's consent screen opens and returns here; the preview stands in for the round trip.
  const signIn = () => {
    setWaiting(true)
    window.setTimeout(() => {
      setWaiting(false)
      setConnected(true)
    }, 1100)
  }

  if (source === 'supabase') {
    return (
      <>
        <Title lede="Pick the project to move. Backenly gets read access only, and never writes to Supabase.">
          Connect Supabase
        </Title>
        {!connected ? (
          <div>
            <button type="button" onClick={signIn} disabled={waiting} aria-busy={waiting || undefined} className={`${BUTTON_LG} w-full sm:w-auto`}>
              {waiting ? <Spinner className="h-4 w-4" /> : <SourceMark id="supabase" className="h-[15px] w-[15px]" />}
              {waiting ? 'Waiting for Supabase…' : 'Continue with Supabase'}
            </button>
            <p className="mt-3 max-w-[58ch] text-[12.5px] leading-[18px] text-faint">
              Supabase shows what Backenly asks for before you approve it. You can revoke the access there at any time.
            </p>
          </div>
        ) : (
          <SupabasePicker plan={plan} email={email} pick={pick} onPick={setPick} onSwitch={() => setConnected(false)} />
        )}
        <p className="mt-5 text-[12.5px] text-faint">
          Rather not sign in?{' '}
          <button type="button" className={`rounded-[4px] text-zinc-300 underline decoration-white/20 underline-offset-[3px] hover:text-white ${FOCUS}`}>
            Paste a connection string instead
          </button>
        </p>
        <Footer back={onBack}>
          {connected && (
            <KitButton variant="primary" onClick={onContinue}>
              Continue
            </KitButton>
          )}
        </Footer>
      </>
    )
  }

  if (source === 'firebase') {
    return (
      <>
        <Title lede="Backenly reads Firestore, Authentication and Storage with a service account key, and never writes to Firebase.">
          Connect Firebase
        </Title>
        {!connected ? (
          <label
            className={`flex cursor-pointer flex-col items-center rounded-[10px] border border-dashed border-white/[0.14] bg-[#0f1012] px-6 py-10 text-center transition-colors duration-150 hover:border-white/[0.24] focus-within:border-violet-300/60`}
          >
            <Upload aria-hidden className="h-5 w-5 text-zinc-500" strokeWidth={1.75} />
            <span className="mt-3 text-[13.5px] font-medium text-zinc-100">Drop the key file here, or choose one</span>
            <span className="mt-1 max-w-[46ch] text-[12.5px] leading-[18px] text-faint">
              In the Firebase console, open Project settings, then Service accounts, and press Generate new private key.
            </span>
            <input type="file" accept="application/json" className="sr-only" onChange={() => setConnected(true)} />
          </label>
        ) : (
          <FirebaseKey plan={plan} onReplace={() => setConnected(false)} />
        )}
        <p className="mt-3 text-[12.5px] text-faint">The key is used for this move and then discarded.</p>
        <Footer back={onBack}>
          {connected && (
            <KitButton variant="primary" onClick={onContinue}>
              Continue
            </KitButton>
          )}
        </Footer>
      </>
    )
  }

  return (
    <>
      <Title lede="A read-only user is enough. Backenly reads the database to copy it and never writes to it.">Connect Postgres</Title>
      <div className={`${PANEL} p-5`}>
        <KitField label="Connection string" hint="Use the direct connection, not a pooler, so the copy can read every table in one session.">
          <KitInput value={conn} onChange={(e) => setConn(e.target.value)} spellCheck={false} autoComplete="off" className="font-mono !text-[12.5px]" />
        </KitField>
        {connected && (
          <p className="mt-4 flex items-center gap-2 border-t border-white/[0.06] pt-4 text-[12.5px] text-zinc-300">
            <Check aria-hidden className="h-[13px] w-[13px] text-zinc-300" strokeWidth={2.25} />
            Connected to {plan.sourceWhere}. {plural(plan.tables.length, 'table', 'tables')}, {n(rowsTotal(plan))} rows.
          </p>
        )}
      </div>
      <Footer back={onBack}>
        <KitButton variant="primary" onClick={onContinue}>
          Continue
        </KitButton>
      </Footer>
    </>
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

/* ── 3. Review ─────────────────────────────────────────────────────────── */

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
          {n(plan.rules.count)} {plan.rules.word}, rewritten for Backenly. Until you approve them, only your server key can read
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

function ReviewStep({ plan, onBack, onMove }: { plan: MovePlan; onBack: () => void; onMove: () => void }) {
  const [org, setOrg] = useState(plan.sourceOrg)
  const [name, setName] = useState(plan.project)
  const src = SOURCES[plan.source].name
  const where = plan.source === 'postgres' ? 'the source database' : src
  const near = plan.sourceWhere.includes(',') ? plan.sourceWhere.split(', ')[1] : plan.sourceWhere

  return (
    <>
      <Title lede={`${plan.project} moves into a new Backenly project. Nothing changes on ${where}, so your app keeps running there until you switch it over.`}>
        Review the move
      </Title>

      <h2 className="mb-2.5 text-[13px] font-medium text-zinc-200">What moves</h2>
      <WhatMoves plan={plan} />

      <h2 className="mb-2.5 mt-8 text-[13px] font-medium text-zinc-200">Where it goes</h2>
      <div className={`${PANEL} grid gap-4 p-5 sm:grid-cols-2`}>
        <KitField label="Organization" hint={`Named after your ${src} organization. You can rename it later.`}>
          <KitInput value={org} onChange={(e) => setOrg(e.target.value)} maxLength={80} autoComplete="organization" />
        </KitField>
        <KitField label="Project">
          <KitInput value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="off" />
        </KitField>
        <div className="sm:col-span-2">
          <KitField label="Region" hint={`The closest to ${near}, where it runs now.`}>
            <div className="relative">
              <select defaultValue={plan.region} className={`${INPUT_BASE} h-[36px] appearance-none px-3 pr-9 sm:h-[32px]`}>
                {CLOUD_REGIONS.map((r) => (
                  <option key={r.id}>{regionLabel(r.id)}</option>
                ))}
              </select>
              <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            </div>
          </KitField>
        </div>
      </div>

      <Footer back={onBack}>
        <KitButton variant="primary" onClick={onMove} disabled={!name.trim() || !org.trim()}>
          Move {name.trim() || 'project'}
        </KitButton>
      </Footer>
    </>
  )
}

/* ── 4. The move ───────────────────────────────────────────────────────── */

function MoveStep({
  plan,
  email,
  at,
  speed,
  onOpen,
}: {
  plan: MovePlan
  email?: string
  at?: number
  speed: number
  onOpen: () => void
}) {
  const duration = useMemo(() => durationOf(plan), [plan])
  const live = usePlayhead({ duration, running: at === undefined, speed })
  const t = Math.min(at ?? live, duration)
  const progress = progressAt(plan, t)
  const clock = clockOf((t / duration) * plan.minutes * 60)
  const done = progress.finished

  return (
    <>
      {done ? (
        <Title
          lede={
            <>
              Every {plan.tableWord.one} matched its source: {n(rowsTotal(plan))} rows
              {plan.users !== undefined && `, ${n(plan.users)} users`}
              {plan.files && ` and ${n(plan.files.count)} files`}.
              {plan.rules && ` ${n(plan.rules.count)} access rules are waiting for your review.`}
            </>
          }
        >
          {plan.project} is on Backenly
        </Title>
      ) : (
        <Title lede={`About ${plan.minutes} minutes. You can close this tab; we will email ${email ?? 'you'} when it is done.`}>
          Moving {plan.project}
        </Title>
      )}

      {/* Done: the next step sits under the summary, above the fold; the ledger below is the receipt. */}
      {done && (
        <div className="-mt-2 mb-8">
          <KitButton variant="primary" onClick={onOpen}>
            Open dashboard
          </KitButton>
        </div>
      )}

      <MoveLedger plan={plan} progress={progress} clock={clock} />

      {!done && (
        <div className="mt-6 flex items-center justify-end">
          <KitButton variant="ghost" onClick={() => {}}>
            Stop the move
          </KitButton>
        </div>
      )}
    </>
  )
}

/* ── Connect panels, shared with /migrate/<source> ─────────────────────── */

function SupabasePicker({
  plan,
  email,
  pick,
  onPick,
  onSwitch,
}: {
  plan: MovePlan
  email?: string
  pick: string
  onPick: (name: string) => void
  onSwitch?: () => void
}) {
  return (
    <div className={PANEL}>
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-3">
        <SourceMark id="supabase" className="h-[14px] w-[14px] text-zinc-400" />
        <p className="min-w-0 flex-1 truncate text-[13px] leading-[20px] text-zinc-400">
          <span className="font-medium text-zinc-100">{plan.sourceOrg}</span>
          <span className="text-faint"> as {email ?? 'you'}</span>
        </p>
        {onSwitch && (
          <KitButton variant="ghost" size="sm" onClick={onSwitch}>
            Switch account
          </KitButton>
        )}
      </div>
      <div role="radiogroup" aria-label="Project to move">
        {SUPABASE_PROJECTS.map((p, i) => {
          const on = p.name === pick
          return (
            <button
              key={p.name}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onPick(p.name)}
              className={`grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-3.5 px-5 py-3 text-left transition-colors duration-150 sm:grid-cols-[16px_minmax(0,1fr)_72px_64px] ${FOCUS_INSET} ${
                i > 0 ? 'border-t border-white/[0.06]' : ''
              } ${on ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]'}`}
            >
              <Radio on={on} />
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-medium leading-[20px] text-zinc-100">{p.name}</span>
                <span className="block truncate text-[12.5px] leading-[18px] text-faint">{p.where}</span>
              </span>
              <span className="text-right text-[12.5px] tabular-nums text-faint">{plural(p.tables, 'table', 'tables')}</span>
              <span className="hidden text-right text-[12.5px] tabular-nums text-faint sm:block">{bytes(p.size)}</span>
            </button>
          )
        })}
      </div>
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
        <Fact label="Access">Read only</Fact>
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
  const [pick, setPick] = useState(SUPABASE_PROJECTS[0].name)
  if (source === 'supabase') return <SupabasePicker plan={plan} email="you@example.com" pick={pick} onPick={setPick} />
  if (source === 'firebase') return <FirebaseKey plan={plan} />
  return <PostgresFound plan={plan} />
}
