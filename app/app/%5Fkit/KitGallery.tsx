'use client'

/**
 * The gallery behind /app/_kit (page.tsx). Each section shows one shared
 * component the way a project section uses it, in its states. All data here
 * is made up for the demo.
 *
 * Deep links for review and screenshots:
 *   ?record=u_3            opens the record drawer on a user
 *   ?dialog=drop-table     opens a confirm (delete-function, drop-table, empty-bucket, delete-project)
 *   ?dialog=secret         opens the secret-once dialog
 */

import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { FileArchive, FileImage, FileText, Filter, Inbox, Play, Plus, Trash2 } from 'lucide-react'
import { OrgShell } from '@/components/shell/OrgShell'
import {
  CopyField,
  KitButton,
  KitCheckbox,
  KitConfirmDialog,
  KitRadio,
  OverflowMenu,
  PageHeader,
  Segmented,
} from '@/components/inspector/kit'
import { EmptyLine, Fact, Facts, Panel, Row, RowList, RowSkeleton, ROW_TEXT, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { CANVAS, EDGE, PAGE_GUTTER, PAGE_WIDTH, RULE, R_PANEL } from '@/components/console/tokens'
import { ChipStrip, GridFooter, InstrumentBar, PaneToolbar, count, type Chip } from '@/components/console/InstrumentBar'
import { RecordDrawer, recordNav, useRecordParam } from '@/components/console/RecordDrawer'
import { AskYourAgent, EmptyPanel, ErrorRow, RefusedLine } from '@/components/console/states'
import { FirstRun } from '@/components/console/FirstRun'
import { CodeWell, DayGroup, DayGroupList, EventList, EventRow, EventRowSkeleton } from '@/components/console/EventRow'
import { ActorMark, ActorWords, Outcome } from '@/components/console/ActorMark'
import { SecretOnceDialog } from '@/components/console/SecretOnceDialog'
import { Time, useNow } from '@/components/console/Time'
import { duration, formatTime, groupByDay, type TimeMode } from '@/components/console/format'
import { undoSentence } from '@/components/console/undo'

const MIN = 60_000
const H = 60 * MIN
const D = 24 * H

const SECTIONS = [
  ['time', 'Time'],
  ['instrument-bar', 'Instrument bar'],
  ['pane-toolbar', 'Pane toolbar'],
  ['record-drawer', 'Record drawer'],
  ['empty-panel', 'Empty panel'],
  ['first-run', 'First run'],
  ['error-row', 'Error row'],
  ['events', 'Event rows'],
  ['actors', 'Actor marks'],
  ['row-leads', 'Row leads'],
  ['choices', 'Checkbox and radio'],
  ['confirm', 'Confirm dialog'],
  ['copy-field', 'Copy field'],
  ['secret-once', 'Secret once'],
] as const

export function KitGallery() {
  // Demo times are measured from when the page was opened.
  const now = useNow(false)
  return (
    <OrgShell>
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-[96px]`}>
        <PageHeader
          flush
          title="Console kit"
          meta={<span className="text-[13px] text-faint">Development only</span>}
          description="The shared parts the project sections are built from, each in its states. Narrow the window to see a phone."
        />
        <nav aria-label="Components" className="-mt-[8px] mb-[36px]">
          <ul className="flex flex-wrap gap-x-[16px] gap-y-[6px] text-[13px] leading-[20px]">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="rounded-[3px] text-zinc-400 underline decoration-white/15 underline-offset-[3px] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {now === null ? (
          <RowSkeleton rows={4} />
        ) : (
          <div className="space-y-[56px]">
            <TimeSection now={now} />
            <InstrumentBarSection now={now} />
            <PaneToolbarSection now={now} />
            <DrawerSection now={now} />
            <EmptyPanelSection />
            <FirstRunSection />
            <ErrorRowSection now={now} />
            <EventsSection now={now} />
            <ActorsSection now={now} />
            <RowLeadsSection />
            <ChoicesSection />
            <ConfirmSection />
            <CopyFieldSection />
            <SecretSection />
          </div>
        )}
      </div>
    </OrgShell>
  )
}

// ─── Small gallery parts ─────────────────────────────────────────────────────

function Path({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[12px] text-zinc-300">{children}</code>
}

/** What one demo shows: a faint line above it. */
function Demo({ caption, children, className = '' }: { caption: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <p className="mb-[8px] text-[12.5px] leading-[18px] text-faint">{caption}</p>
      {children}
    </div>
  )
}

/** The top of an instrument page: the canvas, with the bar and a pane inside. */
function Frame({ children }: { children: ReactNode }) {
  return <div className={`overflow-hidden ${R_PANEL} border ${EDGE} ${CANVAS}`}>{children}</div>
}

function Stack({ children }: { children: ReactNode }) {
  return <div className="space-y-[24px]">{children}</div>
}

// ─── Time ────────────────────────────────────────────────────────────────────

function TimeSection({ now }: { now: number }) {
  const moments: Array<[string, number]> = [
    ['4 s', now - 4_000],
    ['40 s', now - 40_000],
    ['12 min', now - 12 * MIN],
    ['3 h', now - 3 * H],
    ['2 d', now - 2 * D],
    ['9 d', now - 9 * D],
    ['400 d', now - 400 * D],
  ]
  const modes: TimeMode[] = ['ago', 'clock', 'clockSeconds', 'date', 'dateTime', 'day']
  const durations = [0.4, 60, 999.6, 3200, 42_000, 125_000, 3_840_000]
  return (
    <Section
      id="time"
      title="Time"
      description={
        <>
          <Path>formatTime(iso, mode)</Path>, <Path>{'<Time iso mode>'}</Path>, <Path>dayLabel</Path>, <Path>duration</Path> in components/console/format.ts and Time.tsx. Relative times re-render every 30 s; hover any time for the exact moment.
        </>
      }
    >
      <Panel>
        {/* Scrolls sideways on a phone; focusable so the keyboard can scroll it too. */}
        <div role="region" aria-label="Time formats" tabIndex={0} className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70">
          <table className="w-full min-w-[720px] text-left text-[12.5px] leading-[18px]">
            <thead>
              <tr className={`border-b ${RULE} text-[12px] text-faint`}>
                <th scope="col" className="px-[20px] py-[9px] font-medium">Moment</th>
                {modes.map((m) => (
                  <th key={m} scope="col" className="px-[12px] py-[9px] font-mono font-medium">
                    {m}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] tabular-nums">
              {moments.map(([label, at]) => (
                <tr key={label}>
                  <th scope="row" className="whitespace-nowrap px-[20px] py-[9px] font-normal text-faint">
                    {label} ago
                  </th>
                  {modes.map((m) => (
                    <td key={m} className="whitespace-nowrap px-[12px] py-[9px] text-zinc-200">
                      <Time iso={at} mode={m} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={`flex flex-wrap items-center gap-x-[20px] gap-y-[6px] border-t ${RULE} px-[20px] py-[12px] text-[12.5px] leading-[18px]`}>
          <span className="text-faint">duration()</span>
          {durations.map((ms) => (
            <span key={ms} className="tabular-nums text-zinc-200" title={`${ms} ms`}>
              {duration(ms)}
            </span>
          ))}
          <span className="text-faint">Schedules in UTC:</span>
          <span className="tabular-nums text-zinc-200">Daily at {formatTime(Date.UTC(2026, 10, 16, 2, 0), 'clock', { utc: true })}</span>
        </div>
      </Panel>
    </Section>
  )
}

// ─── Instrument bar ──────────────────────────────────────────────────────────

const MOVIES = [
  { id: 'm0000001-4c1e-4f7a-9d21-2b7e5c1a9f10', title: 'Past Lives', year: 2023, genre: 'g0000003-77ab-4e1c-8a52-6d1c2f0e9b44' },
  { id: 'm0000002-9a4d-41f2-8c11-5e2b7a6c3d21', title: 'Aftersun', year: 2022, genre: 'g0000003-77ab-4e1c-8a52-6d1c2f0e9b44' },
  { id: 'm0000003-1b7c-4d0e-a6f4-8c3e9d2b1a32', title: 'The Zone of Interest', year: 2023, genre: 'g0000005-12cd-4b8e-9f63-7e2d3a1f0c55' },
  { id: 'm0000004-6e2f-4a9b-b3d7-1f4c8e5a2b43', title: 'Perfect Days', year: 2023, genre: 'g0000001-ab12-4cde-8f90-1a2b3c4d5e66' },
]

function InstrumentBarSection({ now }: { now: number }) {
  const [tab, setTab] = useState('tables')
  const [range, setRange] = useState<'1h' | '24h' | '7d' | '30d'>('24h')
  const [refreshing, setRefreshing] = useState(false)
  const refresh = () => {
    setRefreshing(true)
    setTimeout(() => setRefreshing(false), 900)
  }
  return (
    <Section
      id="instrument-bar"
      title="Instrument bar"
      description={
        <>
          <Path>InstrumentBar</Path> in components/console/InstrumentBar.tsx. One 48px row: title, at most two facts, text tabs; then freshness, range, refresh, ⋯, one create button. Tabs move to their own row below 1024px.
        </>
      }
    >
      <Stack>
        <Demo caption="Database, with tables: the create button is the screen's one white button.">
          <Frame>
            <InstrumentBar
              headingLevel={3}
              title="Database"
              facts={[{ text: '8 tables' }]}
              tabs={[
                { id: 'tables', label: 'Tables' },
                { id: 'sql', label: 'SQL' },
                { id: 'schema', label: 'Schema' },
                { id: 'types', label: 'Types' },
                { id: 'extensions', label: 'Extensions' },
                { id: 'snapshots', label: 'Snapshots' },
              ]}
              activeTab={tab}
              onTab={setTab}
              freshness={now - 12_000}
              onRefresh={refresh}
              refreshing={refreshing}
              menu={[
                { label: 'Copy API URL', onClick: () => {} },
                { label: 'Changes in History', onClick: () => {} },
              ]}
              create={{ label: 'New table', primary: true }}
            />
          </Frame>
        </Demo>
        <Demo caption="Monitoring: state glyph first, the range control, no create button.">
          <Frame>
            <InstrumentBar
              headingLevel={3}
              title="Monitoring"
              facts={[{ glyph: 'live', text: 'Published' }]}
              tabs={[
                { id: 'overview', label: 'Overview' },
                { id: 'requests', label: 'Requests' },
                { id: 'logs', label: 'Logs' },
              ]}
              activeTab="requests"
              onTab={() => {}}
              freshness={now - 40_000}
              range={{
                value: range,
                onChange: setRange,
                options: [
                  { value: '1h', label: '1h' },
                  { value: '24h', label: '24h' },
                  { value: '7d', label: '7d' },
                  { value: '30d', label: '30d' },
                ],
              }}
              onRefresh={refresh}
              refreshing={refreshing}
            />
          </Frame>
        </Demo>
        <Demo caption="Functions with a failure: the second fact carries its own glyph and tone.">
          <Frame>
            <InstrumentBar
              headingLevel={3}
              title="Functions"
              facts={[{ text: '4 functions' }, { glyph: 'failed', text: '1 failed', tone: 'danger' }]}
              onRefresh={refresh}
              refreshing={refreshing}
              menu={[
                { label: 'Secrets', onClick: () => {} },
                { label: 'Test untested endpoints (2)', onClick: () => {} },
                { label: 'Function logs in Monitoring', onClick: () => {} },
              ]}
              create={{ label: 'New function', primary: true }}
            />
          </Frame>
        </Demo>
        <Demo caption="A new project: nothing to count, and the create button stays secondary until the first bucket exists.">
          <Frame>
            <InstrumentBar headingLevel={3} title="Storage" create={{ label: 'New bucket' }} />
            <EmptyPanel
              headingLevel={4}
              title="No buckets yet"
              sentence="Your agent creates a bucket when your app needs to store files."
              requests={['Add a public avatars bucket and let each user upload their own picture.']}
              agent={{ status: 'disconnected' }}
              docs={{ label: 'Storage docs', slug: 'storage' }}
            />
          </Frame>
        </Demo>
        <Demo caption="Loading: the title stays, the facts wait; refresh spins while a read is in flight.">
          <Frame>
            <InstrumentBar
              headingLevel={3}
              title="Auth & Users"
              loading
              tabs={[
                { id: 'users', label: 'Users' },
                { id: 'methods', label: 'Sign-in methods' },
                { id: 'emails', label: 'Emails' },
              ]}
              activeTab="users"
              onTab={() => {}}
              onRefresh={() => {}}
              refreshing
            />
            <RowSkeleton rows={3} lead="actor" />
          </Frame>
        </Demo>
        <Demo caption="Realtime: a page control of its own (Clear) sits before refresh; long titles truncate.">
          <Frame>
            <InstrumentBar
              headingLevel={3}
              title="Realtime"
              facts={[{ glyph: 'live', label: 'Connected', text: '2 tables streaming' }, { text: '4 online' }]}
              freshness={now - 3_000}
              controls={
                <KitButton size="sm" variant="ghost">
                  Clear
                </KitButton>
              }
            />
          </Frame>
        </Demo>
      </Stack>
    </Section>
  )
}

// ─── Pane toolbar, chips, footer ─────────────────────────────────────────────

function PaneToolbarSection({ now }: { now: number }) {
  const [q, setQ] = useState('')
  const [view, setView] = useState<'data' | 'structure'>('data')
  const [page, setPage] = useState(1)
  const [applied, setApplied] = useState<string[]>(['rating', 'sort'])
  const chips: Chip[] = [
    { id: 'rating', label: <><code className="font-mono">rating</code> = 5</>, name: 'filter rating equals 5' },
    { id: 'sort', label: <>Sorted by <code className="font-mono">created_at</code>, newest first</>, name: 'sort by created_at' },
  ]
    .filter((c) => applied.includes(c.id))
    .map((c) => ({ ...c, onRemove: () => setApplied((a) => a.filter((x) => x !== c.id)) }))
  const [loadingMore, setLoadingMore] = useState(false)
  return (
    <Section
      id="pane-toolbar"
      title="Pane toolbar, filter chips, grid footer"
      description={
        <>
          <Path>PaneToolbar</Path>, <Path>ChipStrip</Path>, <Path>GridFooter</Path> in components/console/InstrumentBar.tsx. One 44px toolbar per pane: the object and its count, ⋯, search, filter, view switch, the object&apos;s add or test action. Chips only while a filter is applied.
        </>
      }
    >
      <Stack>
        <Demo caption="A table pane: filters applied, pages below.">
          <Frame>
            <PaneToolbar
              headingLevel={3}
              title="movies"
              mono
              count={`${count(1284)} rows`}
              menu={[
                { label: 'Copy name', onClick: () => {} },
                { label: 'Copy API URL', onClick: () => {} },
                { separator: true },
                { label: 'Delete table…', icon: Trash2, danger: true, onClick: () => {} },
              ]}
              search={{ value: q, onChange: setQ, placeholder: 'Search rows' }}
              filter={
                <KitButton size="sm" icon={Filter} onClick={() => setApplied(['rating', 'sort'])}>
                  Filter
                </KitButton>
              }
              view={{
                value: view,
                onChange: setView,
                label: 'View',
                options: [
                  { value: 'data', label: 'Data' },
                  { value: 'structure', label: 'Structure' },
                ],
              }}
              action={
                <KitButton size="sm" icon={Plus}>
                  Insert row
                </KitButton>
              }
            />
            <ChipStrip chips={chips} onClearAll={() => setApplied([])} />
            <DemoGrid />
            <GridFooter
              mode="pages"
              from={(page - 1) * 50 + 1}
              to={Math.min(page * 50, 1284)}
              total={1284}
              page={page}
              pages={26}
              onPrev={() => setPage((p) => Math.max(1, p - 1))}
              onNext={() => setPage((p) => Math.min(26, p + 1))}
            />
          </Frame>
        </Demo>
        <Demo caption="A function's runs: the object in mono, a view switch and its test action; Load more under the list.">
          <Frame>
            <PaneToolbar
              headingLevel={3}
              title="recommend-movies"
              mono
              menu={[
                { label: 'Copy endpoint URL', onClick: () => {} },
                { label: 'Turn off', onClick: () => {} },
                { separator: true },
                { label: 'Delete…', icon: Trash2, danger: true, onClick: () => {} },
              ]}
              view={{
                value: 'runs' as 'runs' | 'code',
                onChange: () => {},
                label: 'Show',
                options: [
                  { value: 'runs', label: 'Runs' },
                  { value: 'code', label: 'Code' },
                ],
              }}
              action={
                <KitButton size="sm" icon={Play}>
                  Test run
                </KitButton>
              }
            />
            <EventList label="Runs">
              <EventRow glyph="done" glyphLabel="Succeeded" time={now - 2 * MIN} result="60 ms" line="user 506a28c4: picks=20 genres=1" lineMono />
              <EventRow glyph="done" glyphLabel="Succeeded" time={now - 9 * MIN} result="48 ms" line="user 1f9e02aa: picks=20 genres=3" lineMono />
            </EventList>
            <GridFooter
              mode="more"
              shown={50}
              hasMore
              note="Showing the last 50"
              loading={loadingMore}
              onLoadMore={() => {
                setLoadingMore(true)
                setTimeout(() => setLoadingMore(false), 900)
              }}
            />
          </Frame>
        </Demo>
        <Demo caption="A long object name truncates; the count and ⋯ stay.">
          <Frame>
            <PaneToolbar
              headingLevel={3}
              title="user_notification_preferences_archive_before_the_2025_migration"
              mono
              count={`${count(18_641)} rows`}
              menu={[{ label: 'Copy name', onClick: () => {} }]}
              onRefresh={() => {}}
            />
          </Frame>
        </Demo>
      </Stack>
    </Section>
  )
}

function DemoGrid() {
  const cols = 'grid grid-cols-[40px_minmax(0,1.3fr)_minmax(0,1.2fr)_96px] sm:grid-cols-[44px_minmax(0,1.1fr)_minmax(0,1.3fr)_112px_minmax(0,1fr)]'
  return (
    <div role="table" aria-label="movies" className="text-[12.5px] leading-[18px]">
      <div role="row" className={`${cols} border-b ${RULE} bg-[#0e0f11] text-faint`}>
        {['#', 'id', 'title', 'release_year', 'genre_id'].map((h, i) => (
          <span key={h} role="columnheader" className={`truncate px-[12px] py-[8px] font-mono text-[12px] ${i === 4 ? 'hidden sm:block' : ''} ${i === 3 ? 'text-right' : ''}`}>
            {h}
          </span>
        ))}
      </div>
      {MOVIES.map((m, i) => (
        <div key={m.id} role="row" className={`${cols} border-b ${RULE} last:border-b-0`}>
          <span role="cell" className="px-[12px] py-[8px] tabular-nums text-faint">
            {i + 1}
          </span>
          <span role="cell" className="truncate px-[12px] py-[8px] font-mono text-[12px] text-zinc-300" title={m.id}>
            {m.id}
          </span>
          <span role="cell" className="truncate px-[12px] py-[8px] text-zinc-100">
            {m.title}
          </span>
          <span role="cell" className="px-[12px] py-[8px] text-right tabular-nums text-zinc-300">
            {m.year}
          </span>
          <span role="cell" className="hidden truncate px-[12px] py-[8px] font-mono text-[12px] text-zinc-300 sm:block">
            {m.genre}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── Record drawer ───────────────────────────────────────────────────────────

const USERS = [
  { id: 'u_1', email: 'maya.krishnan@example.com', name: 'Maya Krishnan', method: 'Google', signedUp: 9 * D, active: 2 * H, verified: true },
  { id: 'u_2', email: 'leo@example.com', name: 'Leo Brandt', method: 'Email and password', signedUp: 7 * D, active: 26 * H, verified: true },
  { id: 'u_3', email: 'priya.nair.with.a.long.address@studio-example.co.uk', name: 'Priya Nair', method: 'GitHub', signedUp: 6 * D, active: 40 * MIN, verified: true },
  { id: 'u_4', email: 'sam@example.com', name: '', method: 'Magic link', signedUp: 3 * D, active: 3 * D, verified: false },
  { id: 'u_5', email: 'ana.souza@example.com', name: 'Ana Souza', method: 'Google', signedUp: 2 * D, active: 5 * H, verified: true },
  { id: 'u_6', email: 'kenji@example.com', name: 'Kenji Mori', method: 'Email and password', signedUp: 20 * H, active: 12 * MIN, verified: true },
]

function DrawerSection({ now }: { now: number }) {
  const [userId, openUser, closeUser] = useRecordParam('record')
  const nav = recordNav(USERS, (u) => u.id, userId, openUser)
  const [mode, setMode] = useState<'loaded' | 'loading'>('loaded')
  const u = nav.item
  return (
    <Section
      id="record-drawer"
      title="Record drawer"
      description={
        <>
          <Path>RecordDrawer</Path>, <Path>useRecordParam</Path>, <Path>recordNav</Path> in components/console/RecordDrawer.tsx. Open a user: the list stays usable, ↑ and ↓ move, Esc closes, the URL keeps <Path>?record=</Path>.
        </>
      }
      aside={
        <Segmented
          size="sm"
          label="Drawer content"
          value={mode}
          onChange={(v) => setMode(v)}
          options={[
            { value: 'loaded', label: 'Loaded' },
            { value: 'loading', label: 'Loading' },
          ]}
        />
      }
    >
      <Panel>
        <ul className="divide-y divide-white/[0.06]">
          {USERS.map((x) => {
            const on = x.id === userId
            return (
              <li key={x.id} aria-current={on || undefined} className={on ? 'bg-white/[0.04]' : 'transition-colors duration-150 hover:bg-[#121316]'}>
                <button
                  type="button"
                  onClick={() => openUser(x.id)}
                  className="flex w-full items-center gap-[12px] px-[20px] py-[11px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70"
                >
                  <ActorMark actor={{ type: 'person', label: x.name || x.email }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium leading-[20px] text-zinc-100">{x.email}</span>
                    <span className="block truncate text-[12.5px] leading-[18px] text-faint">{x.method}</span>
                  </span>
                  <span className="hidden w-[132px] text-right text-[12.5px] text-faint sm:block">
                    <Time iso={now - x.active} prefix="Active" />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </Panel>
      <RecordDrawer
        open={!!u}
        onClose={closeUser}
        title={u?.email ?? ''}
        label={u?.email}
        subtitle={u ? <code className="font-mono text-[12px]">{u.id}</code> : null}
        facts={
          u ? (
            <Facts className="!mt-[8px]">
              <Fact>Signed up <Time iso={now - u.signedUp} mode="date" /></Fact>
              <Fact>
                <Time iso={now - u.active} prefix="Active" />
              </Fact>
            </Facts>
          ) : null
        }
        onPrev={nav.onPrev}
        onNext={nav.onNext}
        position={nav.position}
        loading={mode === 'loading'}
        footer={
          <>
            <KitButton variant="danger" icon={Trash2} className="mr-auto">
              Delete user
            </KitButton>
            <KitButton>Send password reset</KitButton>
          </>
        }
      >
        {u && (
          <dl className="divide-y divide-white/[0.06] text-[13px] leading-[20px]">
            {[
              ['Name', u.name || 'Not set'],
              ['Signs in with', u.method],
              ['Email', u.verified ? 'Verified' : 'Not verified'],
            ].map(([k, v]) => (
              <div key={k} className="grid grid-cols-[120px_minmax(0,1fr)] gap-[12px] py-[10px] first:pt-0">
                <dt className="text-faint">{k}</dt>
                <dd className="text-zinc-200 [overflow-wrap:anywhere]">{v}</dd>
              </div>
            ))}
            <div className="py-[10px]">
              <dt className="mb-[6px] text-faint">User id</dt>
              <dd>
                <CopyField value={`${u.id}-6a1f2c9e-41b7-4d2e-9c55-0b7e3f1a8d22`} label="Copy user id" />
              </dd>
            </div>
            <div className="pt-[10px]">
              <dt className="mb-[6px] text-faint">Next sign-in</dt>
              <dd>
                <KitCheckbox checked={false} onChange={() => {}} label="Require a new password at next sign-in" />
              </dd>
            </div>
          </dl>
        )}
      </RecordDrawer>
    </Section>
  )
}

// ─── First run ───────────────────────────────────────────────────────────────

function FirstRunSection() {
  return (
    <Section
      id="first-run"
      title="First run"
      description={
        <>
          <Path>FirstRun</Path> in components/console/FirstRun.tsx. The first page of Database, Auth &amp; Users, Storage, Functions and Realtime before the agent builds there: the page&apos;s outline, what it holds, the request, then Connect agent until an agent connects. The outline builds in once and holds still.
        </>
      }
    >
      <Stack>
        <Demo caption="Database, agent not connected, an owner: Connect agent beside the docs.">
          <Frame>
            <FirstRun
              headingLevel={3}
              picture="tables"
              title="No tables yet"
              sentence="Your agent creates the tables your app needs, each with REST endpoints and row-level security."
              requests={['Add a products table with a name, a price in cents and a stock count. Anyone can read it; only admins can write.']}
              projectId="p_movie"
              agent={{ status: 'disconnected' }}
              docs={{ label: 'Database docs', slug: 'database' }}
            />
          </Frame>
        </Demo>
        <Demo caption="Functions, Claude Code connected: the request is addressed to it, and Connect agent is gone.">
          <Frame>
            <FirstRun
              headingLevel={3}
              picture="functions"
              title="No functions yet"
              sentence="Endpoints, scheduled jobs and code that runs when data changes. Your agent writes them, and they go live without a deploy."
              requests={['When a user signs up, send them a welcome email.']}
              projectId="p_movie"
              agent={{ status: 'connected', client: 'Claude Code' }}
              docs={{ label: 'Functions docs', slug: 'functions' }}
            />
          </Frame>
        </Demo>
        <Demo caption="Auth & Users, a developer who cannot connect an agent: told who can.">
          <Frame>
            <FirstRun
              headingLevel={3}
              picture="users"
              title="No users yet"
              sentence="People who sign up through your app appear here, with how they signed in and when they were last active."
              requests={['Add email and password sign-up and sign-in to the app, with password reset.']}
              projectId="p_movie"
              agent={{ status: 'disconnected' }}
              canConnect={false}
              docs={{ label: 'Auth docs', slug: 'auth' }}
            />
          </Frame>
        </Demo>
        <div className="grid gap-[16px] lg:grid-cols-2">
          <Demo caption="Storage.">
            <Frame>
              <FirstRun
                headingLevel={3}
                picture="files"
                title="No buckets yet"
                sentence="Buckets hold your app’s files, each with its own read rule. Ask your agent for uploads and it creates the bucket."
                requests={['Add profile photo uploads: a private bucket, and only the owner can read their files.']}
                projectId="p_movie"
                agent={{ status: 'disconnected' }}
                docs={{ label: 'Storage docs', slug: 'storage' }}
              />
            </Frame>
          </Demo>
          <Demo caption="Realtime.">
            <Frame>
              <FirstRun
                headingLevel={3}
                picture="events"
                title="No table streams yet"
                sentence="Realtime is turned on per table, and changes to those tables appear here live."
                requests={['Turn on realtime for the tables my app shows live.']}
                projectId="p_movie"
                agent={{ status: 'disconnected' }}
                docs={{ label: 'Realtime docs', slug: 'realtime' }}
              />
            </Frame>
          </Demo>
        </div>
      </Stack>
    </Section>
  )
}

// ─── Empty panel ─────────────────────────────────────────────────────────────

function EmptyPanelSection() {
  return (
    <Section
      id="empty-panel"
      title="Empty panel"
      description={
        <>
          <Path>EmptyPanel</Path>, <Path>AskYourAgent</Path> in components/console/states.tsx. Top left of the real panel; the second sentence comes from the agent&apos;s connection and the person&apos;s role. No icon, tile, ghost or button. The five sections the agent builds into use First run instead, below.
        </>
      }
    >
      <Stack>
        <Demo caption="Database, agent not connected: the column heads stay above it.">
          <Frame>
            <div className={`grid grid-cols-[44px_1fr_1fr_1fr] border-b ${RULE} bg-[#0e0f11] px-0 text-[12px] leading-[16px] text-faint`}>
              {['#', 'id', 'name', 'created_at'].map((h) => (
                <span key={h} className="px-[12px] py-[8px] font-mono">
                  {h}
                </span>
              ))}
            </div>
            <EmptyPanel
              headingLevel={3}
              title="No tables yet"
              sentence="Your coding agent creates tables as it builds."
              requests={['Create a movies table with a title, a release year and a genre, and let anyone read it.']}
              agent={{ status: 'disconnected' }}
              docs={{ label: 'Database docs', slug: 'database' }}
            />
          </Frame>
        </Demo>
        <Demo caption="Functions, Claude Code connected: three requests, each with its own copy button.">
          <Panel>
            <EmptyPanel
              headingLevel={3}
              title="No functions yet"
              sentence="Endpoints, schedules and code that runs when data changes."
              requests={[
                'When a user signs up, send them a welcome email.',
                'Add POST /checkout that validates the cart and returns the order id.',
                'Every night at 2:00 AM UTC, delete sessions older than 30 days.',
              ]}
              agent={{ status: 'connected', client: 'Claude Code' }}
              docs={{ label: 'Functions docs', slug: 'functions' }}
            />
          </Panel>
        </Demo>
        <Demo caption="A viewer, who cannot connect an agent: told who can.">
          <Panel>
            <EmptyPanel
              headingLevel={3}
              title="No users yet"
              sentence="People who sign up through your app appear here."
              requests={['Add email and password sign-in, with a verification email.']}
              agent={{ status: 'disconnected' }}
              canConnect={false}
              docs={{ label: 'Auth docs', slug: 'auth' }}
            />
          </Panel>
        </Demo>
        <Demo caption="Made by hand (Webhooks): no requests. Operate pages show one real fact instead.">
          <div className="grid gap-[16px] lg:grid-cols-2">
            <Panel>
              <EmptyPanel
                headingLevel={3}
                title="No endpoints yet"
                sentence="Add a URL and Backenly sends it a signed POST when a row changes."
                docs={{ label: 'Webhooks docs', slug: 'webhooks' }}
              />
            </Panel>
            <Panel>
              <EmptyPanel headingLevel={3} title="No requests yet" sentence="Calls to your API show up here as they happen, with their status and time.">
                <CopyField value="https://ap-south-1.api.backenly.com/api/v1/p_movie" prefix="GET" label="Copy API URL" />
              </EmptyPanel>
            </Panel>
          </div>
        </Demo>
        <Demo caption="AskYourAgent on its own, with one long request.">
          <AskYourAgent
            requests={[
              'Add a reviews table linked to movies and users, with a 1 to 5 rating and an optional spoiler flag, and only let people edit their own reviews.',
            ]}
          />
        </Demo>
      </Stack>
    </Section>
  )
}

// ─── Error row ───────────────────────────────────────────────────────────────

function ErrorRowSection({ now }: { now: number }) {
  const [retrying, setRetrying] = useState(false)
  const retry = () => {
    setRetrying(true)
    setTimeout(() => setRetrying(false), 900)
  }
  return (
    <Section
      id="error-row"
      title="Error row"
      description={
        <>
          <Path>ErrorRow</Path>, <Path>RefusedLine</Path> in components/console/states.tsx. A failed first load replaces the rows (and clears stale ones); a failed refresh keeps them under one faint line; a refused action is said on its row, in the server&apos;s words.
        </>
      }
    >
      <Stack>
        <Demo caption="First load failed, and something still works.">
          <Panel>
            <ErrorRow things="tables" stillWorks="The SQL editor still works." onRetry={retry} retrying={retrying} />
          </Panel>
        </Demo>
        <Demo caption="First load failed.">
          <Panel>
            <ErrorRow things="function runs" onRetry={retry} retrying={retrying} />
          </Panel>
        </Demo>
        <Demo caption="A refresh failed: the rows stay, with how old they are.">
          <Panel>
            <ErrorRow things="functions" staleAt={now - 9 * MIN} onRetry={retry} retrying={retrying} />
            <RowList>
              <Row lead="glyph" glyph="live" glyphLabel="Ran fine" title={<p className={ROW_TITLE}>recommend-movies</p>}>
                <Facts>
                  <Fact>GET endpoint</Fact>
                  <Fact>{count(1_846)} runs</Fact>
                  <Fact>Last run 2 min ago</Fact>
                </Facts>
              </Row>
              <Row lead="glyph" glyph="idle" glyphLabel="Never run" title={<p className={ROW_TITLE}>nightly-digest</p>}>
                <Facts>
                  <Fact>Daily at 2:00 AM UTC</Fact>
                  <Fact>Never run</Fact>
                </Facts>
              </Row>
            </RowList>
          </Panel>
        </Demo>
        <Demo caption="A refused action, under the row it was asked from.">
          <Panel>
            <RowList>
              <Row
                lead="glyph"
                glyph="live"
                glyphLabel="Ran fine"
                title={<p className={ROW_TITLE}>recommend-movies</p>}
                actions={<OverflowMenu label="Actions for recommend-movies" items={[{ label: 'Delete function…', icon: Trash2, danger: true, onClick: () => {} }]} />}
              >
                <Facts>
                  <Fact>GET endpoint</Fact>
                  <Fact>Last run 2 min ago</Fact>
                </Facts>
                <RefusedLine className="mt-[8px]">Only owners and admins can delete functions.</RefusedLine>
              </Row>
            </RowList>
          </Panel>
        </Demo>
      </Stack>
    </Section>
  )
}

// ─── Events ──────────────────────────────────────────────────────────────────

function EventsSection({ now }: { now: number }) {
  const [open, setOpen] = useState<string | null>('r4')
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id))
  const runs = [
    { id: 'r1', at: now - 2 * MIN, fn: 'recommend-movies', ms: 60, ok: true, line: 'user 506a28c4: picks=20 genres=1' },
    { id: 'r2', at: now - 9 * MIN, fn: 'on-review-created', ms: 412, ok: true, line: 'review 7c1e09d2: recomputed movie average 4.2' },
    { id: 'r3', at: now - 3 * H, fn: 'nightly-digest', ms: 3_210, ok: true, line: 'sent 19 digests, skipped 2 without email' },
    {
      id: 'r4',
      at: now - 1 * D - 2 * H,
      fn: 'send-welcome-email',
      ms: 214,
      ok: false,
      line: 'Resend error: Too many requests. You can only make 2 requests per second. See rate limits in the Resend dashboard.',
    },
    { id: 'r5', at: now - 1 * D - 5 * H, fn: 'send-welcome-email', ms: 188, ok: true, line: 'sent welcome email to user 1f9e02aa' },
  ]
  const days = groupByDay(runs, (r) => r.at, { now })
  return (
    <Section
      id="events"
      title="Event rows"
      description={
        <>
          <Path>EventRow</Path>, <Path>DayGroup</Path>, <Path>CodeWell</Path> in components/console/EventRow.tsx. One row shape for something that happened: glyph, time, what, result, first line. Success is the glyph alone; the row expands in place into a flush code well.
        </>
      }
    >
      <Stack>
        <Demo caption="Function runs by day. A failed run expanded.">
          <Panel>
            <DayGroupList>
              {days.map((d) => (
                <DayGroup key={d.key} label={d.label}>
                  {d.items.map((r) => (
                    <EventRow
                      key={r.id}
                      glyph={r.ok ? 'done' : 'failed'}
                      glyphLabel={r.ok ? 'Succeeded' : 'Failed'}
                      time={r.at}
                      what={r.fn}
                      mono
                      result={duration(r.ms)}
                      line={r.line}
                      lineMono={r.ok}
                      expanded={open === r.id}
                      onToggle={() => toggle(r.id)}
                    >
                      <CodeWell label="Output" copy={`${r.line}\n`}>
                        {r.ok
                          ? `${r.line}\nreturned 200 in ${duration(r.ms)}`
                          : `POST https://api.resend.com/emails\n429 Too Many Requests\n${r.line}\n\nThe welcome email for user 9c41d2e0 was not sent.`}
                      </CodeWell>
                    </EventRow>
                  ))}
                </DayGroup>
              ))}
            </DayGroupList>
          </Panel>
        </Demo>
        <Demo caption="Webhook deliveries on an endpoint's page: words only for Retrying and Gave up; one action on its own.">
          <Panel>
            <DayGroupList>
              <DayGroup label="Today">
                <EventRow glyph="done" glyphLabel="Delivered" time={now - 4 * MIN} result="200" columns={{ result: 48 }} />
                <EventRow
                  glyph="busy"
                  glyphLabel="Retrying"
                  word="Retrying"
                  time={now - 8 * MIN}
                  result="500"
                  columns={{ result: 48 }}
                  line={<>3 attempts, next at <Time iso={now + 6 * MIN} mode="clock" /></>}
                  expanded={open === 'd2'}
                  onToggle={() => toggle('d2')}
                >
                  <CodeWell label="Response" copy={'{"error":"internal_error","message":"Cannot read properties of null (reading \'trim\')"}'}>
                    {'{"error":"internal_error","message":"Cannot read properties of null (reading \'trim\')"}'}
                  </CodeWell>
                </EventRow>
                <EventRow
                  glyph="failed"
                  glyphLabel="Failed"
                  word="Gave up"
                  time={now - 70 * MIN}
                  result="503"
                  columns={{ result: 48 }}
                  line="after 5 attempts"
                  action={
                    <KitButton size="sm" variant="secondary">
                      Send again
                    </KitButton>
                  }
                />
              </DayGroup>
            </DayGroupList>
          </Panel>
        </Demo>
        <Demo caption="Requests: no glyph, the path in mono.">
          <Panel>
            <EventList label="Requests">
              <EventRow time={now - 20_000} what="GET /movies?order=year" mono result="200" line="60 ms" columns={{ what: 260, result: 48 }} />
              <EventRow time={now - 61_000} what="POST /fn/checkout" mono result="201" line="212 ms" columns={{ what: 260, result: 48 }} />
              <EventRow time={now - 95_000} what="GET /reviews?movie_id=eq.m0000001-4c1e-4f7a-9d21-2b7e5c1a9f10" mono result="404" line="18 ms" columns={{ what: 260, result: 48 }} />
            </EventList>
          </Panel>
        </Demo>
        <div className="grid gap-[16px] lg:grid-cols-3">
          <Demo caption="Loading">
            <Panel>
              <EventRowSkeleton rows={4} />
            </Panel>
          </Demo>
          <Demo caption="Empty">
            <Panel>
              <EmptyPanel headingLevel={3} title="No runs yet" sentence="Runs show up here as your functions are called." />
            </Panel>
          </Demo>
          <Demo caption="Error">
            <Panel>
              <ErrorRow things="function runs" onRetry={() => {}} />
            </Panel>
          </Demo>
        </div>
      </Stack>
    </Section>
  )
}

// ─── Actors ──────────────────────────────────────────────────────────────────

function ActorsSection({ now }: { now: number }) {
  const changes = [
    {
      id: 'c48',
      actor: { type: 'agent' as const, label: 'Claude Code' },
      summary: 'Created table reviews. Created bucket review-photos and secret REVIEWS_ENABLED',
      parts: 'Database, Storage, Secrets',
      seq: 48,
      at: now - 12 * MIN,
      outcome: <Outcome glyph="done" label="Verified" />,
    },
    {
      id: 'c47',
      actor: { type: 'person' as const, label: "Adarsh Jose, approving Claude Code's request" },
      summary: 'Dropped column spoilers on reviews',
      parts: 'Database',
      seq: 47,
      at: now - 50 * MIN,
      outcome: <Outcome glyph="waiting" label="Waiting on you" show />,
    },
    {
      id: 'c46',
      actor: { type: 'system' as const, label: 'Backenly' },
      summary: 'Added an index on watchlist_items (movie_id)',
      parts: 'Database',
      seq: 46,
      at: now - 5 * H,
      outcome: <Outcome label="Recovered automatically" show />,
    },
  ]
  return (
    <Section
      id="actors"
      title="Actor marks and outcomes"
      description={
        <>
          <Path>ActorMark</Path>, <Path>ActorWords</Path>, <Path>Outcome</Path> in components/console/ActorMark.tsx, for History, Overview&apos;s Recent changes and Connect&apos;s tool calls. A healthy outcome is the glyph alone.
        </>
      }
      aside={
        <span aria-hidden className="flex items-center gap-[10px]">
          {([20, 24, 28] as const).map((s) => (
            <ActorMark key={s} size={s} actor={{ type: 'person', label: 'Adarsh' }} />
          ))}
          <ActorMark actor={{ type: 'agent', label: 'Claude Code' }} />
          <ActorMark actor={{ type: 'system', label: 'Backenly' }} />
        </span>
      }
    >
      <Panel>
        <DayGroup label="Today">
          {changes.map((c) => (
            <li key={c.id} className="relative transition-colors hover:bg-white/[0.025]">
              <div className="grid grid-cols-[24px_minmax(0,1fr)] items-start gap-x-[12px] px-[16px] py-[12px] sm:grid-cols-[24px_minmax(0,1fr)_auto] sm:px-[20px]">
                <ActorMark actor={c.actor} className="mt-[-1.5px]" />
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium leading-[21px] text-zinc-50 [overflow-wrap:anywhere]">{c.summary}</span>
                  <span className="mt-[2px] flex flex-wrap items-center gap-x-[14px] gap-y-[2px] text-[12.5px] leading-[18px] text-faint">
                    <ActorWords label={c.actor.label} />
                    <span>{c.parts}</span>
                    <span className="tabular-nums">#{c.seq}</span>
                  </span>
                </span>
                <span className="col-start-2 mt-[6px] flex items-center gap-[14px] sm:col-start-3 sm:mt-0 sm:pt-[2px]">
                  {c.outcome}
                  <span className="text-[12.5px] text-faint">
                    <Time iso={c.at} mode="clock" />
                  </span>
                </span>
              </div>
            </li>
          ))}
        </DayGroup>
      </Panel>
    </Section>
  )
}

// ─── Row leads ───────────────────────────────────────────────────────────────

function RowLeadsSection() {
  return (
    <Section
      id="row-leads"
      title="Row leads"
      description={
        <>
          <Path>{'<Row lead>'}</Path> in components/autonomy/rows.tsx: whatever varies down the list leads it. <Path>glyph</Path> a state, <Path>actor</Path> who did it, <Path>icon</Path> a bare kind icon, <Path>none</Path>. No lead keeps the retired 32px tile for old rows.
        </>
      }
    >
      <Stack>
        <Panel>
          <RowList>
            <Row
              lead="glyph"
              glyph="failed"
              glyphLabel="Failed"
              title={
                <p className={ROW_TITLE}>
                  send-welcome-email <span className="ml-[6px] text-[12.5px] font-medium text-rose-300">Failed</span>
                </p>
              }
              actions={<OverflowMenu label="Actions for send-welcome-email" items={[{ label: 'Open runs', onClick: () => {} }, { label: 'Turn off', onClick: () => {} }]} />}
            >
              <Facts>
                <Fact>On sign-up</Fact>
                <Fact>Last run 1 d ago</Fact>
              </Facts>
            </Row>
            <Row lead="actor" actor={{ type: 'agent', label: 'Claude Code' }} title={<p className={ROW_TITLE}>Called create_table</p>}>
              <Facts>
                <Fact>Claude Code</Fact>
                <Fact>Created table reviews with 6 columns</Fact>
              </Facts>
            </Row>
            <Row lead="icon" icon={FileImage} title={<p className={ROW_TITLE}>poster-past-lives.jpg</p>}>
              <Facts>
                <Fact>412 KB</Fact>
                <Fact>image/jpeg</Fact>
              </Facts>
            </Row>
            <Row lead="icon" icon={FileArchive} title={<p className={ROW_TITLE}>backup-2026-11-14.tar.gz</p>}>
              <Facts>
                <Fact>48.2 MB</Fact>
              </Facts>
            </Row>
            <Row lead="none" title={<p className={ROW_TITLE}>Every table</p>}>
              <p className={ROW_TEXT}>
                A row that leads with nothing, because nothing varies down its list. Long text wraps instead of being cut: the description of a webhook endpoint that listens for every insert, update and delete on every table in the public schema.
              </p>
            </Row>
            <Row icon={FileText} tone="neutral" title={<p className={ROW_TITLE}>The old default: a 32px tile</p>}>
              <p className={ROW_TEXT}>Kept so the Autonomy rows that still pass only an icon do not change. Retired for new rows.</p>
            </Row>
          </RowList>
        </Panel>
        <div className="grid gap-[16px] lg:grid-cols-2">
          <Demo caption="Loading: row-shaped placeholders in the same anatomy.">
            <Panel>
              <RowSkeleton rows={3} lead="glyph" />
            </Panel>
          </Demo>
          <Demo caption="A menu on a clipped panel's last row opens past its edge (it is drawn in a portal).">
            <Panel>
              <RowList>
                <Row
                  lead="icon"
                  icon={Inbox}
                  title={<p className={ROW_TITLE}>Last row with a menu</p>}
                  actions={
                    <OverflowMenu
                      label="Actions for the last row"
                      items={[
                        { label: 'Open', onClick: () => {} },
                        { label: 'Copy link', onClick: () => {} },
                        { label: 'Mark as read', onClick: () => {} },
                        { separator: true },
                        { label: 'Delete…', icon: Trash2, danger: true, onClick: () => {} },
                      ]}
                    />
                  }
                />
              </RowList>
            </Panel>
          </Demo>
          <Demo caption="EmptyLine, now without its tile: a panel's one line when there is nothing in it.">
            <Panel>
              <EmptyLine>Nothing is waiting on you.</EmptyLine>
            </Panel>
          </Demo>
        </div>
      </Stack>
    </Section>
  )
}

// ─── Checkbox and radio ──────────────────────────────────────────────────────

function ChoicesSection() {
  const [a, setA] = useState(true)
  const [b, setB] = useState(false)
  const [rows, setRows] = useState<Record<string, boolean>>({ m1: true, m2: false, m3: true })
  const all = Object.values(rows).every(Boolean)
  const some = Object.values(rows).some(Boolean)
  const [vis, setVis] = useState('private')
  return (
    <Section
      id="choices"
      title="Checkbox and radio"
      description={
        <>
          <Path>KitCheckbox</Path>, <Path>KitRadio</Path> from components/inspector/kit (built in components/console/controls.tsx). White, never violet; the native input is the 28px hit target.
        </>
      }
    >
      <div className="grid gap-[16px] lg:grid-cols-2">
        <Panel className="space-y-[16px] p-[20px]">
          <KitCheckbox checked={a} onChange={setA} label="Nullable" description="Rows may leave this column empty." />
          <KitCheckbox checked={b} onChange={setB} label="Unique" description="No two rows may have the same value." />
          <KitCheckbox checked disabled onChange={() => {}} label="Primary key" description="Set when the table was created." />
          <div className={`overflow-hidden ${R_PANEL} border ${EDGE}`}>
            <div className={`flex items-center gap-[12px] border-b ${RULE} bg-[#0e0f11] px-[14px] py-[6px] text-[12px] text-faint`}>
              <KitCheckbox
                checked={all}
                indeterminate={some && !all}
                onChange={(v) => setRows({ m1: v, m2: v, m3: v })}
                aria-label="Select all rows"
              />
              <span className="font-mono">title</span>
            </div>
            {[
              ['m1', 'Past Lives'],
              ['m2', 'Aftersun'],
              ['m3', 'Perfect Days'],
            ].map(([id, t]) => (
              <div key={id} className={`flex items-center gap-[12px] border-b ${RULE} px-[14px] py-[6px] text-[13px] text-zinc-200 last:border-b-0`}>
                <KitCheckbox checked={rows[id]} onChange={(v) => setRows((r) => ({ ...r, [id]: v }))} aria-label={`Select ${t}`} />
                {t}
              </div>
            ))}
          </div>
        </Panel>
        <Panel className="p-[20px]">
          <div role="radiogroup" aria-labelledby="kit-vis" className="space-y-[14px]">
            <p id="kit-vis" className="text-[12.5px] font-medium leading-[18px] text-zinc-300">
              Who can read files in this bucket
            </p>
            <KitRadio name="kit-vis" value="private" checked={vis === 'private'} onChange={setVis} label="Only signed-in owners" description="Each file is readable by the user who uploaded it." />
            <KitRadio name="kit-vis" value="public" checked={vis === 'public'} onChange={setVis} label="Anyone with the link" description="Files are served from a public URL." />
            <KitRadio name="kit-vis" value="signed" checked={vis === 'signed'} onChange={setVis} label="Signed links only" description="Links expire after an hour." />
            <KitRadio name="kit-vis" value="team" checked={false} disabled onChange={setVis} label="Your team only" description="Comes with Pro." />
          </div>
        </Panel>
      </div>
    </Section>
  )
}

// ─── Confirm dialog ──────────────────────────────────────────────────────────

type DialogId = 'delete-function' | 'drop-table' | 'empty-bucket' | 'delete-project' | 'secret'

function useDialog(): [DialogId | null, (d: DialogId | null) => void] {
  const search = useSearchParams()
  const initial = (search?.get('dialog') as DialogId | null) ?? null
  const [open, setOpen] = useState<DialogId | null>(initial)
  return [open, setOpen]
}

function ConfirmSection() {
  const [open, setOpen] = useDialog()
  const [busy, setBusy] = useState(false)
  const done = () => {
    setBusy(true)
    setTimeout(() => {
      setBusy(false)
      setOpen(null)
    }, 700)
  }
  const close = () => setOpen(null)
  return (
    <Section
      id="confirm"
      title="Confirm dialog"
      description={
        <>
          <Path>KitConfirmDialog</Path> gains <Path>undoable</Path> (decision 8&apos;s sentence, from components/console/undo.ts), <Path>lost</Path> and <Path>requireText</Path>.
        </>
      }
    >
      <Panel>
        <ul className="divide-y divide-white/[0.06]">
          {(
            [
              ['delete-function', 'Delete function', { detail: 'code and all' }],
              ['drop-table', 'Drop table', { days: 7, detail: 'rows included' }],
              ['empty-bucket', 'Delete files', false],
              ['delete-project', 'Delete project', false],
            ] as const
          ).map(([id, label, undo]) => (
            <li key={id} className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px] px-[20px] py-[12px]">
              <span className="min-w-0 flex-1 text-[13px] leading-[20px] text-zinc-300">{undoSentence(undo)}</span>
              <KitButton size="sm" onClick={() => setOpen(id)}>
                {label}
              </KitButton>
            </li>
          ))}
        </ul>
      </Panel>
      <KitConfirmDialog
        open={open === 'delete-function'}
        onCancel={close}
        onConfirm={done}
        busy={busy}
        danger
        title="Delete recommend-movies?"
        description="It stops running now."
        undoable={{ detail: 'code and all' }}
        confirmLabel="Delete function"
      />
      <KitConfirmDialog
        open={open === 'drop-table'}
        onCancel={close}
        onConfirm={done}
        busy={busy}
        danger
        title="Drop table movies?"
        description="Its 1,284 rows and 2 indexes go with it."
        undoable={{ days: 7, detail: 'rows included' }}
        requireText="movies"
        confirmLabel="Drop table"
      />
      <KitConfirmDialog
        open={open === 'empty-bucket'}
        onCancel={close}
        onConfirm={done}
        busy={busy}
        danger
        title="Delete all files in review-photos?"
        undoable={false}
        lost="Its 240 files are deleted for good. The bucket stays."
        confirmLabel="Delete files"
      />
      <KitConfirmDialog
        open={open === 'delete-project'}
        onCancel={close}
        onConfirm={done}
        busy={busy}
        danger
        title="Delete movie reviews?"
        description="Its database, files, functions and keys are deleted, and apps using its API stop working."
        undoable={false}
        requireText="movie reviews"
        confirmLabel="Delete project"
      />
    </Section>
  )
}

// ─── Copy field ──────────────────────────────────────────────────────────────

function CopyFieldSection() {
  return (
    <Section
      id="copy-field"
      title="Copy field"
      description={
        <>
          <Path>CopyField</Path> in components/inspector/kit.tsx: <Path>prefix</Path>, <Path>masked</Path>, <Path>variant=&quot;inline&quot;</Path>, <Path>wrap</Path>, <Path>mono</Path>. Copy always copies the whole value.
        </>
      }
    >
      <Panel className="grid gap-[18px] p-[20px] lg:grid-cols-2">
        <Demo caption="Machine text, cut when long">
          <CopyField value="https://ap-south-1.api.backenly.com/api/v1/p_movie/rest/movies?select=id,title,release_year" label="Copy URL" />
        </Demo>
        <Demo caption="With a method">
          <CopyField value="https://ap-south-1.api.backenly.com/api/v1/p_movie/fn/recommend-movies" prefix="GET" label="Copy endpoint URL" />
        </Demo>
        <Demo caption="Masked: Show reveals it, Copy copies it either way">
          <CopyField value="postgres://backenly_app_7f3c:Zq8v2LmN4tRb@db.ap-south-1.backenly.com:5432/p_movie" masked label="Copy connection string" />
        </Demo>
        <Demo caption="Wrapping a long value">
          <CopyField value="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwcm9qZWN0IjoicF9tb3ZpZSIsInJvbGUiOiJhbm9uIn0.4bX9Q2rT0uVw8yZ1aB3cD5eF7gH9iJ1kL3mN5oP7qR9" wrap label="Copy key" />
        </Demo>
        <Demo caption="Inline, in a row of facts">
          <Facts className="!mt-0">
            <Fact>Created Nov 12</Fact>
            <Fact>
              <CopyField variant="inline" value="fn_8c21e7a0" label="Copy function id" />
            </Fact>
            <Fact>
              <CopyField variant="inline" value="ap-south-1" label="Copy region" />
            </Fact>
          </Facts>
        </Demo>
        <Demo caption="Words, not machine text">
          <CopyField value="Mumbai, India" mono={false} label="Copy region name" />
        </Demo>
      </Panel>
    </Section>
  )
}

// ─── Secret once ─────────────────────────────────────────────────────────────

function SecretSection() {
  const [open, setOpen] = useDialog()
  return (
    <Section
      id="secret-once"
      title="Secret once"
      description={
        <>
          <Path>SecretOnceDialog</Path> in components/console/SecretOnceDialog.tsx: a new key or signing secret, shown in full once.
        </>
      }
    >
      <Panel>
        <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px] px-[20px] py-[12px]">
          <span className="min-w-0 flex-1 text-[13px] leading-[20px] text-zinc-300">A new API key for the mobile app.</span>
          <KitButton size="sm" icon={Plus} onClick={() => setOpen('secret')}>
            Create key
          </KitButton>
        </div>
      </Panel>
      <SecretOnceDialog
        open={open === 'secret'}
        onClose={() => setOpen(null)}
        title="API key for mobile app"
        value="bk_live_7f3c9a1e2b4d6f8a0c2e4f6a8b0d2f4a6c8e0a2b"
        copyLabel="Copy key"
      >
        Set it as <code className="font-mono text-[12px] text-zinc-300">BACKENLY_API_KEY</code> in your app&apos;s environment.
      </SecretOnceDialog>
    </Section>
  )
}
