'use client'

/**
 * Auth & Users: the people who sign into the app, how they sign in, and the
 * mail that signs them in.
 *
 *   Auth & Users  37 users   Users  Sign-in methods  Email
 *   All users  31 active in 30 days  4 new today           [Search by email or name] ⟳
 *   (T) Tomás Rivera                 G Google     Nov 16      1 h ago
 *
 * Users comes first, because looking someone up ("I can't log in") is the job
 * done most; setting up a provider is the one auth job the agent cannot do,
 * and Email is the mail that carries sign-in. The bar's count is the server's
 * total, never the number of rows loaded. Where you are is in the URL: ?tab=
 * (users, methods, email; an old ?tab=config opens methods) and ?user=.
 *
 * Runtime landmines this rides on (handled server-side by /api/auth/users):
 * the workspace users table is RLS-forced (service-role read path) and the
 * behavioural verifier can leak synthetic `.internal` users.
 */

import { useCallback, useEffect, useId, useState } from 'react'
import { InstrumentBar, type BarFact } from '@/components/console/InstrumentBar'
import { useRecordParam } from '@/components/console/RecordDrawer'
import { KIT } from '@/components/inspector/kit'
import { useAgentConnection } from '@/lib/hooks/useAgentConnection'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { fetchStats, type AuthStats } from './api'
import { SignInMethods } from './AuthConfiguration'
import { EmailSettingsPanel } from './EmailSettingsPanel'
import { UsersPane } from './UsersPane'

const TABS = [
  { id: 'users', label: 'Users' },
  { id: 'methods', label: 'Sign-in methods' },
  { id: 'email', label: 'Email' },
] as const
type Tab = (typeof TABS)[number]['id']

export function AuthWorkbench({ projectId }: { projectId: string }) {
  const role = useProjectRole(projectId)
  const agent = useAgentConnection(projectId)
  const panelId = useId()
  const [tabParam, openTab, closeTab] = useRecordParam('tab')
  const tab: Tab = tabParam === 'methods' || tabParam === 'config' ? 'methods' : tabParam === 'email' ? 'email' : 'users'

  // The server's own count (/api/auth/users/stats), for the bar and the toolbar's facts.
  const [stats, setStats] = useState<AuthStats | null>(null)
  const [statsFailed, setStatsFailed] = useState(false)
  const loadStats = useCallback(() => {
    fetchStats(projectId)
      .then((s) => {
        setStats(s)
        setStatsFailed(false)
      })
      .catch(() => setStatsFailed(true))
  }, [projectId])
  useEffect(() => {
    loadStats()
  }, [loadStats])

  const total = stats?.totalUsers ?? null
  const facts: Array<BarFact | null> = [
    total !== null && total > 0 ? { text: `${total.toLocaleString('en-US')} ${total === 1 ? 'user' : 'users'}` } : null,
    role.role !== null && !role.canWrite ? { text: 'Read only' } : null,
  ]

  return (
    <div className={`console-fill flex flex-col overflow-hidden ${KIT.bg}`}>
      <InstrumentBar
        title="Auth & Users"
        loading={stats === null && !statsFailed}
        facts={facts}
        tabs={TABS}
        activeTab={tab}
        onTab={(id) => (id === 'users' ? closeTab() : openTab(id))}
        panelId={panelId}
      />
      <div id={panelId} role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label} className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex">
          {tab === 'users' ? (
            <UsersPane
              projectId={projectId}
              stats={stats}
              canWrite={role.canWrite}
              canConnect={role.canAdminister}
              agent={role.loading ? null : { status: agent.status, client: agent.client }}
              onChanged={loadStats}
            />
          ) : tab === 'methods' ? (
            <SignInMethods projectId={projectId} canWrite={role.canWrite} canAdminister={role.canAdminister} userCount={total} />
          ) : (
            <EmailSettingsPanel projectId={projectId} canWrite={role.canWrite} canAdminister={role.canAdminister} />
          )}
        </div>
      </div>
    </div>
  )
}
