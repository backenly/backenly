'use client'

/**
 * The connect window: one tab per door into a project.
 *
 * Every snippet is the real shape the product accepts, with the project id and
 * key stood in for:
 *   - Claude Code / Codex / Cursor: the per-host install the dashboard mints
 *     (components/connect/AgentInstallGuide.tsx). If that builder changes
 *     shape, change these with it.
 *   - CLI: commands documented in packages/cli/README.md.
 *   - SDK: the client in packages/sdk/README.md.
 *
 * The Claude Code command uses a genuine shell line continuation, so pasting
 * the two lines runs exactly one command.
 *
 * The agent's key is `<mcp-key>`, never `<api-key>`: the SDK tab's `apiKey` is
 * the app's own key, and the runtime refuses an MCP key, so one word for both
 * credentials taught exactly the mix-up that shipped MCP keys in frontends.
 */

import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, Copy } from 'lucide-react'
import { highlight } from '@/components/site/CodeBlock'

type Door = { id: string; label: string; file: string; language: string; code: string; note: string }

const DOORS: Door[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    file: 'terminal',
    language: 'bash',
    code: `# Project id and key: dashboard, Connect, Agents
claude mcp add backenly -- \\
  npx -y @backenly/mcp-server --project <project-id> --key <mcp-key>

# Then, in a new session:
# > add comments to posts. Only the author can delete theirs.`,
    note: 'Hosts load MCP servers when a session starts, so the tools appear in the next one.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    file: '~/.cursor/mcp.json',
    language: 'json',
    code: `{
  "mcpServers": {
    "backenly": {
      "command": "npx",
      "args": ["-y", "@backenly/mcp-server", "--project", "<project-id>", "--key", "<mcp-key>"]
    }
  }
}`,
    note: 'Reload the window, then look for a green backenly entry under MCP.',
  },
  {
    id: 'codex',
    label: 'Codex',
    file: 'terminal',
    language: 'bash',
    code: `# Project id and key: dashboard, Connect, Agents
codex mcp add backenly -- \\
  npx -y @backenly/mcp-server --project <project-id> --key <mcp-key>

# Then, in a new session, ask for what you want built.`,
    note: 'Relaunch the Codex CLI to load the server.',
  },
  {
    id: 'cli',
    label: 'CLI',
    file: 'terminal',
    language: 'bash',
    code: `npx @backenly/cli link --project <project-id> --key <mcp-key>

npx @backenly/cli schema           # every table, column and relation
npx @backenly/cli types --client   # typed client from the live schema
npx @backenly/cli diff             # fails CI when types drift from the schema`,
    note: 'Zero dependencies, so it starts fast inside an agent loop or a pipeline.',
  },
  {
    id: 'sdk',
    label: 'SDK',
    file: 'app.ts',
    language: 'ts',
    code: `import { createClient } from '@backenly/sdk'

const backend = createClient({ projectId, apiKey })

const { data } = await backend
  .from('comments')
  .select('*, author(*)')
  .eq('post_id', postId)

backend.realtime.onTableChange('comments', (event) => render(event))`,
    note: 'The same REST contract your agent built against, with types generated from it.',
  },
]

export function ConnectTabs() {
  const [active, setActive] = useState(0)
  const [copied, setCopied] = useState(false)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const baseId = useId()
  const door = DOORS[active]
  const rendered = useMemo(() => highlight(door.code, door.language), [door])

  function select(index: number, focus = false) {
    const next = (index + DOORS.length) % DOORS.length
    setActive(next)
    setCopied(false)
    if (focus) tabRefs.current[next]?.focus()
  }

  function onKey(event: KeyboardEvent<HTMLButtonElement>) {
    const moves: Record<string, number> = {
      ArrowRight: active + 1,
      ArrowLeft: active - 1,
      Home: 0,
      End: DOORS.length - 1,
    }
    if (!(event.key in moves)) return
    event.preventDefault()
    select(moves[event.key], true)
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(door.code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard blocked: the code is still selectable */
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-white/[0.09] bg-[#0b0c0f] shadow-[0_1px_0_0_rgba(255,255,255,0.05)_inset,0_40px_120px_-40px_rgba(0,0,0,0.9)]">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] bg-white/[0.015] pr-3">
        <div
          role="tablist"
          aria-label="Ways to connect"
          className="flex min-w-0 overflow-x-auto [scrollbar-width:none]"
        >
          {DOORS.map((d, i) => {
            const selected = i === active
            return (
              <button
                key={d.id}
                ref={(node) => {
                  tabRefs.current[i] = node
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${d.id}`}
                aria-selected={selected}
                aria-controls={`${baseId}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => select(i)}
                onKeyDown={onKey}
                className={`relative shrink-0 px-4 py-3.5 text-[13px] font-medium tracking-[-0.006em] outline-none transition-colors duration-200 focus-visible:bg-white/[0.04] sm:px-5 ${
                  selected ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {d.label}
                <span
                  aria-hidden
                  className={`absolute inset-x-3 -bottom-px h-px transition-opacity duration-200 ${
                    selected ? 'bg-violet-400 opacity-100' : 'opacity-0'
                  }`}
                />
              </button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Copied' : `Copy the ${door.label} snippet`}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.09] bg-white/[0.03] px-2.5 text-[12px] font-medium text-zinc-400 transition-colors duration-200 hover:border-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
        >
          {copied ? (
            <Check aria-hidden className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <Copy aria-hidden className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>

      <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${door.id}`}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-2">
          <span className="font-mono text-[11.5px] text-zinc-600">{door.file}</span>
          <span aria-live="polite" className="sr-only">
            {copied ? 'Copied to clipboard' : ''}
          </span>
        </div>
        {/* Fixed height: switching tabs must not move the page under the
            reader's cursor. The longest snippet sets it. */}
        <pre className="h-[248px] overflow-auto px-5 py-5 text-[13px] leading-[1.75]">
          <code className="font-mono text-[#d4d4d4] [font-variant-ligatures:none]">{rendered}</code>
        </pre>
        <p className="border-t border-white/[0.05] px-5 py-3.5 text-[13px] leading-[1.6] text-zinc-500">
          {door.note}
        </p>
      </div>
    </div>
  )
}
