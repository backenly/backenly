/**
 * `npx @backenly/mcp-server init`
 *
 * Interactive one-time setup. Walks the user through:
 *   1. Pasting their MCP API key (from backenly.com/app/projects/<id>/mcp).
 *   2. (Optional) Pinning an endpoint other than https://backenly.com.
 *   3. Writing ~/.backenly/mcp.json so the server runs without env vars.
 *   4. Verifying the key works by fetching the manifest.
 *   5. Printing copy-paste config snippets for Claude Code, Cursor, Cline,
 *      and Claude Desktop.
 *
 * The user can also pass --api-key flag to skip the prompt, useful in CI /
 * provisioning scripts.
 */

import { createInterface } from 'readline/promises'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { stdin, stdout } from 'process'

import { DEFAULT_ENDPOINT, CONFIG_PATH } from './config.js'
import { BackenlyClient } from './http.js'

interface InitFlags {
  apiKey?: string
  endpoint?: string
  yes?: boolean
}

export async function runInit(flags: InitFlags) {
  const rl = createInterface({ input: stdin, output: stdout })

  write('\n')
  write('  Backenly MCP server — setup\n')
  write('  ────────────────────────────\n')
  write('\n')
  write('  Connects Claude Code / Cursor / Codex / Cline to your Backenly backend.\n')
  write('\n')

  let apiKey = flags.apiKey
  if (!apiKey) {
    write('  1. Open  https://backenly.com/app  → pick your project → Connect → Agents.\n')
    write('  2. Click "Generate MCP key" and copy the mcp_live_… key.\n')
    write('\n')
    apiKey = (await rl.question('  Paste your MCP key here: ')).trim()
  }

  if (!apiKey || !apiKey.startsWith('mcp_live_')) {
    rl.close()
    write('\n  ✖  That does not look like an MCP key. They start with "mcp_live_".\n')
    write('     Generate one from Connect → Agents in your Backenly project.\n\n')
    process.exit(1)
  }

  const endpoint = flags.endpoint || DEFAULT_ENDPOINT

  // Verify before saving. If the key is wrong we want the user to know NOW,
  // not later when Claude Code tries to use it and gets a 401.
  write(`\n  Verifying with ${endpoint} …`)
  let projectId: string | undefined
  try {
    const client = new BackenlyClient({ apiKey, endpoint })
    const manifest = await client.manifest()
    projectId = manifest.server.projectId
    write(`\r  ✓ Verified. Connected to project ${projectId} (${manifest.tools.length} tools).\n`)
  } catch (err) {
    rl.close()
    const msg = err instanceof Error ? err.message : String(err)
    write(`\r  ✖  Verification failed: ${msg}\n\n`)
    process.exit(1)
  }

  // Persist config.
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true })
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ apiKey, endpoint, projectId }, null, 2),
      { mode: 0o600 }, // user-only readable; this is a secret
    )
    write(`  ✓ Saved to ${CONFIG_PATH}\n`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    write(`\n  ✖  Could not write config: ${msg}\n`)
    rl.close()
    process.exit(1)
  }

  // Print copy-paste config snippets. We pick a sensible default mode based on
  // detecting which hosts the user might be using — but since we don't know,
  // we just show all of them.
  printHostSnippets()
  write('\n  Setup complete. Restart your MCP host and Backenly is wired in.\n\n')

  rl.close()
}

function write(s: string) { stdout.write(s) }

function printHostSnippets() {
  const claudeCode = join(homedir(), '.claude', 'mcp.json')
  const cursor = join(homedir(), '.cursor', 'mcp.json')

  write('\n  Add Backenly to your MCP host:\n')
  write('  ──────────────────────────────\n')

  write(`\n  ▸ Claude Code  (${claudeCode}):\n\n`)
  write(snippetMcpJson())

  write(`\n\n  ▸ Cursor  (${cursor}):\n\n`)
  write(snippetMcpJson())

  write(`\n\n  ▸ Cline  (mcp_settings.json):\n\n`)
  write(snippetMcpJson())

  write(`\n\n  ▸ Claude Desktop  (Settings → Developer → Edit Config):\n\n`)
  write(snippetMcpJson())
}

function snippetMcpJson(): string {
  // We deliberately do NOT embed the user's key in the snippet. The npm
  // package reads from ~/.backenly/mcp.json so the snippet stays portable
  // across machines — the key lives in the config file only.
  return [
    '    {',
    '      "mcpServers": {',
    '        "backenly": {',
    '          "command": "npx",',
    '          "args": ["-y", "@backenly/mcp-server"]',
    '        }',
    '      }',
    '    }',
  ].join('\n')
}
