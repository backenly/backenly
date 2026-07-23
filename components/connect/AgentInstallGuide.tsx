'use client'

/**
 * AgentInstallGuide — the Connect page's Agents experience (PLATFORM_RESTRUCTURE
 * _REPORT §9.1 items 1–2). Richer than the marketing AgentSetupCard (§9.2/§5.1):
 * it mints a REAL scoped, revocable MCP key at generate time (never a root key
 * in a clipboard) and bakes it into a one-paste setup prompt + a per-agent
 * install command.
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
import { Terminal, ShieldCheck, Loader2, KeyRound, RefreshCw, ArrowUpRight } from 'lucide-react'
import { AGENT_ICON, GenericAgentIcon } from './AgentBrandIcons'
import { CodeSurface, CliText, JsonText, PromptText } from './CodeSurface'

/**
 * Two docs targets, and they are NOT interchangeable:
 *   MCP_DOCS  — llms.txt, written for a model. Only ever goes INSIDE the prompt
 *               the agent consumes.
 *   USER_DOCS — /quickstart, written for a person. Every link a human clicks in
 *               this UI points here. Sending a developer to a plaintext dump
 *               addressed to their agent is a dead end.
 */
const MCP_DOCS = 'https://backenly.com/llms.txt'
const USER_DOCS = '/quickstart'
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
 */
function quickStartPrompt(projectId: string, key: string): string {
  return `I'm using Backenly as my backend. Install its MCP server:
claude mcp add backenly -- npx -y @backenly/mcp-server --project ${projectId} --key ${key}
Then call \`read_backend_state\` to confirm it works, and use Backenly's tools for all backend work. Docs: ${MCP_DOCS}`
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
    <div className="min-w-0 space-y-6">
      {/* 1 — Key mint gate. Everything below is inert until this runs. */}
      <Section step="1" icon={KeyRound} title="Generate a scoped key">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.07] bg-[#16171d] px-4 py-3">
          <p className="min-w-0 truncate text-[12px] text-zinc-500">
            {key ? 'Baked into everything below. Revoke any time.' : 'Scoped and revocable — never a root key.'}
          </p>
          <button
            onClick={mintKey}
            disabled={minting}
            className="inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 text-[12.5px] font-semibold text-black transition-colors hover:bg-zinc-200 disabled:opacity-50"
          >
            {minting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : key ? (
              <RefreshCw className="h-3.5 w-3.5" />
            ) : (
              <KeyRound className="h-3.5 w-3.5" />
            )}
            {key ? 'New key' : 'Generate'}
          </button>
        </div>
      </Section>
      {mintError && <p className="text-[12px] text-rose-300">{mintError}</p>}

      {/* 2 — Paste into your agent. It installs and verifies itself. */}
      <Section step="2" icon={Terminal} title="Paste into your agent">
        <CodeSurface
          label="prompt"
          onCopy={() => copy(quickStartPrompt(projectId, effectiveKey), 'quickstart')}
          copied={copied === 'quickstart'}
          disabled={!keyReady}
        >
          <PromptText text={quickStartPrompt(projectId, effectiveKey)} />
        </CodeSurface>
      </Section>

      {/* 3 — Manual install: pick a transport, pick an agent, get its command. */}
      <Section step="3" icon={CommandGlyph} title="Or install manually">
        {/* Transport toggle: the npm package (works everywhere) vs the npx-free
            remote URL (host must speak Streamable-HTTP). */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="inline-flex items-center gap-0.5 rounded-lg border border-white/[0.07] bg-[#16171d] p-0.5">
            {(['local', 'remote'] as Transport[]).map((t) => (
              <button
                key={t}
                onClick={() => setTransport(t)}
                aria-pressed={transport === t}
                className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                  transport === t ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {t === 'local' ? 'Local (npx)' : 'Remote URL'}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-zinc-500">
            {transport === 'local'
              ? 'Runs the npm package on your machine — works in every host.'
              : 'Agent connects straight to Backenly — nothing to install.'}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {AGENTS.map((a) => {
            const Icon = AGENT_ICON[a.id] ?? GenericAgentIcon
            const active = agentId === a.id
            return (
              <button
                key={a.id}
                onClick={() => setAgentId(a.id)}
                aria-pressed={active}
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  active
                    ? 'border-white/[0.16] bg-white/[0.06]'
                    : 'border-white/[0.07] bg-[#16171d] hover:border-white/[0.12] hover:bg-white/[0.03]'
                }`}
              >
                <Icon size={17} />
                <span className={`truncate text-[12.5px] font-medium ${active ? 'text-zinc-100' : 'text-zinc-400'}`}>
                  {a.name}
                </span>
              </button>
            )
          })}
        </div>
        {downgraded && agent && (
          <p className="text-[11px] text-amber-300/80">
            {agent.name} loads MCP servers over the local package only — showing that command.
          </p>
        )}
        {agent && variant && (
          <>
            <CodeSurface
              label={variant.label}
              onCopy={() => copy(command, agent.id)}
              copied={copied === agent.id}
              disabled={!keyReady}
            >
              {variant.kind === 'json' ? <JsonText text={command} /> : <CliText text={command} />}
            </CodeSurface>
            {variant.note && <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">{variant.note}</p>}
          </>
        )}
      </Section>
    </div>
  )
}

/* A numbered step header: index chip + titled icon. */
function Section({
  step,
  icon: Icon,
  title,
  children,
}: {
  step: string
  icon: React.ComponentType<{ className?: string }>
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2.5">
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03] font-mono text-[10px] text-zinc-500">
          {step}
        </span>
        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-zinc-400" />
        <span className="text-[13px] font-semibold text-zinc-100">{title}</span>
      </div>
      {children}
    </div>
  )
}

/* Terminal-prompt glyph for the per-agent section header. */
function CommandGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M5 8 L9 12 L5 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 16 H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
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
 * The four listed are the load-bearing quarter of MCP_SURFACE (lib/mcp/
 * catalog.ts) — read, migrate, query, escape hatch. Keep this list in step with
 * that set; /quickstart covers the rest for the human reading this card.
 */
const HEADLINE_TOOLS: { name: string; gloss: string }[] = [
  { name: 'read_backend_state', gloss: 'Schema, RLS, metrics, incidents' },
  { name: 'apply_migration', gloss: 'DDL, governed and reversible' },
  { name: 'run_query', gloss: 'Read-only SQL, scoped role' },
  { name: 'get_database_credentials', gloss: 'Real Postgres connection string' },
]

export function AgentCapabilitiesCard() {
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-[#16171d]">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
        <span className="text-[13px] font-semibold text-zinc-100">What your agent gets</span>
        <a
          href={USER_DOCS}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex items-center gap-1 text-[11.5px] text-zinc-500 transition-colors hover:text-zinc-200"
        >
          Docs
          <ArrowUpRight className="h-3 w-3 opacity-60 transition-opacity group-hover:opacity-100" />
        </a>
      </div>
      <div className="space-y-2.5 px-4 py-3.5">
        {HEADLINE_TOOLS.map((t) => (
          <div key={t.name} className="flex items-baseline justify-between gap-3">
            <code className="flex-shrink-0 font-mono text-[11.5px] text-zinc-200">{t.name}</code>
            <span className="truncate text-[11.5px] text-zinc-500">{t.gloss}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-2.5">
        <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" />
        <span className="truncate text-[11.5px] text-zinc-500">Drops and truncates are never exposed over MCP.</span>
      </div>
    </div>
  )
}
