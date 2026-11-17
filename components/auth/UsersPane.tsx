'use client'

/**
 * The people who sign into the app: a grid you scan and search, with one
 * person open in a drawer beside it (project decision 6).
 *
 * Search and pages are the server's (/api/auth/users?search=&page=): it used
 * to read up to 5,000 users into the browser and filter them there, so a
 * large project searched only what had loaded.
 *
 * Blocking uses the project's own row update on its `users` table, the column
 * sign-in already enforces, so no new route was needed for it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Ban, CheckCircle2 } from 'lucide-react'
import { GridFooter, PaneToolbar } from '@/components/console/InstrumentBar'
import { recordNav, RecordDrawer, useRecordParam } from '@/components/console/RecordDrawer'
import { ErrorRow, RefusedLine, type AgentState } from '@/components/console/states'
import { FirstRun } from '@/components/console/FirstRun'
import { Time } from '@/components/console/Time'
import { formatTime } from '@/components/console/format'
import { FOCUS, FOCUS_INSET, GRID_HEAD, RULE } from '@/components/console/tokens'
import { ActorMark } from '@/components/console/ActorMark'
import { CopyField, KIT, KitButton, KitConfirmDialog, Skeleton, Tag } from '@/components/inspector/kit'
import { fetchUsers, setBlocked, USERS_PAGE_SIZE, type AuthStats, type EndUser } from './api'
import { ProviderLabel } from './providers'

export function UsersPane({
  projectId,
  stats,
  canWrite,
  canConnect,
  agent,
  onChanged,
}: {
  projectId: string
  /** /api/auth/users/stats, for the toolbar's facts; null while unknown. */
  stats: AuthStats | null
  canWrite: boolean
  canConnect: boolean
  agent: AgentState | null
  /** Something changed (a block): read the counts again. */
  onChanged: () => void
}) {
  const [search, setSearch] = useState('')
  const [committed, setCommitted] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ users: EndUser[]; total: number; totalPages: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [staleAt, setStaleAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const readAt = useRef<number | null>(null)
  const seq = useRef(0)

  const load = useCallback(
    async (q: { page: number; search: string }, refresh = false) => {
      const mine = ++seq.current
      setLoading(true)
      try {
        const res = await fetchUsers(projectId, q)
        if (mine !== seq.current) return
        setData({ users: res.users, total: res.total, totalPages: res.totalPages })
        setFailed(false)
        setStaleAt(null)
        readAt.current = Date.now()
      } catch {
        if (mine !== seq.current) return
        if (refresh && readAt.current !== null) setStaleAt(readAt.current)
        else {
          setData(null)
          setFailed(true)
        }
      } finally {
        if (mine === seq.current) setLoading(false)
      }
    },
    [projectId],
  )

  useEffect(() => {
    void load({ page, search: committed })
  }, [load, page, committed])

  const committedRef = useRef('')
  useEffect(() => {
    const term = search.trim()
    const t = setTimeout(() => {
      if (term === committedRef.current) return
      committedRef.current = term
      setCommitted(term)
      setPage(1)
    }, term ? 300 : 0)
    return () => clearTimeout(t)
  }, [search])

  const refresh = async () => {
    setRefreshing(true)
    onChanged()
    await load({ page, search: committed }, true)
    setRefreshing(false)
  }

  // ── The drawer ─────────────────────────────────────────────────────────────
  const [userParam, openUser, closeUser] = useRecordParam('user')
  const users = data?.users ?? []
  const nav = recordNav(users, (u) => u.id, userParam, openUser)
  const user = nav.item
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const [confirmBlock, setConfirmBlock] = useState(false)
  const [seenUser, setSeenUser] = useState(userParam)
  if (seenUser !== userParam) {
    setSeenUser(userParam)
    setRefused(null)
  }

  const block = async (blocked: boolean) => {
    if (!user) return
    setBusy(true)
    setRefused(null)
    try {
      await setBlocked(projectId, user.id, blocked)
      setData((d) => (d ? { ...d, users: d.users.map((u) => (u.id === user.id ? { ...u, isBlocked: blocked } : u)) } : d))
      setConfirmBlock(false)
      onChanged()
    } catch (err) {
      setConfirmBlock(false)
      setRefused(err instanceof Error ? err.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  const statFacts = stats ? (
    <>
      <span className="hidden md:inline">{stats.activeUsers.toLocaleString('en-US')} active in 30 days</span>
      <span className="ml-[14px] hidden lg:inline">{stats.verifications.toLocaleString('en-US')} verified</span>
      <span className="ml-[14px] hidden md:inline">{stats.signups24h.toLocaleString('en-US')} new today</span>
    </>
  ) : null

  const empty = data && data.total === 0 && !committed
  const base = `/app/projects/${projectId}`

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {empty ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <FirstRun
            picture="users"
            title="No users yet"
            sentence="People who sign up through your app appear here, with how they signed in and when they were last active."
            requests={['Add email and password sign-up and sign-in to the app, with password reset.']}
            projectId={projectId}
            agent={agent}
            canConnect={canConnect}
            docs={{ label: 'Auth docs', slug: 'auth' }}
          />
        </div>
      ) : (
        <>
          <PaneToolbar
            title="All users"
            count={statFacts}
            search={{ value: search, onChange: setSearch, placeholder: 'Search by email or name' }}
            onRefresh={() => void refresh()}
            refreshing={refreshing}
          />
          {staleAt !== null && data && <ErrorRow things="users" staleAt={staleAt} onRetry={() => void load({ page, search: committed }, true)} retrying={loading} />}
          <div className="min-h-0 flex-1 overflow-auto">
            {!data ? (
              failed ? (
                <ErrorRow things="users" stillWorks="Sign-in methods and Email still work." onRetry={() => void load({ page, search: committed })} retrying={loading} />
              ) : (
                <UsersSkeleton />
              )
            ) : data.users.length === 0 ? (
              <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px] px-[16px] py-[14px] sm:px-[20px]">
                <p className="text-[13px] leading-[20px] text-zinc-400">No users match “{committed}”.</p>
                <KitButton size="sm" onClick={() => setSearch('')}>
                  Clear search
                </KitButton>
              </div>
            ) : (
              <table className={`w-full border-separate border-spacing-0 transition-opacity duration-150 ${loading ? 'opacity-60' : ''}`}>
                <thead className="sticky top-0 z-10">
                  <tr>
                    <th scope="col" className={`${TH} pl-[16px] sm:pl-[20px]`}>
                      User
                    </th>
                    <th scope="col" className={`${TH} hidden w-[150px] md:table-cell`}>
                      Sign-in
                    </th>
                    <th scope="col" className={`${TH} hidden w-[120px] md:table-cell`}>
                      Signed up
                    </th>
                    <th scope="col" className={`${TH} hidden w-[130px] pr-[20px] sm:table-cell`}>
                      Last active
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u) => {
                    const open = u.id === userParam
                    return (
                      <tr key={u.id} aria-current={open || undefined} onClick={() => openUser(u.id)} className={`cursor-pointer transition-colors duration-150 ${open ? 'bg-white/[0.05]' : KIT.rowHoverOn}`}>
                        <td className={`${TD} max-w-0 pl-[16px] sm:pl-[20px]`}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              openUser(u.id)
                            }}
                            className={`flex w-full min-w-0 items-center gap-[10px] rounded-[5px] py-[2px] text-left ${FOCUS_INSET}`}
                          >
                            <ActorMark actor={{ type: 'person', label: u.name || u.email }} size={24} />
                            <span className="min-w-0 flex-1">
                              <span className="flex min-w-0 items-center gap-[8px]">
                                <span className={`min-w-0 truncate text-[13px] ${open ? 'text-white' : 'text-zinc-100'}`}>{u.name || u.email}</span>
                                {u.isBlocked && <Tag>Blocked</Tag>}
                              </span>
                              {u.name && <span className="block truncate text-[12.5px] leading-[18px] text-faint">{u.email}</span>}
                              <span className="mt-[2px] flex gap-[12px] text-[12px] leading-[16px] text-faint md:hidden">
                                <ProviderLabel provider={u.provider} />
                                <span className="sm:hidden">{u.lastLogin ? <Time iso={u.lastLogin} /> : 'Never signed in'}</span>
                              </span>
                            </span>
                          </button>
                        </td>
                        <td className={`${TD} hidden text-[12.5px] text-zinc-300 md:table-cell`}>
                          <ProviderLabel provider={u.provider} />
                        </td>
                        <td className={`${TD} hidden text-[12.5px] text-faint md:table-cell`}>
                          <Time iso={u.createdAt} mode="date" />
                        </td>
                        <td className={`${TD} hidden pr-[20px] text-[12.5px] text-faint sm:table-cell`}>{u.lastLogin ? <Time iso={u.lastLogin} /> : 'Never'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
          {data && data.users.length > 0 && (
            <GridFooter
              mode="pages"
              from={(page - 1) * USERS_PAGE_SIZE + 1}
              to={Math.min(page * USERS_PAGE_SIZE, data.total)}
              total={data.total}
              page={page}
              pages={data.totalPages}
              onPrev={() => setPage((p) => Math.max(1, p - 1))}
              onNext={() => setPage((p) => Math.min(data.totalPages, p + 1))}
              busy={loading}
            />
          )}
        </>
      )}

      <RecordDrawer
        open={!!user}
        onClose={closeUser}
        title={user ? user.name || user.email : ''}
        label={user?.email}
        subtitle={user?.name ? user.email : undefined}
        facts={
          user ? (
            <div className="mt-[8px] flex flex-wrap gap-x-[16px] gap-y-[2px] text-[12.5px] leading-[18px] text-faint">
              <span>
                Signed up <Time iso={user.createdAt} mode="date" />
              </span>
              <span>{user.lastLogin ? <Time iso={user.lastLogin} prefix="Active" /> : 'Never signed in'}</span>
            </div>
          ) : null
        }
        onPrev={nav.onPrev}
        onNext={nav.onNext}
        position={nav.position}
        footer={
          user && canWrite ? (
            user.isBlocked ? (
              <KitButton icon={CheckCircle2} onClick={() => void block(false)} loading={busy}>
                Unblock user
              </KitButton>
            ) : (
              <KitButton icon={Ban} onClick={() => setConfirmBlock(true)} disabled={busy}>
                Block user
              </KitButton>
            )
          ) : undefined
        }
      >
        {user && (
          <div className="space-y-[16px]">
            {refused && <RefusedLine>{refused}</RefusedLine>}
            <dl className="divide-y divide-white/[0.06] text-[13px] leading-[20px]">
              <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-[12px] pb-[10px]">
                <dt className="text-faint">Sign-in</dt>
                <dd className="text-zinc-200">
                  <ProviderLabel provider={user.provider} />
                </dd>
              </div>
              {user.isBlocked && (
                <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-[12px] py-[10px]">
                  <dt className="text-faint">Status</dt>
                  <dd className="text-zinc-200">Blocked. They can&apos;t sign in.</dd>
                </div>
              )}
              <div className="py-[10px]">
                <dt className="mb-[6px] text-faint">User ID</dt>
                <dd>
                  <CopyField value={user.id} label="Copy user ID" />
                </dd>
              </div>
            </dl>
            <p className="flex flex-wrap gap-x-[16px] gap-y-[6px] text-[13px]">
              <Link href={`${base}/database?table=users&row=${encodeURIComponent(user.id)}`} className={LINK}>
                Open in Database
              </Link>
              <Link href={`${base}/monitoring?view=logs&type=auth&q=${encodeURIComponent(user.email)}`} className={LINK}>
                Sign-in logs
              </Link>
            </p>
          </div>
        )}
      </RecordDrawer>

      <KitConfirmDialog
        open={confirmBlock && !!user}
        onCancel={() => !busy && setConfirmBlock(false)}
        onConfirm={() => void block(true)}
        title={`Block ${user?.email ?? 'this user'}?`}
        description="They can't sign in until you unblock them."
        confirmLabel="Block user"
        danger
        busy={busy}
      />
    </div>
  )
}

const TH = `h-[36px] whitespace-nowrap border-b ${RULE} ${GRID_HEAD} px-[12px] text-left text-[12px] font-normal text-faint`
const TD = 'h-[48px] border-b border-white/[0.04] px-[12px] py-[6px]'
const LINK = `rounded-[3px] text-zinc-200 underline decoration-white/25 underline-offset-[3px] transition-colors duration-150 hover:text-white hover:decoration-white/60 ${FOCUS}`

function UsersSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading users">
      <div className={`h-[36px] border-b ${RULE} ${GRID_HEAD}`} />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div key={i} aria-hidden className="flex h-[48px] items-center gap-[12px] border-b border-white/[0.04] px-[20px]">
          <Skeleton className="h-[24px] w-[24px] flex-shrink-0 !rounded-full" />
          <Skeleton className={`h-[12px] ${i % 2 ? 'w-[180px]' : 'w-[240px]'}`} />
          <Skeleton className="ml-auto hidden h-[12px] w-[80px] md:block" />
        </div>
      ))}
    </div>
  )
}

/** "Nov 16, 2:09 PM", for words that are not on screen as a <Time>. */
export const when = (iso: string | null) => (iso ? formatTime(iso, 'dateTime') : 'never')
