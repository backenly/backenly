'use client'

/**
 * POSTGRESQL EXTENSIONS
 *
 * What the SERVER says, read from `pg_extension` and
 * `pg_available_extensions` on every load: a dashboard reporting an extension
 * that someone removed at a psql prompt is exactly the drift to avoid.
 *
 * Install appears only where installing can work: PostgreSQL 13+ lets a
 * non-superuser install TRUSTED extensions, and Backenly's role is
 * deliberately not a superuser, so anything else shows the server's reason.
 * There is no uninstall: `DROP EXTENSION` cascades into columns and indexes
 * this page cannot show.
 */

import { useCallback, useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { KitButton } from '@/components/inspector/kit'
import { EmptyLine, Fact, Facts, Panel, Row, RowList, RowSkeleton, ROW_TEXT, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { ErrorRow, RefusedLine } from '@/components/console/states'

interface ExtensionRow {
  name: string
  purpose: string
  caveat?: string
  available: boolean
  installed: boolean
  installedVersion: string | null
  defaultVersion: string | null
  schema: string | null
  trusted: boolean | null
  installable: boolean
  blockedReason: string | null
}

export function ExtensionsPanel({ projectId, canAdminister = false }: { projectId: string; canAdminister?: boolean }) {
  const [rows, setRows] = useState<ExtensionRow[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'done' | 'refused'; name: string; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/database/extensions`, { credentials: 'include' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error)
      setRows(data.extensions ?? [])
      setState('ready')
    } catch {
      setState('failed')
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  async function install(name: string) {
    setBusy(name)
    setNotice(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/database/extensions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'The extension was not installed.')
      setRows(data.extensions ?? rows)
      setNotice({ tone: 'done', name, text: data.alreadyInstalled ? `${name} was already installed.` : `${name} ${data.version ?? ''} installed.`.replace(/\s+installed/, ' installed') })
    } catch (err) {
      // PostgreSQL's own words where it refused.
      setNotice({ tone: 'refused', name, text: err instanceof Error ? err.message : 'The extension was not installed.' })
    } finally {
      setBusy(null)
    }
  }

  const installed = rows.filter((r) => r.installed)
  const available = rows.filter((r) => !r.installed)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full max-w-[880px] space-y-[32px] px-[16px] py-[24px] sm:px-[24px]">
        {state === 'failed' ? (
          <Section id="extensions-error" title="Extensions">
            <Panel>
              <ErrorRow things="extensions" onRetry={() => void load()} />
            </Panel>
          </Section>
        ) : (
          <>
            <Section id="extensions-installed" title="Installed" count={installed.length} description="Extensions apply to the whole database, not one project.">
              <Panel>
                {state === 'loading' ? (
                  <RowSkeleton rows={2} />
                ) : installed.length === 0 ? (
                  <EmptyLine>None installed.</EmptyLine>
                ) : (
                  <RowList>
                    {installed.map((ext) => (
                      <Row key={ext.name} lead="glyph" glyph="live" glyphLabel="Installed" title={<span className={`${ROW_TITLE} font-mono !text-[12.5px]`}>{ext.name}</span>}>
                        <p className={`${ROW_TEXT} !mt-[2px]`}>{ext.purpose}</p>
                        <Facts className="!mt-[6px]">
                          {ext.installedVersion && <Fact>Version {ext.installedVersion}</Fact>}
                          {ext.schema && (
                            <Fact>
                              In <code className="font-mono text-[11.5px] text-zinc-400">{ext.schema}</code>
                            </Fact>
                          )}
                        </Facts>
                        {notice?.name === ext.name && notice.tone === 'done' && (
                          <p role="status" className="mt-[6px] text-[12.5px] text-zinc-300">
                            {notice.text}
                          </p>
                        )}
                      </Row>
                    ))}
                  </RowList>
                )}
              </Panel>
            </Section>

            <Section id="extensions-available" title="Available" count={available.length}>
              <Panel>
                {state === 'loading' ? (
                  <RowSkeleton rows={3} />
                ) : available.length === 0 ? (
                  <EmptyLine>Every extension Backenly offers is installed.</EmptyLine>
                ) : (
                  <RowList>
                    {available.map((ext) => (
                      <Row
                        key={ext.name}
                        lead="glyph"
                        glyph="idle"
                        glyphLabel="Not installed"
                        title={<span className={`${ROW_TITLE} font-mono !text-[12.5px]`}>{ext.name}</span>}
                        actions={
                          canAdminister && ext.installable ? (
                            <KitButton size="sm" icon={Download} loading={busy === ext.name} disabled={busy !== null && busy !== ext.name} onClick={() => void install(ext.name)}>
                              Install
                            </KitButton>
                          ) : undefined
                        }
                      >
                        <p className={`${ROW_TEXT} !mt-[2px]`}>{ext.purpose}</p>
                        {!ext.installable && ext.blockedReason && <p className="mt-[6px] text-[12.5px] leading-[18px] text-faint">{ext.blockedReason}</p>}
                        {notice?.name === ext.name && notice.tone === 'refused' && <RefusedLine className="mt-[6px]">{notice.text}</RefusedLine>}
                      </Row>
                    ))}
                  </RowList>
                )}
              </Panel>
            </Section>
          </>
        )}
      </div>
    </div>
  )
}
