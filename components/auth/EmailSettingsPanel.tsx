'use client'

/**
 * OUTGOING MAIL: WHO SENDS IT, AND WHAT IT SAYS
 * ============================================
 *
 * ── "Configured" is not "works", and this panel keeps them apart ────────────
 *
 * Every field can be right and the credentials still wrong, the port blocked,
 * the sender unverified with the provider. So the sender row never shows a
 * tick for a stored row. It shows what is stored and, separately, the result
 * of the last REAL send. Send test is not a validity check: it is the only
 * evidence.
 *
 * ── The preview is the dangerous surface, not the email ─────────────────────
 *
 * An operator authors raw HTML. A mail client runs none of it; the dashboard
 * would. So the preview renders inside an iframe with an empty `sandbox`
 * attribute (no scripts, no same-origin), and the API refuses a <script> tag
 * before it ever gets here. Two controls, because the iframe is the one that
 * holds if a future edit relaxes the other.
 *
 * ── The password is write-only ──────────────────────────────────────────────
 *
 * No route returns it. The field is empty on load and blank means "keep the
 * stored one", which is said next to it.
 *
 * The sender is one row; the SMTP form appears only when someone uses their
 * own server. A template opens on the words being sent today: the override,
 * or the built-in text (lib/email/auth-builtins.ts), never an empty box.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { RotateCcw, Send, Trash2 } from 'lucide-react'
import { INPUT_BASE, KitButton, KitCheckbox, KitConfirmDialog, KitField, KitInput, KitModal, OverflowMenu } from '@/components/inspector/kit'
import { Fact, Facts, Panel, Row, RowList, RowSkeleton, ROW_TEXT, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { ErrorRow, RefusedLine } from '@/components/console/states'
import { Time } from '@/components/console/Time'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'

interface SmtpView {
  configured: boolean
  enabled: boolean
  host: string | null
  port: number | null
  username: string | null
  fromAddress: string | null
  fromName: string | null
  passwordConfigured: boolean
  effectivePort: number | null
  portNormalised: boolean
  lastTestAt: string | null
  lastTestError: string | null
  deploymentFallbackAvailable: boolean
  /** The address auth emails go out from through the deployment, under the app's name. */
  deploymentSenderAddress: string | null
  activeSource: 'project' | 'deployment' | 'none'
}

interface TemplateRow {
  kind: string
  title: string
  sends: string
  customised: boolean
  subject: string | null
  bodyHtml: string | null
  updatedAt: string | null
  /** What is sent while there is no override, as a template. */
  builtIn?: { subject: string; bodyHtml: string }
}

interface FieldProblem {
  field?: string
  message: string
}

interface PolicyView {
  effectiveAppName: string
}

// On Backenly Cloud the deployment is Backenly. A customer there has no
// environment variables to set, so the copy says who sends the mail and as
// whom (CLOUD_CONTROL_PLANE). A self-hosted operator does set them, so theirs
// names the variables.

/** The From a project's users see when the deployment sends: “shopqa” <noreply@…>. */
function deploymentSender(smtp: SmtpView, policy: PolicyView | null): string | null {
  if (!smtp.deploymentSenderAddress) return null
  return policy ? `“${policy.effectiveAppName}” <${smtp.deploymentSenderAddress}>` : smtp.deploymentSenderAddress
}

function sourceLabel(source: SmtpView['activeSource']): string {
  if (source === 'project') return 'Your SMTP server'
  if (source === 'deployment') return CLOUD_CONTROL_PLANE ? 'Sent by Backenly' : 'Deployment SMTP'
  return 'Not set up'
}

function sourceText(smtp: SmtpView, policy: PolicyView | null): string {
  if (smtp.activeSource === 'none') return 'Nothing sends auth emails, so they are only logged. Password reset and verification reach no one.'
  const sender = deploymentSender(smtp, policy)
  const as = sender ? ` as ${sender}` : ''
  return CLOUD_CONTROL_PLANE ? `Backenly sends this project’s auth emails${as}.` : `Mail sends through the deployment’s SMTP environment variables${as}.`
}

const EMPTY_FORM = { host: '', port: '587', username: '', password: '', fromAddress: '', fromName: '', enabled: true }

export function EmailSettingsPanel({ projectId, canWrite = false, canAdminister = false }: { projectId: string; canWrite?: boolean; canAdminister?: boolean }) {
  const [smtp, setSmtp] = useState<SmtpView | null>(null)
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [variables, setVariables] = useState<string[]>([])
  const [policy, setPolicy] = useState<PolicyView | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [form, setForm] = useState(EMPTY_FORM)
  const [editingSmtp, setEditingSmtp] = useState(false)
  const [problems, setProblems] = useState<FieldProblem[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testTo, setTestTo] = useState('')
  const [senderNote, setSenderNote] = useState<{ tone: 'done' | 'attention' | 'refused'; text: string } | null>(null)
  const [templateNote, setTemplateNote] = useState<{ kind: string; tone: 'done' | 'refused'; text: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [editing, setEditing] = useState<TemplateRow | null>(null)

  const load = useCallback(async () => {
    try {
      const [smtpRes, tplRes, policyRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/email/smtp`, { credentials: 'include' }),
        fetch(`/api/projects/${projectId}/email/templates`, { credentials: 'include' }),
        fetch(`/api/projects/${projectId}/auth-email-settings`, { credentials: 'include' }),
      ])
      const smtpData = await smtpRes.json().catch(() => ({}))
      const tplData = await tplRes.json().catch(() => ({}))
      const policyData = await policyRes.json().catch(() => ({}))
      if (!smtpRes.ok || !tplRes.ok) throw new Error('Mail settings could not be read.')
      setSmtp(smtpData.smtp)
      setTemplates(tplData.templates ?? [])
      setVariables(tplData.variables ?? [])
      setPolicy(policyRes.ok ? policyData.settings : null)
      setForm({
        host: smtpData.smtp.host ?? '',
        port: String(smtpData.smtp.port ?? 587),
        username: smtpData.smtp.username ?? '',
        // Never filled from the server, because the server never sends it.
        password: '',
        fromAddress: smtpData.smtp.fromAddress ?? '',
        fromName: smtpData.smtp.fromName ?? '',
        enabled: smtpData.smtp.enabled ?? true,
      })
      setState('ready')
    } catch {
      // Reported, not swallowed: empty fields over a failed read would say "nothing is set up".
      setState((s) => (s === 'ready' ? s : 'failed'))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  async function save() {
    setBusy('save')
    setProblems([])
    setSenderNote(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/email/smtp`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          host: form.host,
          port: Number(form.port),
          username: form.username,
          // Blank means keep: undefined rather than '' so the route can tell "unchanged" from "cleared".
          password: form.password || undefined,
          fromAddress: form.fromAddress,
          fromName: form.fromName || null,
          enabled: form.enabled,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setProblems(data.problems ?? [{ message: data.error ?? 'These settings were not saved.' }])
        return
      }
      setSmtp(data.smtp)
      setForm((f) => ({ ...f, password: '' }))
      setEditingSmtp(false)
      // Saving cleared the test result; claiming more than "saved" is the failure this panel exists to avoid.
      setSenderNote({ tone: 'attention', text: 'Saved. Send a test to confirm these settings deliver.' })
    } catch (err) {
      setProblems([{ message: err instanceof Error ? err.message : 'These settings were not saved.' }])
    } finally {
      setBusy(null)
    }
  }

  async function sendTest() {
    setBusy('test')
    setSenderNote(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/email/smtp/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ to: testTo.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.smtp) setSmtp(data.smtp)
      // The provider's own words: paraphrasing a 535 into "send failed" turns a quick fix into a support thread.
      if (data.success) {
        setSenderNote({ tone: 'done', text: `Delivered to ${testTo.trim()}.` })
        setTesting(false)
      } else setSenderNote({ tone: 'refused', text: data.error ?? 'The test was not delivered.' })
    } catch (err) {
      setSenderNote({ tone: 'refused', text: err instanceof Error ? err.message : 'The test was not delivered.' })
    } finally {
      setBusy(null)
    }
  }

  async function removeConfig() {
    setBusy('remove')
    try {
      const res = await fetch(`/api/projects/${projectId}/email/smtp`, { method: 'DELETE', credentials: 'include' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'The settings were not removed.')
      setSmtp(data.smtp)
      await load()
      setSenderNote({ tone: 'done', text: 'Your SMTP settings are removed.' })
    } catch (err) {
      setSenderNote({ tone: 'refused', text: err instanceof Error ? err.message : 'The settings were not removed.' })
    } finally {
      setBusy(null)
      setConfirmRemove(false)
    }
  }

  async function revertTemplate(t: TemplateRow) {
    setBusy(`revert-${t.kind}`)
    setTemplateNote(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/email/templates/${t.kind}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) throw new Error('The template was not reset.')
      await load()
      setTemplateNote({ kind: t.kind, tone: 'done', text: 'Back to the built-in version.' })
    } catch (err) {
      setTemplateNote({ kind: t.kind, tone: 'refused', text: err instanceof Error ? err.message : 'The template was not reset.' })
    } finally {
      setBusy(null)
    }
  }

  const sender = smtp ? deploymentSender(smtp, policy) : null
  const own = smtp?.activeSource === 'project'
  const glyph = !smtp ? 'idle' : smtp.activeSource === 'none' ? 'failed' : own ? (smtp.lastTestError ? 'failed' : smtp.lastTestAt ? 'live' : 'waiting') : 'live'
  const fallbackWords = smtp?.deploymentFallbackAvailable
    ? CLOUD_CONTROL_PLANE
      ? 'Unchecked, Backenly sends them.'
      : 'Unchecked, auth emails fall back to the deployment’s SMTP.'
    : 'Unchecked, auth emails are only logged.'

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full max-w-[880px] space-y-[32px] px-[16px] py-[24px] sm:px-[24px]">
        <Section id="email-sender" title="Sender">
          <Panel>
            {state === 'failed' ? (
              <ErrorRow things="the mail settings" onRetry={() => void load()} />
            ) : state === 'loading' || !smtp ? (
              <RowSkeleton rows={1} />
            ) : (
              <RowList>
                <Row
                  lead="glyph"
                  glyph={glyph}
                  glyphLabel={glyph === 'failed' ? 'Not delivering' : glyph === 'waiting' ? 'Never tested' : 'Sending'}
                  title={<span className={ROW_TITLE}>{sourceLabel(smtp.activeSource)}</span>}
                  actions={
                    canAdminister ? (
                      <>
                        {smtp.activeSource !== 'none' && !testing && (
                          <KitButton size="sm" variant="ghost" icon={Send} onClick={() => setTesting(true)} disabled={busy !== null}>
                            Send test
                          </KitButton>
                        )}
                        {!editingSmtp && (
                          <KitButton size="sm" onClick={() => setEditingSmtp(true)} disabled={busy !== null}>
                            {own ? 'Edit' : smtp.activeSource === 'none' ? 'Set up SMTP' : 'Use your own SMTP'}
                          </KitButton>
                        )}
                        {smtp.configured && (
                          <OverflowMenu label="More for the SMTP settings" items={[{ label: 'Remove…', icon: Trash2, danger: true, onClick: () => setConfirmRemove(true) }]} />
                        )}
                      </>
                    ) : undefined
                  }
                >
                  {own ? (
                    <Facts className="!mt-[4px]">
                      <Fact>
                        <code className="font-mono text-[11.5px] text-zinc-400">
                          {smtp.host}:{smtp.effectivePort ?? smtp.port}
                        </code>
                      </Fact>
                      {smtp.fromAddress && <Fact>{smtp.fromName ? `“${smtp.fromName}” <${smtp.fromAddress}>` : smtp.fromAddress}</Fact>}
                      {smtp.lastTestError ? (
                        <span className="font-medium text-zinc-50">Last test failed</span>
                      ) : smtp.lastTestAt ? (
                        <Fact>
                          <Time iso={smtp.lastTestAt} prefix="Last test delivered" />
                        </Fact>
                      ) : (
                        <span className="font-medium text-zinc-50">Never tested</span>
                      )}
                    </Facts>
                  ) : (
                    <p className={`${ROW_TEXT} !mt-[2px]`}>{sourceText(smtp, policy)}</p>
                  )}
                  {own && smtp.lastTestError && <RefusedLine className="mt-[6px]">{smtp.lastTestError}</RefusedLine>}
                  {senderNote &&
                    (senderNote.tone === 'refused' ? (
                      <RefusedLine className="mt-[6px]">{senderNote.text}</RefusedLine>
                    ) : (
                      <p role="status" className={`mt-[6px] text-[12.5px] leading-[18px] ${senderNote.tone === 'attention' ? 'text-zinc-50' : 'text-zinc-300'}`}>
                        {senderNote.text}
                      </p>
                    ))}
                </Row>

                {testing && (
                  <li className="px-[20px] py-[14px]">
                    <form
                      className="flex flex-col gap-[8px] sm:flex-row"
                      onSubmit={(e) => {
                        e.preventDefault()
                        if (testTo.trim()) void sendTest()
                      }}
                    >
                      <KitInput type="email" aria-label="Send a test to" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" spellCheck={false} className="sm:max-w-[320px]" />
                      <div className="flex gap-[8px]">
                        <KitButton type="submit" loading={busy === 'test'} disabled={busy !== null || testTo.trim() === ''}>
                          Send
                        </KitButton>
                        <KitButton variant="ghost" onClick={() => setTesting(false)} disabled={busy === 'test'}>
                          Cancel
                        </KitButton>
                      </div>
                    </form>
                  </li>
                )}

                {editingSmtp && (
                  <li className="px-[20px] py-[16px]">
                    <form
                      onSubmit={(e) => {
                        e.preventDefault()
                        void save()
                      }}
                    >
                      <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
                        <KitField label="Host">
                          <KitInput value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="smtp.example.com" spellCheck={false} autoComplete="off" />
                        </KitField>
                        <KitField label="Port" hint={smtp.portNormalised ? `465 is sent as ${smtp.effectivePort}: many hosts block it outbound, and every major provider serves 587.` : undefined}>
                          <KitInput value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} inputMode="numeric" />
                        </KitField>
                        <KitField label="Username">
                          <KitInput value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} spellCheck={false} autoComplete="off" />
                        </KitField>
                        <KitField label="Password" hint={smtp.passwordConfigured ? 'Stored. Leave blank to keep it.' : undefined}>
                          <KitInput type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={smtp.passwordConfigured ? '••••••••' : ''} autoComplete="new-password" />
                        </KitField>
                        <KitField label="From address">
                          <KitInput type="email" value={form.fromAddress} onChange={(e) => setForm({ ...form, fromAddress: e.target.value })} placeholder="auth@example.com" spellCheck={false} />
                        </KitField>
                        <KitField label={<>From name <span className="font-normal text-faint">Optional</span></>}>
                          <KitInput value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} placeholder={policy?.effectiveAppName ?? ''} />
                        </KitField>
                      </div>
                      <KitCheckbox className="mt-[16px]" checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Send with these settings" description={fallbackWords} />
                      {problems.length > 0 && (
                        <ul className="mt-[12px] space-y-[2px]">
                          {problems.map((p, i) => (
                            <li key={i}>
                              <RefusedLine>
                                {p.field ? `${p.field}: ` : ''}
                                {p.message}
                              </RefusedLine>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="mt-[16px] flex justify-end gap-[8px]">
                        <KitButton variant="ghost" onClick={() => setEditingSmtp(false)} disabled={busy === 'save'}>
                          Cancel
                        </KitButton>
                        <KitButton type="submit" variant="primary" loading={busy === 'save'}>
                          Save settings
                        </KitButton>
                      </div>
                    </form>
                  </li>
                )}
              </RowList>
            )}
          </Panel>
        </Section>

        <Section id="email-templates" title="Templates">
          <Panel>
            {state === 'failed' ? (
              <ErrorRow things="the templates" onRetry={() => void load()} />
            ) : state === 'loading' ? (
              <RowSkeleton rows={3} lead="none" />
            ) : (
              <RowList>
                {templates.map((t) => (
                  <Row
                    key={t.kind}
                    lead="none"
                    title={<span className={ROW_TITLE}>{t.title}</span>}
                    actions={
                      canWrite ? (
                        <>
                          <KitButton size="sm" onClick={() => setEditing(t)} disabled={busy !== null}>
                            Edit
                          </KitButton>
                          {t.customised && (
                            <OverflowMenu
                              label={`More for ${t.title}`}
                              items={[{ label: 'Use the built-in version', icon: RotateCcw, onClick: () => void revertTemplate(t) }]}
                            />
                          )}
                        </>
                      ) : undefined
                    }
                  >
                    <Facts className="!mt-[4px]">
                      <Fact>{t.customised ? <Time iso={t.updatedAt} mode="date" prefix="Edited" fallback="Edited" /> : 'Built-in'}</Fact>
                      <Fact>{t.sends}</Fact>
                    </Facts>
                    {templateNote?.kind === t.kind &&
                      (templateNote.tone === 'refused' ? (
                        <RefusedLine className="mt-[6px]">{templateNote.text}</RefusedLine>
                      ) : (
                        <p role="status" className="mt-[6px] text-[12.5px] text-zinc-300">
                          {templateNote.text}
                        </p>
                      ))}
                  </Row>
                ))}
              </RowList>
            )}
          </Panel>
        </Section>
      </div>

      <KitConfirmDialog
        open={confirmRemove}
        danger
        busy={busy === 'remove'}
        title="Remove your SMTP settings?"
        description={
          smtp?.deploymentFallbackAvailable
            ? CLOUD_CONTROL_PLANE
              ? `Backenly sends this project’s auth emails${sender ? `, as ${sender}` : ''}.`
              : 'Auth emails fall back to the deployment’s SMTP environment variables.'
            : 'Nothing else is set up, so auth emails will only be logged and reset links reach no one.'
        }
        undoable={false}
        lost="The stored password is deleted."
        confirmLabel="Remove"
        onConfirm={() => void removeConfig()}
        onCancel={() => busy !== 'remove' && setConfirmRemove(false)}
      />

      {editing && (
        <TemplateEditor
          projectId={projectId}
          template={editing}
          variables={variables}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            const kind = editing.kind
            setEditing(null)
            await load()
            setTemplateNote({ kind, tone: 'done', text: 'Saved.' })
          }}
        />
      )}
    </div>
  )
}

/**
 * One template: the editor on the left and what the email will look like on
 * the right, rendered by the server a moment after typing stops, in a
 * sandboxed frame. Opens on the words sent today.
 */
function TemplateEditor({
  projectId,
  template,
  variables,
  onClose,
  onSaved,
}: {
  projectId: string
  template: TemplateRow
  variables: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const start = template.customised
    ? { subject: template.subject ?? '', bodyHtml: template.bodyHtml ?? '' }
    : { subject: template.builtIn?.subject ?? '', bodyHtml: dedent(template.builtIn?.bodyHtml ?? '') }
  const [subject, setSubject] = useState(start.subject)
  const [bodyHtml, setBodyHtml] = useState(start.bodyHtml)
  const [errors, setErrors] = useState<FieldProblem[]>([])
  const [preview, setPreview] = useState<{ subject: string; bodyHtml: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  // The preview follows the text, half a second after typing stops.
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/email/templates/${template.kind}/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ subject, bodyHtml }),
        })
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          setErrors(data.errors ?? [{ message: data.error ?? 'This template cannot be used.' }])
          return
        }
        setErrors([])
        setPreview(data.preview)
      } catch {
        /* the preview is a convenience; Save still says what is wrong */
      }
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [projectId, template.kind, subject, bodyHtml])

  const insert = (name: string) => {
    const el = bodyRef.current
    const token = `{{${name}}}`
    if (!el) return setBodyHtml((b) => b + token)
    const from = el.selectionStart ?? bodyHtml.length
    const to = el.selectionEnd ?? from
    setBodyHtml(bodyHtml.slice(0, from) + token + bodyHtml.slice(to))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(from + token.length, from + token.length)
    })
  }

  const save = async () => {
    setSaving(true)
    setErrors([])
    try {
      const res = await fetch(`/api/projects/${projectId}/email/templates/${template.kind}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ subject, bodyHtml }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErrors(data.errors ?? [{ message: data.error ?? 'The template was not saved.' }])
        return
      }
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <KitModal
      open
      width="max-w-[1080px]"
      title={template.title}
      description={template.customised ? undefined : 'Starts from the built-in text. Saving it makes it this project’s own.'}
      onClose={onClose}
      footer={
        <>
          <KitButton variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </KitButton>
          <KitButton variant="primary" onClick={() => void save()} loading={saving}>
            Save template
          </KitButton>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-[20px] lg:grid-cols-2">
        <div className="min-w-0 space-y-[14px]">
          <KitField label="Subject">
            <KitInput value={subject} onChange={(e) => setSubject(e.target.value)} spellCheck={false} />
          </KitField>
          <KitField label="Body">
            {/* The kit's textarea takes no ref on React 18; the caret is needed to insert a value where it is. */}
            <textarea
              ref={bodyRef}
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              rows={14}
              spellCheck={false}
              className={`${INPUT_BASE} resize-y px-3 py-2 font-mono leading-[18px] sm:text-[12px]`}
            />
          </KitField>
          <div className="flex flex-wrap items-center gap-[6px]" role="group" aria-label="Insert a value">
            <span className="mr-[2px] text-[12px] text-faint">Insert</span>
            {variables.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => insert(v)}
                className="inline-flex h-[24px] items-center rounded-[5px] border border-white/[0.10] bg-white/[0.03] px-[7px] font-mono text-[11.5px] text-zinc-200 transition-colors duration-150 hover:border-white/[0.18] hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                {`{{${v}}}`}
              </button>
            ))}
          </div>
          {errors.length > 0 && (
            <ul className="space-y-[2px]">
              {errors.map((e, i) => (
                <li key={i}>
                  <RefusedLine>{e.message}</RefusedLine>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-w-0">
          <p className="mb-[6px] text-[12.5px] font-medium leading-[18px] text-zinc-300">Preview</p>
          <p className="mb-[8px] truncate text-[12.5px] text-faint">
            Subject: <span className="text-zinc-200">{preview?.subject ?? subject}</span>
          </p>
          {/* Sandboxed with NO tokens: no scripts, no same-origin. The HTML renders here and can do nothing to the console. */}
          <iframe title="Email preview" sandbox="" srcDoc={preview?.bodyHtml ?? ''} className="h-[380px] w-full rounded-[8px] border border-white/10 bg-white" />
        </div>
      </div>
    </KitModal>
  )
}

/** The built-in HTML without the indentation it carries in its source file. */
function dedent(html: string): string {
  const lines = html.replace(/^\n+|\s+$/g, '').split('\n')
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)?.[0].length ?? 0))
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n')
}
