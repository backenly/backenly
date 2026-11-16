'use client'

/**
 * A function's Code view: the exact stored source, what actually runs.
 *
 * deploy_code hands the agent a codeSha256 receipt; the hash here is the
 * SHA-256 of the SAME stored bytes, so the owner can compare the two without
 * trusting either side's summary (the deploy_code receipt). Above the source,
 * what the code reads and calls, found by reading it: the secrets it reads as
 * ctx.env.NAME (one that isn't set is said, with the way to Secrets) and the
 * providers it calls as ctx.integrations.<name> (one that isn't connected is
 * said, with the way to Integrations). A name the code computes is missed;
 * the lines say "found in code" by being plain facts about the text.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CopyButton, StatusGlyph } from '@/components/inspector/kit'
import { FOCUS, FOCUS_INSET, RULE, WELL } from '@/components/console/tokens'
import { integrationCatalog } from '@/components/hub/integration-catalog'
import { integrationAccessors, providersForAccessor } from '@/components/hub/integration-calls'
import { envReads, shortHash, type AiFunction } from './model'

const LINK = `rounded-[3px] underline decoration-white/25 underline-offset-[3px] transition-colors duration-150 hover:decoration-white/60 ${FOCUS}`

const providerNames = (): Map<string, string> => new Map(integrationCatalog().flatMap((c) => c.providers.map((p) => [p.id, p.name] as const)))

export function CodeView({
  projectId,
  fn,
  secretNames,
  onOpenSecrets,
}: {
  projectId: string
  fn: AiFunction
  /** The project's secret names, or null while unknown (no claim is made then). */
  secretNames: readonly string[] | null
  onOpenSecrets: () => void
}) {
  const code = fn.generatedCode ?? null
  const [sha, setSha] = useState<string | null>(null)
  useEffect(() => {
    if (!code || typeof crypto === 'undefined' || !crypto.subtle) return
    let cancelled = false
    crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(code))
      .then((buf) => {
        if (!cancelled) setSha(Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join(''))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [code])

  const reads = useMemo(() => envReads(code), [code])
  const calls = useMemo(() => integrationAccessors(code), [code])
  const connected = useConnectedProviders(projectId, calls.length > 0)
  const names = useMemo(() => providerNames(), [])

  if (!code) {
    return (
      <p className="px-[16px] py-[16px] text-[13px] leading-[20px] text-zinc-400 sm:px-[20px]">
        No stored source. Functions deployed with deploy_code or written by Backenly keep their exact source here.
      </p>
    )
  }

  const lines = code.replace(/\n$/, '').split('\n')
  return (
    <div>
      <dl className={`space-y-[6px] border-b ${RULE} px-[16px] py-[12px] text-[12.5px] leading-[18px] sm:px-[20px]`}>
        <div className="flex flex-wrap items-center gap-x-[10px] gap-y-[4px]">
          <dt className="w-[56px] flex-shrink-0 text-faint">SHA-256</dt>
          <dd className="flex min-w-0 items-center gap-[4px]">
            {sha ? (
              <>
                <code
                  title="deploy_code gave your agent a codeSha256 receipt. It matches this when the stored code is what it deployed."
                  className="font-mono text-[12px] text-zinc-300"
                >
                  {shortHash(sha)}
                </code>
                <CopyButton value={sha} label="Copy SHA-256" className="!h-[22px] !w-[22px]" />
              </>
            ) : (
              <span className="text-faint">Computing</span>
            )}
          </dd>
        </div>
        {reads.length > 0 && (
          <div className="flex flex-wrap items-baseline gap-x-[10px] gap-y-[4px]">
            <dt className="w-[56px] flex-shrink-0 text-faint">Reads</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-x-[14px] gap-y-[4px]">
              {reads.map((name) => {
                const missing = secretNames !== null && !secretNames.includes(name)
                return (
                  <span key={name} className="inline-flex items-center gap-[8px]">
                    <code className="font-mono text-[12px] text-zinc-300">ctx.env.{name}</code>
                    {missing && (
                      <button type="button" onClick={onOpenSecrets} className={`inline-flex items-center gap-[6px] font-medium text-zinc-50 ${LINK}`}>
                        <StatusGlyph state="waiting" label="Missing" />
                        {name} isn&apos;t set
                      </button>
                    )}
                  </span>
                )
              })}
            </dd>
          </div>
        )}
        {calls.length > 0 && (
          <div className="flex flex-wrap items-baseline gap-x-[10px] gap-y-[4px]">
            <dt className="w-[56px] flex-shrink-0 text-faint">Calls</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-x-[14px] gap-y-[4px]">
              {calls.map((accessor) => {
                const providers = providersForAccessor(accessor)
                const hit = connected ? providers.find((p) => connected.includes(p)) : undefined
                const target = hit ?? providers[0]
                const missing = connected !== null && providers.length > 0 && !hit
                return (
                  <span key={accessor} className="inline-flex items-center gap-[8px]">
                    {target ? (
                      <Link href={`/app/projects/${projectId}/integrations?connector=${encodeURIComponent(target)}`} className={`font-mono text-[12px] text-zinc-300 ${LINK}`}>
                        ctx.integrations.{accessor}
                      </Link>
                    ) : (
                      <code className="font-mono text-[12px] text-zinc-300">ctx.integrations.{accessor}</code>
                    )}
                    {missing && target && (
                      <span className="inline-flex items-center gap-[6px] font-medium text-zinc-50">
                        <StatusGlyph state="waiting" label="Not connected" />
                        {names.get(target) ?? target} isn&apos;t connected
                      </span>
                    )}
                  </span>
                )
              })}
            </dd>
          </div>
        )}
      </dl>
      <pre
        tabIndex={0}
        aria-label={`${fn.name} source`}
        className={`overflow-x-auto py-[12px] font-mono text-[12px] leading-[19px] text-zinc-300 ${WELL} ${FOCUS_INSET}`}
      >
        <code className="grid grid-cols-[auto_minmax(0,1fr)]">
          {lines.map((l, i) => (
            <span key={i} className="contents">
              <span aria-hidden className="select-none pl-[16px] pr-[16px] text-right tabular-nums text-zinc-600 sm:pl-[20px]">
                {i + 1}
              </span>
              <span className="whitespace-pre pr-[20px]">{l || ' '}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}

/** The providers with a stored key (GET /integrations keyVault), or null while unknown or unreadable. */
function useConnectedProviders(projectId: string, wanted: boolean): string[] | null {
  const [ids, setIds] = useState<string[] | null>(null)
  useEffect(() => {
    if (!wanted) return
    let cancelled = false
    fetch(`/api/projects/${projectId}/integrations`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d || typeof d.keyVault !== 'object' || d.keyVault === null) return
        setIds(Object.keys(d.keyVault))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectId, wanted])
  return ids
}
