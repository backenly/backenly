'use client'

/**
 * AgentInstallGuide — the Connect page's Agents experience (PLATFORM_RESTRUCTURE
 * _REPORT §9.1 items 1–2), and since 2026-08-06 the product's ONLY agent-setup
 * surface: it mints a REAL scoped, revocable MCP key at generate time (never a
 * root key in a clipboard) and bakes it into a one-paste setup prompt + a
 * per-agent install command. The placeholder-key card that used to sit on the
 * Projects page (AgentSetupCard) is deleted — setup belongs where a project,
 * and therefore a real key, exists.
 *
 * Key minting:
 *   POST /api/projects/[id]/mcp/keys  →  { rawKey }
 * Keys created here appear (and are revocable) in AgentKeysPanel in the right
 * column of the same tab — `onKeyMinted` tells it to refresh.
 *
 * Two steps, not four (2026-07-22). The surface previously ran key gate →
 * prompt → a five-row accordion → a separate "verify the connection" prompt.
 * Two of those earned nothing: the setup prompt ALREADY instructs the agent to
 * verify, so the third code block restated it, and the accordion let several
 * command blocks stack at once for a reader who only ever uses one agent. The
 * accordion is now a picker over ONE code panel, and the verify step is gone.
 *
 * Presentation: agent tiles carry the real brand logomark (AgentBrandIcons) and
 * every command/config/prompt renders through CodeSurface — terminal chrome +
 * monochrome, brightness-tiered highlighting. Violet is spent only on the scoped
 * key, keeping the surface inside the flat inspector language.
 */

import { useState } from 'react'
import { Check, ShieldCheck, KeyRound, RefreshCw, ArrowUpRight } from 'lucide-react'
import { KitButton, KitNote, Segmented } from '@/components/inspector/kit'
import { AGENT_ICON, GenericAgentIcon } from './AgentBrandIcons'
import { CodeSurface, CliText, JsonText, PromptText } from './CodeSurface'

/**
 * Two docs targets, and they are NOT interchangeable:
 *   MCP_DOCS  — llms.txt, written for a model. Only ever goes INSIDE the prompt
 *               the agent consumes.
 *   USER_DOCS — /resources, written for a person. Every link a human clicks in
 *               this UI points here. Sending a developer to a plaintext dump
 *               addressed to their agent is a dead end. (Was /quickstart until
 *               that page was removed; it now 301s here anyway.)
 */
const MCP_DOCS = 'https://backenly.com/llms.txt'
const USER_DOCS = '/resources'
const KEY_PLACEHOLDER = '<SCOPED_KEY>'
/** The remote (Streamable-HTTP) MCP endpoint — app/api/mcp/route.ts. No npx. */
const REMOTE_URL = 'https://backenly.com/api/mcp'

type Transport = 'local' | 'remote'

/**
 * One install form for one (agent, transport) pair. Every agent's local and
 * remote configs differ in shape AND in how the key is carried, so each is
 * spelled out rather than templated — the differences below are load-bearing,
 * verified against each host's own docs (2026-07):
 *   • kind   — which renderer + how the reader consumes it (a shell command vs
 *              a file they paste into).
 *   • label  — the terminal-bar caption: a shell, or the exact config path.
 *   • note   — an optional caveat shown under the block.
 */
interface Variant {
  kind: 'cli' | 'json'
  label: string
  build: (projectId: string, key: string) => string
  note?: string
}

interface Agent {
  id: string
  name: string
  local: Variant
  /** Absent when the host has no clean remote path — the toggle falls back to local. */
  remote?: Variant
}

const NPX_ARGS = (p: string, k: string) => ['-y', '@backenly/mcp-server', '--project', p, '--key', k]

/** Cursor + Cline local: stdio via command/args. No `type` field for stdio. */
function stdioJson(projectId: string, key: string): string {
  return JSON.stringify(
    { mcpServers: { backenly: { command: 'npx', args: NPX_ARGS(projectId, key) } } },
    null,
    2,
  )
}

/** Cursor remote: url + headers; Cursor infers the transport from the url. */
function cursorRemoteJson(_projectId: string, key: string): string {
  return JSON.stringify(
    { mcpServers: { backenly: { url: REMOTE_URL, headers: { 'x-api-key': key } } } },
    null,
    2,
  )
}

/**
 * Cline remote: MUST set `"type": "streamableHttp"` (camelCase, no hyphen).
 * Omit it and Cline falls back to the legacy SSE transport and 405s against our
 * Streamable-HTTP endpoint — the single most common Cline-remote failure.
 */
function clineRemoteJson(_projectId: string, key: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        backenly: {
          url: REMOTE_URL,
          type: 'streamableHttp',
          headers: { 'x-api-key': key },
          disabled: false,
          autoApprove: [],
        },
      },
    },
    null,
    2,
  )
}

/**
 * Codex remote: the CLI (`codex mcp add --url`) exposes NO header flag, so an
 * x-api-key server can only be configured by editing config.toml, where headers
 * live under `http_headers`. Codex infers http from the `url` key (no `type`).
 */
function codexRemoteToml(_projectId: string, key: string): string {
  return `[mcp_servers.backenly]\nurl = "${REMOTE_URL}"\nhttp_headers = { "x-api-key" = "${key}" }`
}

const AGENTS: Agent[] = [
  {
    id: 'claude-code', name: 'Claude Code',
    local: { kind: 'cli', label: 'bash', build: (p, k) => `claude mcp add backenly -- npx -y @backenly/mcp-server --project ${p} --key ${k}` },
    remote: { kind: 'cli', label: 'bash', build: (_p, k) => `claude mcp add --transport http backenly ${REMOTE_URL} --header "x-api-key: ${k}"` },
  },
  {
    id: 'cursor', name: 'Cursor',
    local: { kind: 'json', label: '.cursor/mcp.json', build: stdioJson },
    remote: { kind: 'json', label: '.cursor/mcp.json', build: cursorRemoteJson },
  },
  {
    id: 'codex', name: 'Codex',
    local: { kind: 'cli', label: 'bash', build: (p, k) => `codex mcp add backenly -- npx -y @backenly/mcp-server --project ${p} --key ${k}` },
    remote: {
      kind: 'json', label: '~/.codex/config.toml', build: codexRemoteToml,
      note: 'Codex has no header flag on the CLI — paste this into ~/.codex/config.toml. If it isn’t picked up, add [beta] rmcp = true.',
    },
  },
  {
    id: 'cline', name: 'Cline',
    local: { kind: 'json', label: 'cline_mcp_settings.json', build: stdioJson },
    remote: { kind: 'json', label: 'cline_mcp_settings.json', build: clineRemoteJson },
  },
  {
    id: 'other', name: 'Other',
    local: { kind: 'cli', label: 'bash', build: (p, k) => `npx -y @backenly/mcp-server --project ${p} --key ${k}` },
    remote: {
      kind: 'cli', label: 'endpoint',
      build: (_p, k) => `# Add as a remote (Streamable-HTTP) MCP server:\n#   URL:    ${REMOTE_URL}\n#   Header: x-api-key: ${k}`,
    },
  },
]

/**
 * The one-paste prompt. Names `read_backend_state` — NOT `get_project_overview`,
 * which the catalog rewrite left dispatchable but un-advertised (lib/mcp/
 * catalog.ts MCP_SURFACE). Telling an agent to call a tool absent from its own
 * manifest is a failed first impression on the one step that has to work.
 *
 * ── Why the restart paragraph is load-bearing ───────────────────────────────
 *
 * This prompt used to say "install it, then call read_backend_state" in one
 * breath. Every MCP host connects its servers at PROCESS START and reads the
 * manifest once, so a server added by the running agent is registered in config
 * and absent from that session's tool list. The agent then does the reasonable
 * thing and improvises a way to reach us anyway — a stdio bridge, a raw curl —
 * which the permission classifier blocks, and the user watches three failures
 * scroll past on what is supposed to be the first thirty seconds of the
 * product. Nothing is broken; the instructions asked for something impossible.
 *
 * The fix after that told the agent to STOP after the install and ask for a
 * restart. Correct, and still a dead end: the user asked for a backend and got
 * "reload VS Code" instead. So the prompt now splits the two jobs. The MCP
 * server is registered for the NEXT conversation, and the work continues in
 * THIS one through `@backenly/cli call`, which posts to the same /api/mcp/*
 * handlers with the same key. The improvised paths (a stdio bridge, a raw curl)
 * are still named as unsupported: a capable agent invents them unless told the
 * supported one exists.
 */
function quickStartPrompt(projectId: string, key: string): string {
  return `I'm using Backenly as my backend (project ${projectId}).

1. Register its MCP server for my future conversations:
claude mcp add backenly -- npx -y @backenly/mcp-server --project ${projectId} --key ${key}

2. Do not stop and ask me to restart. MCP tools registered during a conversation only appear in the next one, but every Backenly tool is callable right now from the shell with the same key:
npx -y @backenly/cli@latest link --project ${projectId} --key ${key}
npx -y @backenly/cli@latest tools
npx -y @backenly/cli@latest call read_backend_state
npx -y @backenly/cli@latest call apply_migration sql="CREATE TABLE posts (title text NOT NULL)"
npx -y @backenly/cli@latest chat "describe the change in plain English"
(Arguments are key=value pairs; for nested JSON use --args-file args.json.)
Use the CLI for this conversation and the MCP tools once they appear. Do not start the MCP server yourself or call Backenly's HTTP API with curl; the CLI is the supported path.

3. Start with read_backend_state and tell me what the backend has, then build what I ask for. Docs: ${MCP_DOCS}`
}

export function AgentInstallGuide({
  projectId,
  onKeyMinted,
}: {
  projectId: string
  /** Fired after a key is minted so the keys panel below can refresh its list. */
  onKeyMinted?: () => void
}) {
  const [key, setKey] = useState<string | null>(null)
  const [minting, setMinting] = useState(false)
  const [mintError, setMintError] = useState<string | null>(null)
  // Exactly one agent's command is on screen at a time — nobody installs into
  // five editors, and stacked blocks are what made this surface read as a wall.
  // Starts unpicked on purpose: the prompt in step 2 already carries the Claude
  // Code line, so defaulting to Claude Code would print the same command twice.
  const [agentId, setAgentId] = useState<string>('')
  const [transport, setTransport] = useState<Transport>('local')
  const [copied, setCopied] = useState<string | null>(null)

  const effectiveKey = key ?? KEY_PLACEHOLDER
  const keyReady = !!key
  const agent = AGENTS.find((a) => a.id === agentId) ?? null
  // Pick the variant for the chosen transport, falling back to local when a host
  // has no clean remote path — never hand someone a config their agent can't load.
  const variant = agent ? (transport === 'remote' ? agent.remote ?? agent.local : agent.local) : null
  const downgraded = !!agent && transport === 'remote' && !agent.remote
  const command = variant ? variant.build(projectId, effectiveKey) : ''

  async function mintKey() {
    if (!projectId) return
    setMinting(true)
    setMintError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/mcp/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Agent setup' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.rawKey) throw new Error(data?.error || `Could not mint key (HTTP ${res.status})`)
      setKey(data.rawKey)
      onKeyMinted?.()
    } catch (err) {
      setMintError(err instanceof Error ? err.message : 'Could not mint a key. Try again.')
    } finally {
      setMinting(false)
    }
  }

  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      setTimeout(() => setCopied(null), 1600)
    } catch {
      /* clipboard blocked — non-fatal */
    }
  }

  return (
    <ol className="min-w-0">
      {/* 1 — Key mint gate. Everything below is inert until this runs. */}
      <Step n={1} title="Generate a scoped key" done={keyReady}>
        <div className="flex flex-col gap-3 rounded-[10px] border border-white/[0.08] bg-[#0f1012] px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-zinc-100">
              {key ? 'Key ready' : 'One key for this project, scoped and revocable'}
            </p>
            <p className="mt-0.5 text-[12.5px] text-zinc-500">
              {key ? 'It is baked into everything below. Revoke it any time from the list.' : 'Never a root key. It can request a destructive change, never approve one.'}
            </p>
          </div>
          <KitButton
            variant={key ? 'secondary' : 'primary'}
            icon={key ? RefreshCw : KeyRound}
            loading={minting}
            onClick={mintKey}
          >
            {key ? 'New key' : 'Generate key'}
          </KitButton>
        </div>
        {mintError && <p role="alert" className="mt-2 text-[12.5px] text-rose-300">{mintError}</p>}
      </Step>

      {/* 2 — Paste into your agent. It installs and verifies itself. */}
      <Step n={2} title="Paste into your agent" hint="It registers the server for your next conversation and keeps working in this one.">
        <CodeSurface
          label="prompt"
          onCopy={() => copy(quickStartPrompt(projectId, effectiveKey), 'quickstart')}
          copied={copied === 'quickstart'}
          disabled={!keyReady}
        >
          <PromptText text={quickStartPrompt(projectId, effectiveKey)} />
        </CodeSurface>
      </Step>

      {/* 3 — Manual install: pick a transport, pick an agent, get its command. */}
      <Step n={3} title="Or install manually" last>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Segmented<Transport>
            label="Transport"
            value={transport}
            onChange={setTransport}
            options={[
              { value: 'local', label: 'Local (npx)' },
              { value: 'remote', label: 'Remote URL' },
            ]}
          />
          <p className="text-[12.5px] text-zinc-500">
            {transport === 'local'
              ? 'Runs the npm package on your machine. Works in every host.'
              : 'Your agent connects straight to Backenly. Nothing to install.'}
          </p>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Coding agent">
          {AGENTS.map((a) => {
            const Icon = AGENT_ICON[a.id] ?? GenericAgentIcon
            const active = agentId === a.id
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setAgentId(a.id)}
                className={`flex h-[42px] items-center gap-2.5 rounded-[8px] border px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60 ${
                  active
                    ? 'border-white/[0.18] bg-white/[0.07]'
                    : 'border-white/[0.08] bg-[#0f1012] hover:border-white/[0.14]'
                }`}
              >
                <Icon size={17} />
                <span className={`truncate text-[13px] font-medium ${active ? 'text-zinc-50' : 'text-zinc-400'}`}>{a.name}</span>
              </button>
            )
          })}
        </div>
        {downgraded && agent && (
          <p className="mt-2 text-[12.5px] text-amber-200/90">
            {agent.name} loads MCP servers over the local package only, so that command is shown.
          </p>
        )}
        {agent && variant && (
          <div className="mt-3 space-y-3">
            <CodeSurface
              label={variant.label}
              onCopy={() => copy(command, agent.id)}
              copied={copied === agent.id}
              disabled={!keyReady}
            >
              {variant.kind === 'json' ? <JsonText text={command} /> : <CliText text={command} />}
            </CodeSurface>
            {variant.note && <p className="text-[12.5px] leading-[19px] text-zinc-500">{variant.note}</p>}
            <RestartNotice agentName={agent.name} hint={RESTART_HINT[agent.id]} />
          </div>
        )}
      </Step>
    </ol>
  )
}

/**
 * When the tools appear, per host. Every MCP host reads its server config when
 * a session starts, so the command above has no effect on a conversation that
 * is already open. That is the most common "Backenly doesn't work" report and
 * it is never a Backenly fault, which is why it sits next to the command rather
 * than in docs somebody already skipped.
 *
 * Each hint names the cheapest real action for that host. For Claude Code that
 * is a new conversation, not a window reload: its docs say an added server
 * takes effect in conversations started afterwards, and `claude --continue`
 * starts one that keeps the history. Running the command BEFORE opening the
 * agent avoids the wait entirely, and the CLI covers the gap when it cannot be.
 */
const RESTART_HINT: Record<string, string> = {
  'claude-code': 'Open a new Claude Code conversation (a new tab in VS Code), or in a terminal run /exit and then `claude --continue` to keep this conversation. /mcp lists backenly when it worked.',
  cursor: 'Reload Window (Ctrl/Cmd+Shift+P), then check Settings → MCP for a green backenly entry.',
  cline: 'Reload Window (Ctrl/Cmd+Shift+P), then reopen the Cline panel and check its MCP Servers list.',
  codex: 'Quit and relaunch the Codex CLI.',
  other: 'Restart the host process. MCP config is read when a session starts.',
}

function RestartNotice({ agentName, hint }: { agentName: string; hint?: string }) {
  return (
    <KitNote tone="warn" icon={RefreshCw} title={`Run this before you open ${agentName}`}>
      Servers connect when a session starts, so a conversation that is already open will not see the tools.{' '}
      {hint ?? RESTART_HINT.other} Until then, the same tools work from the shell:{' '}
      <code>npx -y @backenly/cli@latest call &lt;tool&gt;</code>.
    </KitNote>
  )
}

/**
 * One step of the setup sequence: a numbered marker on a rail, a title, and the
 * step's content. Numbered because this is genuinely a sequence.
 */
function Step({
  n,
  title,
  hint,
  done = false,
  last = false,
  children,
}: {
  n: number
  title: string
  hint?: string
  done?: boolean
  last?: boolean
  children: React.ReactNode
}) {
  return (
    <li className="relative flex gap-4 pb-8 last:pb-0">
      {!last && <span aria-hidden className="absolute bottom-0 left-[11px] top-[28px] w-px bg-white/[0.08]" />}
      <span
        aria-hidden
        className={`relative z-[1] mt-px flex h-[23px] w-[23px] flex-shrink-0 items-center justify-center rounded-full text-[12px] font-semibold tabular-nums ${
          done ? 'bg-emerald-400/15 text-emerald-300' : 'border border-white/[0.14] bg-[#0c0d0f] text-zinc-300'
        }`}
      >
        {done ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[14px] font-semibold leading-[22px] tracking-[-0.01em] text-zinc-100">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h3>
        {hint && <p className="mb-3 mt-0.5 text-[13px] text-zinc-500">{hint}</p>}
        <div className={hint ? '' : 'mt-3'}>{children}</div>
      </div>
    </li>
  )
}

/**
 * AgentCapabilitiesCard — the tools a wired agent can call. Rendered by the
 * Connect page in the right column, above AgentKeysPanel, so the split layout
 * has substance even before the first key exists.
 *
 * Rewritten 2026-07-22 from three prose bullets into named tools. Two reasons,
 * one of them a bug: the old copy advertised `get_pending_incidents`, which the
 * catalog rewrite folded into `read_backend_state { section: "incidents" }` and
 * stopped advertising — the card was naming a tool the agent's manifest no
 * longer carries. And the audience is agent operators, for whom a tool name IS
 * the capability; a paragraph explaining it is the part they skip.
 *
 * The four listed are the load-bearing core of MCP_SURFACE (lib/mcp/
 * catalog.ts) — read, migrate, query, escape hatch. Keep this list in step with
 * that set; packages/mcp-server/README.md covers the rest.
 */
const HEADLINE_TOOLS: { name: string; gloss: string }[] = [
  { name: 'read_backend_state', gloss: 'Schema, RLS, metrics, incidents' },
  { name: 'apply_migration', gloss: 'DDL, governed and reversible' },
  { name: 'run_query', gloss: 'Read-only SQL, scoped role' },
  { name: 'deploy', gloss: 'Readiness, publish, rollback (approved)' },
]

export function AgentCapabilitiesCard() {
  return (
    <div className="overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#0f1012]">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
        <h3 className="text-[13px] font-medium text-zinc-100">What your agent gets</h3>
        <a
          href={USER_DOCS}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex items-center gap-1 rounded-[5px] text-[12.5px] text-zinc-400 transition-colors hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60"
        >
          Docs
          <ArrowUpRight className="h-3.5 w-3.5 opacity-70 transition-opacity group-hover:opacity-100" />
        </a>
      </div>
      <dl className="divide-y divide-white/[0.05]">
        {HEADLINE_TOOLS.map((t) => (
          <div key={t.name} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
            <dt><code className="font-mono text-[12px] text-zinc-100">{t.name}</code></dt>
            <dd className="truncate text-right text-[12.5px] text-zinc-500">{t.gloss}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-2.5">
        <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" />
        <span className="truncate text-[12.5px] text-zinc-500">Drops and truncates are never exposed over MCP.</span>
      </div>
    </div>
  )
}
