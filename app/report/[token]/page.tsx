/**
 * /report/[token] — the public, read-only change report.
 *
 * What an agency sends a client, what a founder sends a cofounder: proof of
 * what changed in the backend and that nothing broke, straight from the same
 * ledger the History page reads. No auth — access IS the revocable token.
 * Server-rendered, no client JS needed.
 */

import { resolveShareToken, buildChangeReport } from '@/lib/reports/change-report'

export const dynamic = 'force-dynamic'

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export default async function ReportPage({ params }: { params: { token: string } }) {
  const resolved = await resolveShareToken(params.token)
  const report = resolved ? await buildChangeReport(resolved.projectId) : null

  if (!report) {
    return (
      <main className="min-h-screen bg-[#16171d] flex items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <p className="text-[13px] font-semibold text-zinc-200">This report link isn’t active</p>
          <p className="mt-2 text-[12.5px] text-zinc-500 leading-relaxed">
            It may have been revoked by the project owner, or the URL is incomplete.
            Ask them for a fresh link.
          </p>
        </div>
      </main>
    )
  }

  const m = report.metrics
  return (
    <main className="min-h-screen bg-[#16171d] text-zinc-200">
      <div className="mx-auto max-w-3xl px-6 py-12">
        {/* header */}
        <p className="text-[11px] font-bold tracking-[0.08em] uppercase text-violet-300">
          Backenly · Change report
        </p>
        <h1 className="mt-1.5 text-[22px] font-bold text-zinc-50">{report.project.name}</h1>
        <p className="mt-1 text-[12px] text-zinc-600">
          Generated {new Date(report.generatedAt).toUTCString()} · read-only · every change below was
          governed, verified, and is reversible
        </p>

        {/* backend shape */}
        <div className="mt-8 grid grid-cols-3 gap-px rounded-lg border border-white/[0.08] bg-white/[0.04] overflow-hidden">
          {[
            [report.counts.tables, 'Tables'],
            [report.counts.endpoints, 'API endpoints'],
            [report.counts.functions, 'Functions'],
          ].map(([n, label]) => (
            <div key={String(label)} className="bg-[#17181b] px-5 py-4">
              <p className="font-mono text-[20px] font-bold text-zinc-50 tabular-nums">{n}</p>
              <p className="mt-0.5 text-[11px] text-zinc-500">{label}</p>
            </div>
          ))}
        </div>

        {/* 30-day metrics */}
        <h2 className="mt-10 text-[13px] font-semibold text-zinc-100">Last {m.windowDays} days</h2>
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-px rounded-lg border border-white/[0.08] bg-white/[0.04] overflow-hidden">
          {[
            [m.autoFixes, 'Fixed autonomously'],
            [m.approvedChanges, 'Owner-approved changes'],
            [m.agentChanges, 'Coding-agent changes'],
            [m.rollbacks, 'Rollbacks'],
          ].map(([n, label]) => (
            <div key={String(label)} className="bg-[#17181b] px-5 py-4">
              <p className="font-mono text-[18px] font-bold text-zinc-50 tabular-nums">{n}</p>
              <p className="mt-0.5 text-[11px] text-zinc-500 leading-snug">{label}</p>
            </div>
          ))}
        </div>

        {/* ledger */}
        <h2 className="mt-10 text-[13px] font-semibold text-zinc-100">Everything that changed</h2>
        <p className="mt-1 text-[11.5px] text-zinc-600">
          The full record, newest first — including the changes that needed another look. Honesty is the artifact.
        </p>
        <ul className="mt-4 rounded-lg border border-white/[0.08] bg-[#17181b] divide-y divide-white/[0.05]">
          {report.feed.length === 0 && (
            <li className="px-5 py-6 text-[12.5px] text-zinc-600">No recorded changes yet.</li>
          )}
          {report.feed.map((row, i) => (
            <li key={i} className="flex items-baseline gap-3 px-5 py-3">
              <span className="h-[5px] w-[5px] self-center rounded-full bg-violet-400/70 shrink-0" />
              <p className="min-w-0 flex-1 text-[12.5px] text-zinc-300 leading-relaxed">{row.label}</p>
              <span className="shrink-0 font-mono text-[10.5px] text-zinc-600">{timeAgo(row.ts)}</span>
            </li>
          ))}
        </ul>

        <p className="mt-10 text-[11px] text-zinc-700">
          Produced by <a href="https://backenly.com" className="text-violet-300/80 hover:text-violet-200">Backenly</a> —
          the autonomous backend platform. The project owner can revoke this link at any time.
        </p>
      </div>
    </main>
  )
}
