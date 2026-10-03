'use client'

/**
 * DEPLOYMENT RECOVERY — the operator-facing half of lib/recovery.
 *
 * ── Why export is here and restore is not ───────────────────────────────────
 *
 * A recovery bundle exists for the day the deployment is gone, and this
 * dashboard IS part of the deployment. On the morning you need to restore there
 * is no web app to click a button in: there is a new machine, a checkout, a
 * bundle and a credential. So restore is a command, and this page tells the
 * operator what that command is rather than offering a control that could only
 * ever work when it was not needed.
 *
 * Export is here because export happens while the deployment is healthy, which
 * is exactly when somebody is looking at this page.
 *
 * ── Why the credential is shown the way it is ───────────────────────────────
 *
 * It is generated inside the export and returned once. Nothing stores it - not
 * the bundle, not the database, not a log - which is the property that makes
 * the bundle safe to keep. It also means closing this panel loses it for good,
 * so that is said before the operator can, and the panel will not let itself be
 * dismissed without an acknowledgement.
 *
 * ── Why the path is shown at all ────────────────────────────────────────────
 *
 * The bundle is written to the server's own disk. A backup that only exists on
 * the machine it protects is not a backup, and a panel that showed a green tick
 * and no path would let an operator believe otherwise.
 */

import { useState } from 'react'
import {
  LifeBuoy, Download, Loader2, Copy, Check, AlertTriangle, Terminal,
} from 'lucide-react'
import {
  KitCard, KitCardHeader, KitCardBody, KitButton, KitNote,
} from '@/components/inspector/kit'

interface ComponentSummary {
  component: string
  bytes: number
  items: number
  encrypted: boolean
}

interface ExportResult {
  bundleDir: string
  credential: string
  createdAt: string
  components: ComponentSummary[]
  absent: string[]
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function DeploymentRecoverySection() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  async function runExport() {
    setRunning(true)
    setError(null)
    try {
      const res = await fetch('/api/deployment/recovery/export', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'The export failed.')
      setResult(data as ExportResult)
      setAcknowledged(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The export failed.')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-4">
      <KitCard>
        <KitCardHeader
          title={<span className="inline-flex items-center gap-2"><LifeBuoy className="h-4 w-4 text-zinc-400" />Deployment recovery</span>}
          description="Everything needed to rebuild this deployment on a clean machine."
        />
        <KitCardBody>
          <p className="text-[12.5px] leading-relaxed text-zinc-400">
            A recovery bundle carries the platform database, every project schema, stored
            files, function definitions and the project secrets clients are configured
            against. It is <span className="text-zinc-200">not</span> the same thing as a
            project database snapshot, which covers one project&rsquo;s tables and rows.
          </p>

          <div className="mt-4">
            <KitButton
              variant="primary"
              icon={running ? Loader2 : Download}
              onClick={runExport}
              disabled={running}
            >
              {running ? 'Writing bundle…' : 'Create recovery bundle'}
            </KitButton>
          </div>

          {error && (
            <div className="mt-4">
              <KitNote tone="danger">{error}</KitNote>
            </div>
          )}
        </KitCardBody>
      </KitCard>

      {result && (
        <KitCard className="border-amber-500/20">
          <div className="flex items-center gap-2.5 border-b border-amber-500/[0.12] bg-amber-500/[0.03] px-5 py-3.5">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            <div>
              <h2 className="text-[13px] font-semibold text-white">
                Recovery credential — shown once
              </h2>
              <p className="text-[12.5px] text-zinc-500">
                Not stored anywhere. If you lose it, this bundle cannot be opened by anyone.
              </p>
            </div>
          </div>
          <KitCardBody>
            <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-3 py-2.5">
              <code className="flex-1 font-mono text-[13px] tracking-wide text-white">
                {result.credential}
              </code>
              <KitButton
                variant="secondary"
                size="sm"
                icon={copied ? Check : Copy}
                onClick={() => {
                  navigator.clipboard?.writeText(result.credential).catch(() => {})
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </KitButton>
            </div>

            <p className="mt-3 text-[12px] leading-relaxed text-zinc-400">
              Store it somewhere other than beside the bundle. The two together restore
              the deployment; the bundle alone discloses nothing.
            </p>

            <label className="mt-4 flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={e => setAcknowledged(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 accent-violet-500"
              />
              <span className="text-[12px] text-zinc-300">
                I have saved this credential somewhere I will still have it if this server
                is gone.
              </span>
            </label>

            {acknowledged && (
              <div className="mt-4">
                <KitButton variant="secondary" size="sm" onClick={() => setResult(null)}>
                  Done
                </KitButton>
              </div>
            )}
          </KitCardBody>
        </KitCard>
      )}

      {result && (
        <KitCard>
          <KitCardHeader
            title="What this bundle contains"
            description={`Written ${new Date(result.createdAt).toLocaleString()}`}
          />
          <KitCardBody>
            <div className="overflow-hidden rounded-lg border border-white/[0.06]">
              <table className="w-full text-[12px]">
                <tbody>
                  {result.components.map(component => (
                    <tr key={component.component} className="border-b border-white/[0.04] last:border-0">
                      <td className="px-3 py-2 text-zinc-300">{component.component}</td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-500">
                        {component.items} item{component.items === 1 ? '' : 's'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-500">
                        {formatBytes(component.bytes)}
                      </td>
                      <td className="px-3 py-2 text-right text-[12px] text-zinc-600">
                        {component.encrypted ? 'sealed' : 'plain'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {result.absent.length > 0 && (
              <p className="mt-3 text-[12px] text-zinc-500">
                Not in this bundle: {result.absent.join(', ')}.
              </p>
            )}

            <div className="mt-4">
            <KitNote tone="warn">
              The bundle is on this server, at{' '}
              <code className="font-mono text-[12.5px] text-zinc-300">{result.bundleDir}</code>.
              Copy it somewhere else. A backup that only exists on the machine it protects
              is not a backup.
            </KitNote>
            </div>
          </KitCardBody>
        </KitCard>
      )}

      <KitCard>
        <KitCardHeader
          title={<span className="inline-flex items-center gap-2"><Terminal className="h-4 w-4 text-zinc-400" />Restoring</span>}
          description="A command, not a button — and deliberately so."
        />
        <KitCardBody>
          <p className="text-[12.5px] leading-relaxed text-zinc-400">
            On the day you restore, this dashboard is part of what you lost. Recovery runs
            from a checkout on the new machine:
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 font-mono text-[12px] leading-relaxed text-zinc-300">
{`npm run recovery -- verify  --bundle ./recovery/<timestamp>
npm run recovery -- restore --bundle ./recovery/<timestamp>`}
          </pre>
          <p className="mt-3 text-[12.5px] leading-relaxed text-zinc-400">
            <span className="text-zinc-200">verify</span> checks the manifest, every
            checksum and opens each sealed component with your credential, and changes
            nothing. Run it on an ordinary day: an untested backup is a rumour.
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-zinc-400">
            A restore replaces the target. Sessions and one-time tokens are not brought
            back, so everyone signs in again, and nothing is touched until the whole
            archive has passed validation.
          </p>
        </KitCardBody>
      </KitCard>
    </div>
  )
}
