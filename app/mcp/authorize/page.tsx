export const dynamic = 'force-dynamic'

/**
 * MCP OAuth consent screen.
 *
 * The one place a human decides which project an agent may reach and whether it
 * may change anything. Everything else in the flow is plumbing; this is the
 * grant.
 *
 * Server component on purpose. The `confirm` token it mints carries the signed
 * authorization request plus the signed-in user's id, and it must never be
 * reachable by client JavaScript on another origin — rendering it server-side
 * into a form is what makes the POST CSRF-resistant. See the header comment in
 * app/api/mcp/oauth/authorize/route.ts.
 *
 * Read-only defaults to ON. An agent that only needs to read should not be the
 * one that has to ask for less, and the safer default is the one a user
 * clicking through without reading ends up with.
 */

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db/prisma'
import { verifyToken } from '@/lib/auth/jwt'
import { CONFIRM_TYP, REQ_TYP, signAuthzToken, verifyAuthzToken } from '@/lib/mcp/oauth-authz'
import { SCOPE_WRITE } from '@/lib/mcp/oauth'

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: '#101116', color: '#e6e6e6', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem 1.25rem', font: '15px/1.6 ui-sans-serif, system-ui, sans-serif' }}>
      <div style={{ width: '100%', maxWidth: '30rem', background: '#16171d', border: '1px solid #26272e', borderRadius: 12, padding: '1.75rem' }}>
        <h1 style={{ fontSize: '1.05rem', fontWeight: 600, margin: '0 0 1.1rem' }}>{title}</h1>
        {children}
      </div>
    </div>
  )
}

export default async function McpAuthorizePage({
  searchParams,
}: {
  searchParams: { req?: string }
}) {
  const reqToken = searchParams.req
  if (!reqToken) {
    return (
      <Shell title="Nothing to authorize">
        <p style={{ color: '#9a9aa2', margin: 0 }}>
          Start the connection from your MCP host.
        </p>
      </Shell>
    )
  }

  const req = verifyAuthzToken(reqToken, REQ_TYP)
  if (!req) {
    return (
      <Shell title="This request expired">
        <p style={{ color: '#9a9aa2', margin: 0 }}>
          Authorization requests are valid for 10 minutes. Start the connection again from your MCP host.
        </p>
      </Shell>
    )
  }

  const token = cookies().get('auth-token')?.value
  const uid = token ? verifyToken(token)?.userId : null
  if (!uid) {
    redirect(`/auth/login?redirect=${encodeURIComponent(`/mcp/authorize?req=${reqToken}`)}`)
  }

  const [client, projects] = await Promise.all([
    prisma.mcpOAuthClient.findUnique({ where: { clientId: req.client_id } }),
    prisma.project.findMany({
      where: { userId: uid! },
      select: { id: true, name: true },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  if (!client) {
    return (
      <Shell title="Unknown client">
        <p style={{ color: '#9a9aa2', margin: 0 }}>This client registration no longer exists.</p>
      </Shell>
    )
  }

  if (projects.length === 0) {
    return (
      <Shell title="No projects yet">
        <p style={{ color: '#9a9aa2', margin: 0 }}>
          Create a project in Backenly first, then connect your MCP host to it.
        </p>
      </Shell>
    )
  }

  const confirm = signAuthzToken(
    {
      client_id: req.client_id,
      redirect_uri: req.redirect_uri,
      code_challenge: req.code_challenge,
      scope: req.scope,
      state: req.state,
      resource: req.resource,
      uid: uid!,
    },
    CONFIRM_TYP,
  )

  const wantsWrite = req.scope.split(/\s+/).includes(SCOPE_WRITE)
  const label = { display: 'block', fontSize: '.8rem', color: '#9a9aa2', margin: '0 0 .4rem' }
  const field = {
    width: '100%',
    background: '#1c1d23',
    color: '#e6e6e6',
    border: '1px solid #2e2f37',
    borderRadius: 8,
    padding: '.6rem .7rem',
    font: 'inherit',
  }

  return (
    <Shell title={`Connect ${client.clientName} to Backenly`}>
      <p style={{ color: '#9a9aa2', margin: '0 0 1.25rem', fontSize: '.9rem' }}>
        This will let {client.clientName} operate one of your backends over MCP.
      </p>

      <form method="POST" action="/api/mcp/oauth/authorize">
        <input type="hidden" name="confirm" value={confirm} />

        <label style={label} htmlFor="project_id">Project</label>
        <select id="project_id" name="project_id" style={{ ...field, marginBottom: '1.1rem' }} defaultValue={projects[0].id}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        <div style={{ background: '#1c1d23', border: '1px solid #2e2f37', borderRadius: 8, padding: '.8rem .85rem', marginBottom: '1.25rem' }}>
          <label style={{ display: 'flex', gap: '.6rem', alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="checkbox" name="read_only" defaultChecked style={{ marginTop: '.25rem', accentColor: '#8B5CF6' }} />
            <span>
              <span style={{ display: 'block', fontSize: '.9rem' }}>Read-only access</span>
              <span style={{ display: 'block', fontSize: '.8rem', color: '#9a9aa2', marginTop: '.15rem' }}>
                The agent can inspect schema, run read queries and read logs, but cannot
                change anything. {wantsWrite ? `${client.clientName} asked for write access — unchecking grants it.` : ''}
              </span>
            </span>
          </label>
        </div>

        <div style={{ display: 'flex', gap: '.6rem' }}>
          <button
            type="submit"
            name="decision"
            value="approve"
            style={{ flex: 1, background: '#e6e6e6', color: '#101116', border: 0, borderRadius: 8, padding: '.65rem', font: 'inherit', fontWeight: 600, cursor: 'pointer' }}
          >
            Approve
          </button>
          <button
            type="submit"
            name="decision"
            value="deny"
            style={{ flex: 1, background: 'transparent', color: '#9a9aa2', border: '1px solid #2e2f37', borderRadius: 8, padding: '.65rem', font: 'inherit', cursor: 'pointer' }}
          >
            Cancel
          </button>
        </div>
      </form>
    </Shell>
  )
}
