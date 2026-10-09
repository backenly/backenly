'use client'

/**
 * AgentInstallGuide — the Connect page's Agents experience (PLATFORM_RESTRUCTURE
 * _REPORT §9.1 items 1–2), and since 2026-08-06 the product's ONLY agent-setup
 * surface: it mints a REAL scoped, revocable MCP key at generate time (never a
 * root key in a clipboard) and bakes it into one install command per agent.
 * The placeholder-key card that used to sit on the Projects page
 * (AgentSetupCard) is deleted — setup belongs where a project, and therefore a
 * real key, exists.
 *
 * Key minting:
 *   POST /api/projects/[id]/mcp/keys  →  { rawKey }
 * Keys created here appear (and are revocable) in AgentKeysPanel in the right
 * column of the same tab — `onKeyMinted` tells it to refresh.
 *
 * One command, not a prompt (2026-10-04). Step 2 used to be a twenty-line
 * "paste into your agent" prompt: register the server, keep working in the
 * same conversation through `@backenly/cli call`, then read the backend. On
 * screen it was a wall of text where every MCP vendor shows one line, and
 * each of its jobs already has a home:
 *   • registering the server IS the install command, so the command is the
 *     whole step;
 *   • "start with read_backend_state and say what the backend has" is what
 *     the server's own connect instructions tell the agent
 *     (buildMcpInstructions, lib/mcp/protocol/shared.ts);
 *   • hosts load MCP servers when a session starts, so the line under the
 *     command says to run it first and then open a session, as llms.txt does.
 *     An agent that installed the server mid-conversation is told by its own
 *     docs to keep going through `npx @backenly/cli call` (public/llms.txt,
 *     public/docs/agents/client-setup.md), not by text the human has to read.
 *
 * The key is masked on screen to the prefix AgentKeysPanel lists; the copy
 * button and a copy made by selecting the text both carry the real key, and
 * the eye toggle shows it. That keeps the command to two lines, and a
 * screenshot of this page no longer carries a live key.
 *
 * Presentation: agent tabs carry the real brand logomark (AgentBrandIcons) and
 * the command renders through CodeSurface — monochrome, brightness-tiered
 * highlighting. Violet is spent only on the scoped key, keeping the surface
 * inside the flat inspector language.
 */

import { useState, type ClipboardEvent, type ReactNode } from 'react'
import { Check, Eye, EyeOff, ShieldCheck, KeyRound, RefreshCw, ArrowUpRight } from 'lucide-react'
import { KitButton, Segmented } from '@/components/inspector/kit'
import { AGENT_ICON, GenericAgentIcon } from './AgentBrandIcons'
import { CodeSurface, CliText, JsonText } from './CodeSurface'

/**
 * /resources is written for a person, so every link a human clicks in this UI
 * points there. llms.txt is written for a model and is never linked from here:
 * sending a developer to a plaintext dump addressed to their agent is a dead
 * end. (Was /quickstart until that page was removed; it now 301s here anyway.)
 */
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
 *   • kind — which renderer: a shell command, or a file the reader pastes into.
 *   • next — the one line under it: where it goes, and how the host picks it
 *            up. Every host reads its MCP config when a session starts, so a
 *            conversation that is already open never sees the tools — the most
 *            common "Backenly doesn't work" report, and never a Backenly fault.
 */
interface Variant {
  kind: 'cli' | 'json'
  build: (projectId: string, key: string) => string
  next: ReactNode
}

interface Agent {
  id: string
  name: string
  local: Variant
  remote: Variant
}

const NPX_ARGS = (p: string, k: string) => ['-y', '@backenly/mcp-server', '--project', p, '--key', k]

/**
 * JSON the way people write mcp.json by hand: two-space indent, with an array
 * of plain values on one line, so a config reads in eight lines, not fourteen.
 */
function configJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /\[\n\s+([^[\]{}]*?)\n\s*\]/g,
    (_, items: string) => `[${items.split(/,\n\s+/).join(', ')}]`,
  )
}

/** Cursor + Antigravity local: stdio via command/args. No `type` field for stdio. */
function stdioJson(projectId: string, key: string): string {
  return configJson({ mcpServers: { backenly: { command: 'npx', args: NPX_ARGS(projectId, key) } } })
}

/** Cursor remote: url + headers; Cursor infers the transport from the url. */
function cursorRemoteJson(_projectId: string, key: string): string {
  return configJson({ mcpServers: { backenly: { url: REMOTE_URL, headers: { 'x-api-key': key } } } })
}

/**
 * Antigravity remote: MUST be `serverUrl`, not `url`. Antigravity's schema has
 * no `url` or `httpUrl`, so a Cursor-style block pasted here never connects
 * (verified 2026-10 against GitHub's Antigravity install guide). The config
 * lives in mcp_config.json, which Antigravity opens itself from Manage MCP
 * Servers → View raw config; its path on disk has moved between releases.
 */
function antigravityRemoteJson(_projectId: string, key: string): string {
  return configJson({ mcpServers: { backenly: { serverUrl: REMOTE_URL, headers: { 'x-api-key': key } } } })
}

/**
 * Codex remote: the CLI (`codex mcp add --url`) exposes NO header flag, so an
 * x-api-key server can only be configured by editing config.toml, where headers
 * live under `http_headers`. Codex infers http from the `url` key (no `type`).
 */
function codexRemoteToml(_projectId: string, key: string): string {
  return `[mcp_servers.backenly]\nurl = "${REMOTE_URL}"\nhttp_headers = { "x-api-key" = "${key}" }`
}

const RUN_THEN_NEW_SESSION = 'Run it in a terminal, then start a new Claude Code session.'
/**
 * Cursor reads a user config and a per-project one. This block carries a real
 * key, so it goes in the user config: a project's `.cursor/mcp.json` gets
 * committed, and it sits beside the app code an agent writes, which is how an
 * MCP key ended up in a frontend bundle (lib/security/key-placement.ts).
 */
const CURSOR_NEXT = (
  <>Paste into <code>~/.cursor/mcp.json</code>, not the project&apos;s, so the key never reaches git. Then reload the window.</>
)
const ANTIGRAVITY_NEXT = (
  <>Paste into <code>mcp_config.json</code> (Manage MCP Servers → View raw config), then restart Antigravity.</>
)

const AGENTS: Agent[] = [
  {
    id: 'claude-code', name: 'Claude Code',
    local: { kind: 'cli', next: RUN_THEN_NEW_SESSION, build: (p, k) => `claude mcp add backenly -- npx -y @backenly/mcp-server --project ${p} --key ${k}` },
    remote: { kind: 'cli', next: RUN_THEN_NEW_SESSION, build: (_p, k) => `claude mcp add --transport http backenly ${REMOTE_URL} --header "x-api-key: ${k}"` },
  },
  {
    id: 'cursor', name: 'Cursor',
    local: { kind: 'json', next: CURSOR_NEXT, build: stdioJson },
    remote: { kind: 'json', next: CURSOR_NEXT, build: cursorRemoteJson },
  },
  {
    id: 'codex', name: 'Codex',
    local: { kind: 'cli', next: 'Run it in a terminal, then relaunch Codex.', build: (p, k) => `codex mcp add backenly -- npx -y @backenly/mcp-server --project ${p} --key ${k}` },
    remote: {
      kind: 'json', build: codexRemoteToml,
      // Codex has no header flag on the CLI, so the remote form is a file edit.
      next: <>Paste into <code>~/.codex/config.toml</code>, then relaunch Codex. If it isn’t picked up, add <code>[beta] rmcp = true</code>.</>,
    },
  },
  {
    id: 'antigravity', name: 'Antigravity',
    local: { kind: 'json', next: ANTIGRAVITY_NEXT, build: stdioJson },
    remote: { kind: 'json', next: ANTIGRAVITY_NEXT, build: antigravityRemoteJson },
  },
  {
    id: 'other', name: 'Other',
    local: { kind: 'cli', next: 'Use it as the server command in any MCP host, then restart the host.', build: (p, k) => `npx -y @backenly/mcp-server --project ${p} --key ${k}` },
    remote: { kind: 'cli', next: 'Add it as a Streamable HTTP server in any MCP host, then restart the host.', build: (_p, k) => `URL     ${REMOTE_URL}\nHeader  x-api-key: ${k}` },
  },
]

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
  // Claude Code first: it is the host most people arrive with, and one tab is
  // always open, so step 2 is a command from the moment the page loads.
  const [agentId, setAgentId] = useState<string>(AGENTS[0].id)
  const [transport, setTransport] = useState<Transport>('local')
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)

  const agent = AGENTS.find((a) => a.id === agentId) ?? AGENTS[0]
  const variant = agent[transport]
  // The same prefix AgentKeysPanel lists, so the command and its row match.
  const masked = key ? `${key.slice(0, 16)}…` : KEY_PLACEHOLDER
  const command = variant.build(projectId, key ?? KEY_PLACEHOLDER)
  const shown = revealed ? command : variant.build(projectId, masked)

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
      setRevealed(false)
      onKeyMinted?.()
    } catch (err) {
      setMintError(err instanceof Error ? err.message : 'Could not mint a key. Try again.')
    } finally {
      setMinting(false)
    }
  }

  function pickAgent(id: string) {
    setAgentId(id)
    setCopied(false)
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard blocked — non-fatal */
    }
  }

  // A copy made by selecting the masked command by hand gets the real key, so
  // a hand-copied command works exactly like the button's.
  function copySelection(event: ClipboardEvent<HTMLPreElement>) {
    if (!key || revealed) return
    const selected = window.getSelection()?.toString() ?? ''
    if (!selected.includes(masked)) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', selected.split(masked).join(key))
  }

  return (
    <ol className="min-w-0">
      {/* 1 — Key mint gate. The command below stays inert until this runs. */}
      <Step n={1} title="Generate a scoped key" done={!!key}>
        <div className="flex flex-col gap-3 rounded-[10px] border border-white/[0.08] bg-[#0f1012] px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-zinc-100">
              {key ? 'Key ready' : 'One key for this project, scoped and revocable'}
            </p>
            <p className="mt-0.5 text-[12.5px] text-zinc-500">
              {key ? 'It is in the command below, for your agent only: an app gets its own key. Revoke it any time from the list.' : 'Never a root key. It can request a destructive change, never approve one.'}
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

      {/* 2 — One command for the chosen agent, and the one line after it. */}
      <Step n={2} title="Add Backenly to your agent" last>
        <CodeSurface
          bar={<AgentTabs value={agent.id} onChange={pickAgent} />}
          actions={
            <button
              type="button"
              onClick={() => setRevealed((r) => !r)}
              disabled={!key}
              aria-label={revealed ? 'Hide key' : 'Show key'}
              title={revealed ? 'Hide key' : 'Show key'}
              className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-zinc-400 transition-colors hover:bg-white/[0.07] hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          }
          onCopy={copy}
          copied={copied}
          disabled={!key}
          onSelectionCopy={copySelection}
          footer={
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <p className="min-w-0 text-[12.5px] leading-[18px] text-zinc-500 [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-zinc-300">
                {variant.next}
              </p>
              <Segmented<Transport>
                size="sm"
                label="Transport"
                className="self-start sm:self-auto"
                value={transport}
                onChange={setTransport}
                options={[
                  { value: 'local', label: 'Local', title: 'Runs the npm package on your machine. Works in every host.' },
                  { value: 'remote', label: 'Remote', title: 'Your agent connects straight to Backenly. Nothing to install.' },
                ]}
              />
            </div>
          }
        >
          {variant.kind === 'json' ? <JsonText text={shown} /> : <CliText text={shown} />}
        </CodeSurface>
      </Step>
    </ol>
  )
}

/**
 * The agent picker that heads the command card: one option per host, brand
 * mark and name. Exactly one host's command is on screen at a time — nobody
 * installs into five editors at once.
 *
 * Five fit beside the copy button at the narrowest two-column width, and no
 * more. Cline gave its place to Antigravity (2026-10); its config, including
 * the `"type": "streamableHttp"` its remote entry needs, is in
 * public/docs/agents/client-setup.md, and Other's command works there too.
 */
function AgentTabs({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Coding agent" className="scrollbar-hide flex overflow-x-auto">
      {AGENTS.map((a) => {
        const Icon = AGENT_ICON[a.id] ?? GenericAgentIcon
        const active = a.id === value
        return (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(a.id)}
            className={`group relative flex h-[40px] flex-shrink-0 items-center gap-1 px-[6px] text-[13px] font-medium transition-colors first:pl-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300/60 ${
              active ? 'text-zinc-50' : 'text-zinc-500 hover:text-zinc-200'
            }`}
          >
            <Icon size={14} className={active ? '' : 'opacity-60 transition-opacity group-hover:opacity-100'} />
            {a.name}
            <span
              aria-hidden
              className={`absolute inset-x-[6px] bottom-0 h-[1.5px] rounded-full group-first:left-4 ${active ? 'bg-zinc-100' : 'bg-transparent'}`}
            />
          </button>
        )
      })}
    </div>
  )
}

/**
 * One step of the setup sequence: a numbered marker on a rail, a title, and the
 * step's content. Numbered because this is genuinely a sequence.
 */
function Step({
  n,
  title,
  done = false,
  last = false,
  children,
}: {
  n: number
  title: string
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
        <div className="mt-3">{children}</div>
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
