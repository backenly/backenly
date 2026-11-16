'use client'

/**
 * The verified install commands: one per coding agent and transport (local
 * npm package or remote HTTP), each with the one line that says where it goes
 * and how the host picks it up. AgentSetup (components/connect/AgentSetup.tsx)
 * renders them on Overview and Connect, with a real scoped key in place of
 * KEY_PLACEHOLDER; the /agents pages and client-setup.md are held to them
 * (tests/unit/agent-pages-conformance.spec.ts).
 *
 * One command, not a prompt (2026-10-04): registering the server IS the
 * install, and "start with read_backend_state" is what the server's own
 * connect instructions tell the agent (buildMcpInstructions,
 * lib/mcp/protocol/shared.ts). Hosts load MCP servers when a session starts,
 * so each line under a command says to run it first and then open a session.
 *
 * Until 2026-11-16 this file was also the Connect page's numbered setup rail
 * and its "What your agent gets" table. The rail became AgentSetup's one
 * panel; the table gave way to the Setup guide link (the docs list every
 * tool) and Test connection, which reports the real tool count.
 */

import type { ReactNode } from 'react'

export const KEY_PLACEHOLDER = '<SCOPED_KEY>'
/**
 * The dashboard's own origin — which is the backend these commands must point
 * at. Hardcoding backenly.com here sent every SELF-HOSTED operator's agent to
 * Backenly Cloud, where their key is unknown and the connection dies with
 * INVALID_KEY — the one-command install was broken for exactly the audience
 * that cannot fall back to the hosted product. Client component, so the
 * browser's origin is the truth; the env fallback only covers prerender.
 */
export function dashboardOrigin(): string {
  if (typeof window !== 'undefined') return window.location.origin
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com').replace(/\/+$/, '')
}

/** The remote (Streamable-HTTP) MCP endpoint — app/api/mcp/route.ts. No npx. */
export const remoteUrl = () => `${dashboardOrigin()}/api/mcp`

export type Transport = 'local' | 'remote'

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
export interface Variant {
  kind: 'cli' | 'json'
  build: (projectId: string, key: string) => string
  next: ReactNode
}

export interface Agent {
  id: string
  name: string
  local: Variant
  remote: Variant
}

export const NPX_ARGS = (p: string, k: string) => {
  const args = ['-y', '@backenly/mcp-server', '--project', p, '--key', k]
  // The stdio package defaults to backenly.com; a self-host must say where it
  // lives. Cloud commands stay exactly as they were.
  const origin = dashboardOrigin()
  return origin === 'https://backenly.com' ? args : [...args, '--endpoint', origin]
}

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
  return configJson({ mcpServers: { backenly: { url: remoteUrl(), headers: { 'x-api-key': key } } } })
}

/**
 * Antigravity remote: MUST be `serverUrl`, not `url`. Antigravity's schema has
 * no `url` or `httpUrl`, so a Cursor-style block pasted here never connects
 * (verified 2026-10 against GitHub's Antigravity install guide). The config
 * lives in mcp_config.json, which Antigravity opens itself from Manage MCP
 * Servers → View raw config; its path on disk has moved between releases.
 */
function antigravityRemoteJson(_projectId: string, key: string): string {
  return configJson({ mcpServers: { backenly: { serverUrl: remoteUrl(), headers: { 'x-api-key': key } } } })
}

/**
 * Codex remote: the CLI (`codex mcp add --url`) exposes NO header flag, so an
 * x-api-key server can only be configured by editing config.toml, where headers
 * live under `http_headers`. Codex infers http from the `url` key (no `type`).
 */
function codexRemoteToml(_projectId: string, key: string): string {
  return `[mcp_servers.backenly]\nurl = "${remoteUrl()}"\nhttp_headers = { "x-api-key" = "${key}" }`
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

export const AGENTS: Agent[] = [
  {
    id: 'claude-code', name: 'Claude Code',
    local: { kind: 'cli', next: RUN_THEN_NEW_SESSION, build: (p, k) => `claude mcp add backenly -- npx -y @backenly/mcp-server --project ${p} --key ${k}` },
    remote: { kind: 'cli', next: RUN_THEN_NEW_SESSION, build: (_p, k) => `claude mcp add --transport http backenly ${remoteUrl()} --header "x-api-key: ${k}"` },
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
    remote: { kind: 'cli', next: 'Add it as a Streamable HTTP server in any MCP host, then restart the host.', build: (_p, k) => `URL     ${remoteUrl()}\nHeader  x-api-key: ${k}` },
  },
]
