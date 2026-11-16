'use client'

/**
 * Where to point an app or a coding agent so it tests against a branch
 * instead of production: the branch page's Preview section.
 *
 * There is no preview host. The branch answers at the project's own base URL
 * to a key bound to it, and every data response names the environment that
 * served it. So the section is those facts (URL, header, schema), the key,
 * the snippets that put them together and the branch's OpenAPI spec. The
 * coding agent, curl or the SDK do the testing; there is no request builder.
 */

import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { CopyButton, CopyField, KitButton, KitModal, KitRadio, Segmented } from '@/components/inspector/kit'
import { CodeWell } from '@/components/console/EventRow'
import { RefusedLine } from '@/components/console/states'
import { SecretOnceDialog } from '@/components/console/SecretOnceDialog'
import { FOCUS, RULE } from '@/components/console/tokens'
import { Panel } from '@/components/autonomy/rows'
import { refusal, type BranchPreview as Preview } from './data'

type Snippet = 'curl' | 'sdk' | 'agent'

export function BranchPreview({
  projectId,
  branch,
  canIssueKeys,
}: {
  projectId: string
  branch: { id: string; name: string; schemaName?: string; preview: Preview }
  /** Issuing a key is administration (POST /branches/[id]/keys). */
  canIssueKeys: boolean
}) {
  const { preview } = branch
  const [snippet, setSnippet] = useState<Snippet>('curl')
  const [asking, setAsking] = useState(false)
  const [issued, setIssued] = useState<{ key: string; serviceRole: boolean } | null>(null)
  const snippetText = snippet === 'curl' ? preview.curl : snippet === 'sdk' ? preview.sdk : preview.instructions
  const header = `${preview.environmentHeader.name}: ${preview.environmentHeader.value}`
  const facts: Array<{ label: string; value: string; copy: string }> = [
    { label: 'Base URL', value: preview.baseUrl, copy: 'Copy base URL' },
    { label: 'Data API', value: preview.dataUrl, copy: 'Copy data API URL' },
    { label: 'Header', value: header, copy: 'Copy response header' },
    ...(branch.schemaName ? [{ label: 'Schema', value: branch.schemaName, copy: 'Copy schema name' }] : []),
  ]

  return (
    <Panel>
      <div className="px-[16px] py-[14px] sm:px-[20px]">
        <p className="max-w-[760px] text-[13px] leading-[20px] text-zinc-400 [text-wrap:pretty]">
          Same URL as production. A branch key sends requests here. Functions, storage and realtime refuse a branch key.
        </p>
        <dl className="mt-[12px] grid grid-cols-1 gap-y-[6px] sm:grid-cols-[96px_minmax(0,1fr)] sm:gap-x-[16px] sm:gap-y-[8px]">
          {facts.map((f) => (
            <div key={f.label} className="contents">
              <dt className="pt-[2px] text-[12.5px] leading-[18px] text-faint sm:pt-[3px]">{f.label}</dt>
              <dd className="min-w-0 pb-[4px] sm:pb-0">
                <CopyField variant="inline" value={f.value} label={f.copy} wrap className="max-w-full" />
              </dd>
            </div>
          ))}
          <div className="contents">
            <dt className="pt-[2px] text-[12.5px] leading-[18px] text-faint sm:pt-[7px]">Key</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-x-[12px] gap-y-[6px]">
              {canIssueKeys ? (
                <>
                  <KitButton size="sm" icon={KeyRound} onClick={() => setAsking(true)}>
                    Create preview key
                  </KitButton>
                  <span className="text-[12.5px] leading-[18px] text-faint">It stops working when the branch is merged or discarded.</span>
                </>
              ) : (
                <span className="pt-[2px] text-[12.5px] leading-[18px] text-faint sm:pt-[5px]">Only admins can create preview keys.</span>
              )}
            </dd>
          </div>
        </dl>
      </div>

      <div className={`flex flex-wrap items-center justify-between gap-x-[12px] gap-y-[8px] border-t ${RULE} px-[16px] py-[8px] sm:px-[20px]`}>
        <Segmented<Snippet>
          label="Snippet"
          size="sm"
          value={snippet}
          onChange={setSnippet}
          options={[
            { value: 'curl', label: 'curl' },
            { value: 'sdk', label: 'SDK' },
            { value: 'agent', label: 'For your agent' },
          ]}
        />
        <div className="flex items-center gap-[4px]">
          <a
            href={preview.openapiUrl}
            download={`openapi-${branch.name}.json`}
            className={`rounded-[5px] px-[6px] py-[3px] text-[12.5px] font-medium text-faint transition-colors duration-150 hover:text-zinc-100 ${FOCUS}`}
          >
            OpenAPI spec
          </a>
          <CopyButton value={snippetText} label="Copy snippet" showLabel />
        </div>
      </div>
      <CodeWell maxHeight={280}>
        {snippetText}
      </CodeWell>

      <PreviewKeyDialog
        open={asking}
        onClose={() => setAsking(false)}
        projectId={projectId}
        branch={branch}
        onIssued={(key, serviceRole) => {
          setAsking(false)
          setIssued({ key, serviceRole })
        }}
      />
      <SecretOnceDialog
        open={!!issued}
        onClose={() => setIssued(null)}
        title={issued?.serviceRole ? `Server key for ${branch.name}` : `Preview key for ${branch.name}`}
        value={issued?.key ?? ''}
        copyLabel="Copy key"
      >
        Set it as <code className="font-mono text-[12px] text-zinc-300">BACKENLY_PREVIEW_KEY</code> in your app or tests. It stops
        working when the branch is merged or discarded.
        {issued?.serviceRole ? ' It skips row-level security on this branch, so keep it on a server.' : ''}
      </SecretOnceDialog>
    </Panel>
  )
}

/** Creates a key bound to the branch: a client key, or a server key that skips row-level security. */
function PreviewKeyDialog({
  open,
  onClose,
  projectId,
  branch,
  onIssued,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  branch: { id: string; name: string }
  onIssued: (key: string, serviceRole: boolean) => void
}) {
  const [kind, setKind] = useState<'client' | 'server'>('client')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const close = () => {
    if (busy) return
    setRefused(null)
    onClose()
  }
  const create = async () => {
    setBusy(true)
    setRefused(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/branches/${branch.id}/keys`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceRole: kind === 'server' }),
      })
      let j: { success?: boolean; key?: string; serviceRole?: boolean; error?: string } | null = null
      try {
        j = await res.json()
      } catch {
        j = null
      }
      if (!res.ok || !j?.success || typeof j.key !== 'string') {
        setRefused(refusal(j, 'No key was created.'))
        return
      }
      setKind('client')
      onIssued(j.key, j.serviceRole === true)
    } catch {
      setRefused('No key was created. The server did not answer.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <KitModal
      open={open}
      onClose={close}
      title="New preview key"
      description={
        <>
          For <span className="font-mono text-[12.5px] text-zinc-300">{branch.name}</span>. It is shown once.
        </>
      }
      footer={
        <>
          <KitButton variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </KitButton>
          <KitButton variant="primary" onClick={() => void create()} loading={busy}>
            Create key
          </KitButton>
        </>
      }
    >
      <div role="radiogroup" aria-label="Key type" className="space-y-[10px]">
        <KitRadio
          name="preview-key-kind"
          value="client"
          checked={kind === 'client'}
          onChange={() => setKind('client')}
          label="Client key"
          description="Row-level security applies, as with the production client key."
        />
        <KitRadio
          name="preview-key-kind"
          value="server"
          checked={kind === 'server'}
          onChange={() => setKind('server')}
          label="Server key"
          description="Skips row-level security on this branch. Keep it on a server."
        />
      </div>
      {refused && <RefusedLine className="mt-[12px]">{refused}</RefusedLine>}
    </KitModal>
  )
}
