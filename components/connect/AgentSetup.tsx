'use client'

/**
 * Connecting a coding agent to this project: one panel on Overview (a new
 * project) and on Connect (no agent yet), and the same parts in Connect's
 * "Add agent" dialog.
 *
 *   ✳ Claude Code   ◩ Cursor   ◎ Codex   ⋀ Antigravity   Other        [Local|Remote]
 *   claude mcp add backenly -- npx -y @backenly/mcp-server --project p_todo
 *     --key mcp_live_af6a4f6…                                         [◉] [Copy]
 *   Run it in a terminal, then start a new Claude Code session.        [Generate key]
 *   ◐ Waiting for the first call                                  [Test connection]
 *   Destructive changes wait for your approval.  Setup guide
 *
 * The commands are the verified ones in AgentInstallGuide.tsx, one per agent
 * and transport. "Generate key" mints a real scoped key (POST /mcp/keys),
 * named after the chosen agent rather than "Agent setup", and puts it in the
 * command. The key is masked on screen to the prefix the agents list shows;
 * Copy, a copy made by selecting the text, and the eye all carry the real key.
 *
 * After a key exists the panel asks every 5 s, for up to 10 minutes and only
 * while the tab is in view, whether the agent has called
 * (refreshAgentConnection). When it has, every surface reading
 * useAgentConnection switches without a reload: Overview moves on to "Ask it
 * to build", Connect to its agents list, the top bar drops "Connect agent".
 *
 * Only owners and admins can create keys (POST /mcp/keys is ADMIN), so the
 * pages show this panel only to them and one sentence to everyone else.
 */

import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Eye, EyeOff } from 'lucide-react'
import { CopyButton, KitButton, KitField, KitInput, KitModal, KitSelect, KitSwitch, Segmented, StatusGlyph } from '@/components/inspector/kit'
import { EDGE, FOCUS, FOCUS_INSET, PLATE, RULE, R_CONTROL, R_PANEL, WELL } from '@/components/console/tokens'
import { RefusedLine, docsHref } from '@/components/console/states'
import { Time } from '@/components/console/Time'
import { refreshAgentConnection, useAgentConnection } from '@/lib/hooks/useAgentConnection'
import { AGENTS, KEY_PLACEHOLDER, type Agent, type Transport } from './AgentInstallGuide'
import { AGENT_ICON, GenericAgentIcon } from './AgentBrandIcons'
import { CliText, JsonText } from './CodeSurface'

// ── Talking to the server ─────────────────────────────────────────────────────

export interface MintedKey {
  id: string
  rawKey: string
  label: string | null
}

/** A JSON body read through text(), so a missing or broken body is null, never a throw. */
async function readBody(res: Response): Promise<any> {
  try {
    if (typeof res.text === 'function') {
      const text = await res.text()
      return text ? JSON.parse(text) : null
    }
    return await res.json()
  } catch {
    return null
  }
}

/** Mint a scoped MCP key. The plaintext comes back once, here. */
export async function mintAgentKey(projectId: string, opts: { label: string; readOnly?: boolean }): Promise<MintedKey> {
  const res = await fetch(`/api/projects/${projectId}/mcp/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Read-only is decided here, at issuance, by a person: the runtime serves
    // a read-only key 16 tools instead of 23, and no endpoint flips it later.
    body: JSON.stringify({ label: opts.label, readOnly: opts.readOnly === true }),
  })
  const data = await readBody(res)
  if (!res.ok || !data?.rawKey) throw new Error(data?.error || `Could not create the key (HTTP ${res.status}).`)
  return { id: data.key?.id ?? '', rawKey: data.rawKey, label: data.key?.label ?? opts.label }
}

export interface TestResult {
  ok: boolean
  message: string
}

/**
 * The call the npm package makes when it starts, with the new key: proof the
 * key works end to end without leaving the console. Authenticating marks the
 * key used, so the agent then counts as connected: callers refresh the
 * connection themselves, after keeping their panel up.
 */
export async function testAgentKey(rawKey: string): Promise<TestResult> {
  try {
    const res = await fetch('/api/mcp/health', { headers: { 'x-api-key': rawKey } })
    const data = await readBody(res)
    if (!res.ok || !data) return { ok: false, message: data?.error || `The key was refused (HTTP ${res.status}).` }
    return { ok: true, message: `Connected. ${data.toolCount} tools on ${data.project?.name ?? data.projectId}.` }
  } catch {
    return { ok: false, message: 'Could not reach Backenly. Check your connection and try again.' }
  }
}

/** What a key is called when it is made for an agent: the agent's own name. */
export function keyLabelFor(agent: Pick<Agent, 'id' | 'name'>): string {
  return agent.id === 'other' ? 'MCP client' : agent.name
}

const agentById = (id: string): Agent => AGENTS.find((a) => a.id === id) ?? AGENTS[0]

/** Which agent a key's label or a client's name is ("Claude Code — MacBook" is Claude Code), else 'other'. */
export function agentIdFor(label: string | null | undefined): string {
  const text = (label ?? '').toLowerCase()
  return AGENTS.find((a) => a.id !== 'other' && text.includes(a.name.toLowerCase()))?.id ?? 'other'
}

/** An agent's brand mark, as a stable component (a row's lead takes a component). */
export function agentMarkFor(label: string | null | undefined) {
  return AGENT_ICON[agentIdFor(label)] ?? GenericAgentIcon
}

/** The brand mark for an agent id, or the mark a key's label names. */
export function AgentMark({ id, label, size = 16, className = '' }: { id?: string; label?: string | null; size?: number; className?: string }) {
  const Icon = AGENT_ICON[id ?? agentIdFor(label)] ?? GenericAgentIcon
  return <Icon size={size} className={`flex-shrink-0 ${className}`} />
}

// ── Pieces ────────────────────────────────────────────────────────────────────

/**
 * One agent at a time, with its mark. Tabs from `sm` (arrow keys move between
 * them); a select on a phone, so no agent hides off the edge.
 */
function AgentPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const at = Math.max(0, AGENTS.findIndex((a) => a.id === value))
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (at + step + AGENTS.length) % AGENTS.length
    onChange(AGENTS[next].id)
    refs.current[next]?.focus()
  }
  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-[8px] pl-[14px] sm:hidden">
        <AgentMark id={value} size={15} />
        <KitSelect variant="quiet" aria-label="Coding agent" value={value} onChange={(e) => onChange(e.target.value)} wrapperClassName="min-w-0">
          {AGENTS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </KitSelect>
      </div>
      <div role="radiogroup" aria-label="Coding agent" className="hidden min-w-0 flex-1 items-stretch self-stretch pl-[6px] sm:flex">
        {AGENTS.map((a, i) => {
          const on = a.id === value
          return (
            <button
              key={a.id}
              ref={(el) => {
                refs.current[i] = el
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(a.id)}
              onKeyDown={onKey}
              className={`group relative flex flex-shrink-0 items-center gap-[7px] px-[10px] text-[13px] font-medium transition-colors duration-150 ${FOCUS_INSET} ${
                on ? 'text-white' : 'text-faint hover:text-zinc-200'
              }`}
            >
              <AgentMark id={a.id} size={14} className={on ? '' : 'opacity-60 transition-opacity group-hover:opacity-100'} />
              {a.name}
              <span aria-hidden className={`absolute inset-x-[10px] bottom-0 h-[1.5px] rounded-full ${on ? 'bg-white' : 'bg-transparent'}`} />
            </button>
          )
        })}
      </div>
    </>
  )
}

function TransportSwitch({ value, onChange }: { value: Transport; onChange: (t: Transport) => void }) {
  return (
    <Segmented<Transport>
      size="sm"
      label="How the agent reaches Backenly"
      value={value}
      onChange={onChange}
      options={[
        { value: 'local', label: 'Local', title: 'Runs the npm package on your machine. Works in every host.' },
        { value: 'remote', label: 'Remote', title: 'Your agent connects straight to Backenly. Nothing to install.' },
      ]}
    />
  )
}

/**
 * The command (or config block) for one agent and transport, with the key in
 * it. Reveal and Copy appear once there is a real key to carry.
 */
export function AgentCommand({ projectId, agent, transport, rawKey }: { projectId: string; agent: Agent; transport: Transport; rawKey: string | null }) {
  const [revealed, setRevealed] = useState(false)
  const variant = agent[transport]
  // The same prefix the agents list shows, so the command and its row match.
  const masked = rawKey ? `${rawKey.slice(0, 16)}…` : KEY_PLACEHOLDER
  const command = variant.build(projectId, rawKey ?? KEY_PLACEHOLDER)
  const shown = revealed && rawKey ? command : variant.build(projectId, masked)

  // A copy made by selecting the masked command by hand gets the real key too.
  const copySelection = (event: ClipboardEvent<HTMLPreElement>) => {
    if (!rawKey || revealed) return
    const selected = window.getSelection()?.toString() ?? ''
    if (!selected.includes(masked)) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', selected.split(masked).join(rawKey))
  }

  return (
    <div className={`flex items-start gap-[8px] ${WELL} py-[10px] pl-[16px] pr-[8px]`}>
      <pre
        onCopy={copySelection}
        aria-label={`${agent.name} ${variant.kind === 'json' ? 'config' : 'command'}`}
        className="min-w-0 flex-1 whitespace-pre-wrap break-words py-[3px] font-mono text-[12px] leading-[20px] text-zinc-400 [font-variant-ligatures:none]"
      >
        {variant.kind === 'json' ? <JsonText text={shown} /> : <CliText text={shown} />}
      </pre>
      {rawKey && (
        <span className="flex flex-shrink-0 items-center gap-[2px]">
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            aria-pressed={revealed}
            aria-label={revealed ? 'Hide key' : 'Show key'}
            title={revealed ? 'Hide key' : 'Show key'}
            className={`inline-flex h-[26px] w-[26px] items-center justify-center ${R_CONTROL} text-zinc-500 transition-colors duration-150 hover:bg-white/[0.06] hover:text-zinc-100 ${FOCUS}`}
          >
            {revealed ? <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} /> : <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />}
          </button>
          <CopyButton value={command} label="Copy" showLabel />
        </span>
      )}
    </div>
  )
}

/** The one line under a command: where it goes and how the host picks it up. */
function NextLine({ children }: { children: ReactNode }) {
  return (
    <p className="min-w-0 text-[12.5px] leading-[18px] text-faint [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-zinc-300">{children}</p>
  )
}

type TestState = { phase: 'idle' } | { phase: 'testing' } | ({ phase: 'done' } & TestResult)

/** "◐ Waiting for the first call" and Test connection, or what the test said, or that the agent connected. */
function KeyStatus({
  projectId,
  rawKey,
  test,
  onTest,
  followAgent = true,
}: {
  projectId: string
  rawKey: string
  test: TestState
  onTest: () => void
  /**
   * Say when the person's agent connects. Only for their first agent: with one
   * already connected (Add agent), that would describe the old key, not this one.
   */
  followAgent?: boolean
}) {
  const agent = useAgentConnection(projectId)
  let line: ReactNode
  if (test.phase === 'done' && !test.ok) {
    line = (
      <>
        <StatusGlyph state="failed" label="Test failed" />
        <span className="min-w-0 text-rose-300 [overflow-wrap:anywhere]">{test.message}</span>
      </>
    )
  } else if (test.phase === 'done' && test.ok) {
    line = (
      <>
        <StatusGlyph state="done" label="Test passed" />
        <span className="min-w-0 text-zinc-200">{test.message}</span>
      </>
    )
  } else if (!followAgent) {
    line = (
      <>
        <StatusGlyph state="idle" label="Not used yet" />
        <span className="min-w-0 text-zinc-300">Not used yet</span>
      </>
    )
  } else if (agent.connected) {
    line = (
      <>
        <StatusGlyph state="live" label="Connected" />
        <span className="min-w-0 text-zinc-200">
          Connected{agent.client ? ` through ${agent.client}` : ''}.
          {agent.lastSeenAt && (
            <>
              {' '}
              <Time iso={agent.lastSeenAt} prefix="Last call" />.
            </>
          )}
        </span>
      </>
    )
  } else {
    line = (
      <>
        <StatusGlyph state="busy" label="Waiting" />
        <span className="min-w-0 text-zinc-300">Waiting for the first call</span>
      </>
    )
  }
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[8px] border-t ${RULE} px-[16px] py-[10px]`}>
      <p role="status" aria-live="polite" className="flex min-w-0 flex-1 items-center gap-[8px] text-[13px] leading-[20px]">
        {line}
      </p>
      {!(test.phase === 'done' && test.ok) && (
        <KitButton size="sm" onClick={onTest} loading={test.phase === 'testing'} aria-label={`Test connection with ${rawKey.slice(0, 16)}…`}>
          Test connection
        </KitButton>
      )}
    </div>
  )
}

/** The line under the setup: the promise that matters most, and the guide. */
export function SetupFootnote({ className = '' }: { className?: string }) {
  return (
    <p className={`text-[12.5px] leading-[18px] text-faint ${className}`}>
      Destructive changes wait for your approval.{' '}
      <a
        href={docsHref('connect')}
        target="_blank"
        rel="noopener noreferrer"
        className={`rounded-[3px] text-zinc-300 underline decoration-white/25 underline-offset-[3px] transition-colors duration-150 hover:text-white hover:decoration-white/60 ${FOCUS}`}
      >
        Setup guide
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </p>
  )
}

// ── Inline setup (Overview, Connect with no agent) ────────────────────────────

/** How often, and for how long, a fresh key is watched for its first call. */
const WATCH_EVERY_MS = 5_000
const WATCH_FOR_MS = 10 * 60_000

export function AgentSetup({
  projectId,
  onKeyCreated,
  onTested,
  className = '',
}: {
  projectId: string
  /** After Generate key, so a keys list can show the new key. */
  onKeyCreated?: (key: MintedKey) => void
  /**
   * After Test connection passes. The test authenticates with the key, which
   * counts as connected, so a page that switches on that must keep this panel
   * up: the key is in the command and is not shown again.
   */
  onTested?: () => void
  className?: string
}) {
  const agentConnection = useAgentConnection(projectId)
  const [agentId, setAgentId] = useState<string>(AGENTS[0].id)
  const [transport, setTransport] = useState<Transport>('local')
  const [key, setKey] = useState<MintedKey | null>(null)
  const [minting, setMinting] = useState(false)
  const [mintError, setMintError] = useState<string | null>(null)
  const [test, setTest] = useState<TestState>({ phase: 'idle' })
  const agent = agentById(agentId)

  // The live switch: once a key exists, watch for the agent's first call.
  useEffect(() => {
    if (!key || agentConnection.connected) return
    const started = Date.now()
    const timer = setInterval(() => {
      if (Date.now() - started > WATCH_FOR_MS) {
        clearInterval(timer)
        return
      }
      if (!document.hidden) void refreshAgentConnection(projectId)
    }, WATCH_EVERY_MS)
    return () => clearInterval(timer)
  }, [key, agentConnection.connected, projectId])

  async function generate() {
    setMinting(true)
    setMintError(null)
    try {
      const minted = await mintAgentKey(projectId, { label: keyLabelFor(agent) })
      setKey(minted)
      setTest({ phase: 'idle' })
      onKeyCreated?.(minted)
    } catch (err) {
      setMintError(err instanceof Error ? err.message : 'Could not create the key. Try again.')
    } finally {
      setMinting(false)
    }
  }

  async function runTest() {
    if (!key) return
    setTest({ phase: 'testing' })
    const result = await testAgentKey(key.rawKey)
    setTest({ phase: 'done', ...result })
    if (result.ok) {
      // Keep this panel up first, committed now: the refresh that follows says
      // "connected", and a store update renders ahead of batched state.
      if (onTested) flushSync(onTested)
      void refreshAgentConnection(projectId)
    }
  }

  return (
    <div className={className}>
      <div className={`overflow-hidden ${R_PANEL} border ${EDGE} ${PLATE}`}>
        <div className={`flex min-h-[44px] items-stretch justify-between gap-[8px] border-b ${RULE} pr-[10px]`}>
          <AgentPicker value={agent.id} onChange={setAgentId} />
          <span className="flex flex-shrink-0 items-center">
            <TransportSwitch value={transport} onChange={setTransport} />
          </span>
        </div>
        <AgentCommand projectId={projectId} agent={agent} transport={transport} rawKey={key?.rawKey ?? null} />
        <div className={`flex flex-col gap-[10px] border-t ${RULE} px-[16px] py-[12px] sm:flex-row sm:items-center sm:justify-between sm:gap-[16px]`}>
          <NextLine>{agent[transport].next}</NextLine>
          <KitButton
            variant={key ? 'secondary' : 'primary'}
            loading={minting}
            onClick={generate}
            className="self-start sm:self-auto"
          >
            {key ? 'New key' : 'Generate key'}
          </KitButton>
        </div>
        {mintError && (
          <div className={`border-t ${RULE} px-[16px] py-[10px]`}>
            <RefusedLine>{mintError}</RefusedLine>
          </div>
        )}
        {key && <KeyStatus projectId={projectId} rawKey={key.rawKey} test={test} onTest={runTest} />}
      </div>
      <SetupFootnote className="mt-[10px]" />
    </div>
  )
}

// ── The Add agent dialog (Connect) ────────────────────────────────────────────

/**
 * One flow for every agent key: choose the agent, name the key, read-only or
 * not, then the same dialog shows that agent's command with the real key and
 * tests it. It replaces "Generate key", the old "New key" dialog and the
 * reveal box, which all made the same request.
 */
export function AddAgentDialog({
  open,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean
  projectId: string
  onClose: () => void
  /** Right after the key is made, so the list shows it behind the dialog. */
  onCreated?: (key: MintedKey) => void
}) {
  const nameId = useId()
  const [agentId, setAgentId] = useState<string>(AGENTS[0].id)
  const [name, setName] = useState(keyLabelFor(AGENTS[0]))
  const [named, setNamed] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const [transport, setTransport] = useState<Transport>('local')
  const [key, setKey] = useState<MintedKey | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<TestState>({ phase: 'idle' })
  const [wasOpen, setWasOpen] = useState(open)
  const agent = agentById(agentId)

  // Each opening starts from the first step (reset while rendering, not in an effect).
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setAgentId(AGENTS[0].id)
      setName(keyLabelFor(AGENTS[0]))
      setNamed(false)
      setReadOnly(false)
      setTransport('local')
      setKey(null)
      setError(null)
      setTest({ phase: 'idle' })
    }
  }

  const pickAgent = (id: string) => {
    setAgentId(id)
    // The name follows the agent until the person types their own.
    if (!named) setName(keyLabelFor(agentById(id)))
  }

  async function create() {
    if (creating) return
    setCreating(true)
    setError(null)
    try {
      const minted = await mintAgentKey(projectId, { label: name.trim() || keyLabelFor(agent), readOnly })
      setKey(minted)
      onCreated?.(minted)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the key. Try again.')
    } finally {
      setCreating(false)
    }
  }

  async function runTest() {
    if (!key) return
    setTest({ phase: 'testing' })
    const result = await testAgentKey(key.rawKey)
    setTest({ phase: 'done', ...result })
    if (result.ok) void refreshAgentConnection(projectId)
  }

  const close = () => {
    if (!creating) onClose()
  }

  return (
    <KitModal
      open={open}
      onClose={close}
      title={key ? `Add Backenly to ${agent.name}` : 'Add agent'}
      description={key ? 'Copy it now. It won’t be shown again.' : 'A key scoped to this project, named so you can tell it apart later.'}
      width="max-w-[640px]"
      footer={
        key ? (
          <KitButton variant="primary" onClick={onClose}>
            Done
          </KitButton>
        ) : (
          <>
            <KitButton variant="ghost" onClick={close} disabled={creating}>
              Cancel
            </KitButton>
            <KitButton variant="primary" loading={creating} onClick={create}>
              Create key
            </KitButton>
          </>
        )
      }
    >
      {key ? (
        <div className={`overflow-hidden ${R_PANEL} border ${EDGE} ${PLATE}`}>
          <div className={`flex min-h-[40px] items-center justify-between gap-[8px] border-b ${RULE} pl-[14px] pr-[10px]`}>
            <span className="flex min-w-0 items-center gap-[8px] text-[13px] font-medium text-zinc-100">
              <AgentMark id={agent.id} size={14} />
              <span className="truncate">{agent.name}</span>
            </span>
            <TransportSwitch value={transport} onChange={setTransport} />
          </div>
          <AgentCommand projectId={projectId} agent={agent} transport={transport} rawKey={key.rawKey} />
          <div className={`border-t ${RULE} px-[16px] py-[10px]`}>
            <NextLine>{agent[transport].next}</NextLine>
          </div>
          <KeyStatus projectId={projectId} rawKey={key.rawKey} test={test} onTest={runTest} followAgent={false} />
        </div>
      ) : (
        <form
          className="space-y-[16px]"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <KitField label="Agent">
            <span className="relative block">
              <span aria-hidden className="pointer-events-none absolute left-[11px] top-1/2 z-[1] flex -translate-y-1/2">
                <AgentMark id={agent.id} size={14} />
              </span>
              <KitSelect aria-label="Agent" value={agent.id} onChange={(e) => pickAgent(e.target.value)} disabled={creating} className="!pl-[32px]">
                {AGENTS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </KitSelect>
            </span>
          </KitField>
          <KitField label="Name" htmlFor={nameId}>
            <KitInput
              id={nameId}
              name="agent-key-name"
              autoComplete="off"
              spellCheck={false}
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setNamed(true)
              }}
              disabled={creating}
            />
          </KitField>
          <div className="flex items-start justify-between gap-[16px]">
            <span className="min-w-0">
              <span className="block text-[13px] font-medium leading-[20px] text-zinc-100">Read-only</span>
              <span className="block text-[12.5px] leading-[18px] text-faint">Reads the schema and data, changes nothing.</span>
            </span>
            <KitSwitch checked={readOnly} onChange={setReadOnly} disabled={creating} label="Read-only" className="mt-[2px]" />
          </div>
          {error && <RefusedLine>{error}</RefusedLine>}
          {/* Enter in the name field submits. */}
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      )}
    </KitModal>
  )
}

/** The Setup panel's shape while the page works out whether to show it. */
export function AgentSetupSkeleton() {
  return (
    <div aria-hidden className={`overflow-hidden ${R_PANEL} border ${EDGE} ${PLATE}`}>
      <div className={`flex h-[44px] items-center gap-[18px] border-b ${RULE} px-[16px]`}>
        {[92, 64, 60, 88, 48].map((w) => (
          <span key={w} className="block h-[11px] animate-pulse rounded-[4px] bg-white/[0.06]" style={{ width: w }} />
        ))}
      </div>
      <div className={`${WELL} px-[16px] py-[16px]`}>
        <span className="block h-[11px] w-[78%] animate-pulse rounded-[4px] bg-white/[0.06]" />
        <span className="mt-[10px] block h-[11px] w-[34%] animate-pulse rounded-[4px] bg-white/[0.06]" />
      </div>
      <div className={`flex h-[57px] items-center justify-between border-t ${RULE} px-[16px]`}>
        <span className="block h-[11px] w-[46%] animate-pulse rounded-[4px] bg-white/[0.06]" />
        <span className="block h-[32px] w-[112px] animate-pulse rounded-[7px] bg-white/[0.06]" />
      </div>
    </div>
  )
}
