'use client'

/**
 * AgentSetupCard — the copy-paste "connect your coding agent" block.
 *
 * IA restructure §5.1 (Projects empty state) + §9.1 (Connect page)
 * + §9.2 (landing) all mount THIS one component. It hands the user a single
 * prompt to paste into any agent that installs the Backenly MCP server and
 * verifies the connection.
 *
 * Honesty guards:
 *  – When no project exists yet (org empty state), the prompt uses
 *    <PROJECT_ID>/<SCOPED_KEY> placeholders and the copy says to grab a scoped
 *    key from a project's Connect page. We do NOT claim an agent can create a
 *    project from zero — MCP `create_project` is roadmap (§9.4), not shipped.
 *  – When a real projectId/apiKey is passed (Connect page), they're inlined.
 */

import { useState } from 'react'
import { Copy, Check, Terminal } from 'lucide-react'
import { AGENT_ICON, type BrandIconProps } from './AgentBrandIcons'
import type { FC } from 'react'

const AGENTS: { id: string; name: string }[] = [
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'codex', name: 'Codex' },
  { id: 'cline', name: 'Cline' },
]

/**
 * Names `read_backend_state` — NOT `get_project_overview`, which the catalog
 * rewrite left dispatchable but un-advertised (lib/mcp/catalog.ts MCP_SURFACE).
 * Pointing a fresh agent at a tool missing from its own manifest fails the one
 * step that has to work. Kept to three lines: this is a clipboard payload, not
 * documentation.
 */
function buildPrompt(projectId?: string, apiKey?: string): string {
  const project = projectId ?? '<PROJECT_ID>'
  const key = apiKey ?? '<SCOPED_KEY>'
  // The restart paragraph is load-bearing — see the long note on
  // quickStartPrompt in AgentInstallGuide.tsx. MCP hosts read their server
  // manifest once at process start, so "install it then call the tool" asks
  // for something impossible and the agent improvises a bridge that the
  // permission classifier blocks. Keep these two prompts in step.
  return `I'm using Backenly as my backend. Install its MCP server:
claude mcp add backenly -- npx -y @backenly/mcp-server --project ${project} --key ${key}

MCP servers only connect when the host process starts, so Backenly's tools will NOT appear in this session. Once the command succeeds, stop and tell me to restart. Do not try to reach Backenly another way in the meantime — a stdio bridge or a raw HTTP call is not the supported path and will just fail on permissions.

After I restart, call \`read_backend_state\` to confirm the connection, then use Backenly's tools for all backend work. Docs: https://backenly.com/llms.txt`
}

export function AgentSetupCard({
  projectId,
  apiKey,
  className = '',
}: {
  projectId?: string
  apiKey?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const prompt = buildPrompt(projectId, apiKey)
  const hasKey = !!projectId && !!apiKey

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* clipboard blocked — user can select manually */ }
  }

  return (
    <div className={`relative overflow-hidden rounded-xl border border-white/[0.07] bg-[#16171d] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)] ${className}`}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-300/40 to-transparent" />

      {/* Header carries the title and the logomarks only. The old subtitle
          ("governed vocabulary, destructive ops blocked") and the labelled
          agent pills said in two rows what one icon row and the footer line
          say — this block is a copy button, and every extra sentence pushes
          the thing being copied further down the card. */}
      <div className="flex items-center justify-between gap-4 border-b border-white/[0.06] px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="h-3.5 w-3.5 flex-shrink-0 text-violet-300" />
          <h3 className="truncate text-[13px] font-semibold text-zinc-50">Connect your coding agent</h3>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2.5">
          {AGENTS.map((a) => {
            const Icon = AGENT_ICON[a.id] as FC<BrandIconProps>
            return (
              <span key={a.id} title={a.name} aria-label={a.name} className="inline-flex opacity-80">
                <Icon size={16} />
              </span>
            )
          })}
        </div>
      </div>

      <div className="p-4">
        <div className="relative rounded-lg border border-white/[0.07] bg-[#0f1015]">
          <pre className="max-h-64 overflow-auto px-4 py-3.5 font-mono text-[11.5px] leading-5 text-zinc-300 whitespace-pre-wrap break-words">
{prompt}
          </pre>
          <button
            onClick={copy}
            className="absolute right-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.05] px-2.5 py-1.5 text-[11.5px] font-medium text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/[0.09]"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy prompt'}
          </button>
        </div>

        {!hasKey && (
          <p className="mt-3 text-[11.5px] leading-5 text-zinc-500">
            Mint <span className="font-mono text-zinc-400">&lt;SCOPED_KEY&gt;</span> on any project&apos;s{' '}
            <span className="text-zinc-300">Connect</span> page — scoped and revocable, never a root key.
          </p>
        )}
      </div>
    </div>
  )
}
