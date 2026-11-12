'use client'

/**
 * The consent form. It posts to /api/mcp/oauth/authorize and then sends the
 * browser to the MCP client's redirect_uri itself.
 *
 * Why not let the form post and follow the 303: the console's CSP has
 * `form-action 'self'`, which Chromium also applies to where a form
 * submission is redirected. The 303 to the client's callback
 * (http://127.0.0.1:…/callback, cursor://…, https://claude.ai/…) was blocked,
 * and Approve did nothing on screen (production, 2026-11-09). So the form is
 * submitted with fetch, asking for JSON, and the browser goes to the
 * `redirectTo` it returns. A navigation is not a form submission, so
 * `form-action 'self'` stays as strict as it is on every other page.
 *
 * Without JavaScript the same form still posts the ordinary way.
 */

import { useState, type FormEvent } from 'react'

const label = { display: 'block', fontSize: '.8rem', color: '#9a9aa2', margin: '0 0 .4rem' } as const
const field = {
  width: '100%',
  background: '#1c1d23',
  color: '#e6e6e6',
  border: '1px solid #2e2f37',
  borderRadius: 8,
  padding: '.6rem .7rem',
  font: 'inherit',
} as const

export default function ConsentForm({
  confirm,
  projects,
  clientName,
  wantsWrite,
}: {
  confirm: string
  projects: Array<{ id: string; name: string }>
  clientName: string
  wantsWrite: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null
    const body = new FormData(event.currentTarget)
    body.set('decision', submitter?.value === 'deny' ? 'deny' : 'approve')
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(event.currentTarget.action, {
        method: 'POST',
        body,
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      })
      const out = (await res.json().catch(() => null)) as { redirectTo?: string; error?: string; detail?: string } | null
      if (out?.redirectTo) {
        window.location.assign(out.redirectTo)
        return
      }
      setError(out?.error ? `${out.error}. ${out.detail ?? ''}`.trim() : 'Backenly could not record your answer. Try again.')
    } catch {
      setError('Backenly could not be reached. Check your connection and try again.')
    }
    setBusy(false)
  }

  return (
    <form method="POST" action="/api/mcp/oauth/authorize" onSubmit={onSubmit}>
      <input type="hidden" name="confirm" value={confirm} />

      <label style={label} htmlFor="project_id">Project</label>
      <select id="project_id" name="project_id" style={{ ...field, marginBottom: '1.1rem' }} defaultValue={projects[0]?.id}>
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
              change anything. {wantsWrite ? `${clientName} asked for write access — unchecking grants it.` : ''}
            </span>
          </span>
        </label>
      </div>

      {error && (
        <p role="alert" style={{ color: '#f2a1a1', fontSize: '.85rem', margin: '0 0 1rem' }}>{error}</p>
      )}

      <div style={{ display: 'flex', gap: '.6rem' }}>
        <button
          type="submit"
          name="decision"
          value="approve"
          disabled={busy}
          style={{ flex: 1, background: '#e6e6e6', color: '#101116', border: 0, borderRadius: 8, padding: '.65rem', font: 'inherit', fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}
        >
          Approve
        </button>
        <button
          type="submit"
          name="decision"
          value="deny"
          disabled={busy}
          style={{ flex: 1, background: 'transparent', color: '#9a9aa2', border: '1px solid #2e2f37', borderRadius: 8, padding: '.65rem', font: 'inherit', cursor: busy ? 'default' : 'pointer' }}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
