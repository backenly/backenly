'use client'

/**
 * /app/support/new: file a support case (Backenly Cloud).
 *
 * AWS-shaped form: category, severity (production severities need a paid
 * plan), optional project, subject, description. On submit the case opens and
 * Backenly AI writes the first response into its thread.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { notFound, useRouter } from 'next/navigation'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { AlertTriangle, ArrowLeft, Send, Sparkles } from 'lucide-react'
import { OrgShell } from '@/components/shell/OrgShell'
import {
  INPUT_BASE, KitButton, KitCard, KitCardBody, KitCardHeader, KitField, KitInput, KitNote, KitTextarea, SectionTitle, Tag,
} from '@/components/inspector/kit'
import { PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { getProjects, type Project } from '@/lib/api/projects'
import { createSupportTicket, listSupportTickets, SupportApiError, type SupportLevel } from '@/lib/api/support'
import {
  SUPPORT_CATEGORIES, SUPPORT_SEVERITIES, TICKET_BODY_MAX, TICKET_BODY_MIN, TICKET_SUBJECT_MAX,
} from '@/lib/support/constants'

export default function NewSupportCasePage() {
  if (!CLOUD_CONTROL_PLANE) notFound()
  return <NewCaseForm />
}

function NewCaseForm() {
  const router = useRouter()
  const [level, setLevel] = useState<SupportLevel | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [category, setCategory] = useState('database')
  const [severity, setSeverity] = useState('normal')
  const [projectId, setProjectId] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listSupportTickets('open')
      .then((r) => setLevel(r.level))
      .catch((e) => {
        if (e instanceof SupportApiError && e.status === 401) {
          router.push('/auth/login?redirect=/app/support/new')
        }
      })
    getProjects().then(setProjects).catch(() => setProjects([]))
  }, [router])

  const allowed = useMemo(
    () => new Set(level?.allowedSeverities ?? ['low', 'normal']),
    [level]
  )

  const subjectValid = subject.trim().length > 0 && subject.trim().length <= TICKET_SUBJECT_MAX
  const messageValid = message.trim().length >= TICKET_BODY_MIN && message.trim().length <= TICKET_BODY_MAX
  const canSubmit = !busy && subjectValid && messageValid && allowed.has(severity)

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const { ticket } = await createSupportTicket({
        subject: subject.trim(),
        message: message.trim(),
        category,
        severity,
        projectId: projectId || null,
      })
      router.push(`/app/support/${ticket.id}`)
    } catch (e) {
      if (e instanceof SupportApiError && e.status === 401) {
        router.push('/auth/login?redirect=/app/support/new')
        return
      }
      setError(e instanceof Error ? e.message : 'Could not file the case')
      setBusy(false)
    }
  }

  return (
    <OrgShell>
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} max-w-[760px] py-8`}>
        <Link
          href="/app/support"
          className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] text-zinc-500 transition-colors hover:text-zinc-200"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Support
        </Link>

        <SectionTitle
          title="New case"
          description="Describe what happened. Backenly AI answers immediately; the team reads every case and follows up."
        />

        <KitCard>
          <KitCardHeader title="What is this about?" />
          <KitCardBody className="space-y-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <KitField label="Category">
                <select value={category} onChange={(e) => setCategory(e.target.value)} className={INPUT_BASE} disabled={busy}>
                  {SUPPORT_CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
              </KitField>
              <KitField label="Project" hint="Optional — lets the AI responder see the project's surface facts">
                <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={INPUT_BASE} disabled={busy}>
                  <option value="">Not about one project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </KitField>
            </div>

            <KitField label="Severity">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Severity">
                {SUPPORT_SEVERITIES.map((s) => {
                  const enabled = allowed.has(s.id)
                  const active = severity === s.id
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={!enabled || busy}
                      onClick={() => setSeverity(s.id)}
                      className={`rounded-lg border p-3 text-left transition-colors ${
                        active
                          ? 'border-white/[0.22] bg-white/[0.06]'
                          : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14]'
                      } ${!enabled ? 'cursor-not-allowed opacity-50' : ''}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-medium text-zinc-100">{s.label}</span>
                        {s.paidOnly && !enabled && <Tag tone="neutral">Paid plans</Tag>}
                      </div>
                      <p className="mt-1 text-[12px] leading-snug text-zinc-500">{s.blurb}</p>
                    </button>
                  )
                })}
              </div>
            </KitField>

            <KitField
              label={
                <span className="flex items-center justify-between">
                  <span>Subject</span>
                  <span className="text-[12px] tabular-nums text-zinc-600">{subject.length}/{TICKET_SUBJECT_MAX}</span>
                </span>
              }
            >
              <KitInput
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={TICKET_SUBJECT_MAX}
                placeholder="e.g. End-user sign-ups fail with 401 since yesterday"
                disabled={busy}
              />
            </KitField>

            <KitField
              label={
                <span className="flex items-center justify-between">
                  <span>What happened?</span>
                  <span className="text-[12px] tabular-nums text-zinc-600">{message.length}/{TICKET_BODY_MAX}</span>
                </span>
              }
              hint="Steps you took, what you expected, exact error messages. Never include passwords or API keys."
            >
              <KitTextarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={TICKET_BODY_MAX}
                rows={8}
                placeholder="What were you trying to do? What happened instead? Paste exact errors — they speed everything up."
                disabled={busy}
              />
            </KitField>

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-rose-400" />
                <p className="text-[12px] leading-snug text-rose-300">{error}</p>
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <p className="inline-flex items-center gap-1.5 text-[12px] text-zinc-500">
                <Sparkles className="h-3.5 w-3.5 text-violet-300" />
                AI first response lands in the case thread within seconds.
              </p>
              <KitButton variant="primary" icon={Send} onClick={submit} disabled={!canSubmit} loading={busy}>
                File case
              </KitButton>
            </div>
          </KitCardBody>
        </KitCard>

        <div className="mt-4">
          <KitNote title="Production down?">
            File at “Production down” severity (paid plans) and keep the case updated — the team prioritizes by severity, then by plan.
          </KitNote>
        </div>
      </div>
    </OrgShell>
  )
}
