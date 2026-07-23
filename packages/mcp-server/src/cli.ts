#!/usr/bin/env node
/**
 * CLI entry for `@backenly/mcp-server`.
 *
 * Two run modes:
 *   - `npx @backenly/mcp-server init`           → interactive setup
 *   - `npx @backenly/mcp-server`                → start MCP server over stdio
 *                                                 (what MCP hosts spawn)
 *
 * stdout is RESERVED for MCP JSON-RPC framing — printing anything to stdout
 * outside the transport corrupts the channel. All human output goes to stderr.
 */

import { startServer } from './server.js'
import { runInit } from './init.js'
import { getPackageVersion } from './version.js'

async function main() {
  const args = process.argv.slice(2)
  const cmd = args[0]

  if (cmd === 'init') {
    await runInit(parseInitFlags(args.slice(1)))
    return
  }

  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    process.stdout.write(`@backenly/mcp-server v${getPackageVersion()}\n`)
    return
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp()
    return
  }

  if (cmd === 'health' || cmd === 'doctor') {
    // Useful for CI: verifies the configured key works.
    const { loadConfig, parseServerFlags } = await import('./config.js')
    const { BackenlyClient } = await import('./http.js')
    try {
      const client = new BackenlyClient(loadConfig(parseServerFlags(args.slice(1))))
      const h = await client.health()
      process.stdout.write(JSON.stringify(h, null, 2) + '\n')
      process.exit(0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`health failed: ${msg}\n`)
      process.exit(1)
    }
  }

  // No subcommand → start the MCP server over stdio. Flags from the published
  // install snippet (--project / --key) are parsed here and outrank env vars.
  const { parseServerFlags } = await import('./config.js')
  await startServer(parseServerFlags(args))
}

function parseInitFlags(args: string[]) {
  const flags: { apiKey?: string; endpoint?: string; yes?: boolean } = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if ((a === '--api-key' || a === '-k') && args[i + 1]) {
      flags.apiKey = args[++i]
    } else if ((a === '--endpoint' || a === '-e') && args[i + 1]) {
      flags.endpoint = args[++i]
    } else if (a === '--yes' || a === '-y') {
      flags.yes = true
    }
  }
  return flags
}

function printHelp() {
  process.stdout.write(
    [
      '',
      `  @backenly/mcp-server v${getPackageVersion()} — Backenly MCP for AI coding hosts`,
      '',
      '  USAGE',
      '    npx @backenly/mcp-server init             Interactive setup',
      '    npx @backenly/mcp-server init -k <key>    Setup with API key flag',
      '    npx @backenly/mcp-server                  Run as MCP server (stdio)',
      '    npx @backenly/mcp-server health           Verify the configured key',
      '    npx @backenly/mcp-server version          Print version',
      '',
      '  SERVER FLAGS  (also accepted by `health`)',
      '    --key, -k <key>         MCP key (mcp_live_…)',
      '    --project, -p <id>      Project id — verified against the key at startup',
      '    --endpoint, -e <url>    Custom endpoint (default: https://backenly.com)',
      '',
      '    npx -y @backenly/mcp-server --project <id> --key <key>',
      '',
      '  ENVIRONMENT  (flags outrank these)',
      '    BACKENLY_API_KEY    MCP key (overrides ~/.backenly/mcp.json)',
      '    BACKENLY_PROJECT    Project id',
      '    BACKENLY_API_URL    Custom endpoint (default: https://backenly.com)',
      '',
      '  CONFIG',
      '    ~/.backenly/mcp.json   Written by `init`. User-only readable (0600).',
      '',
      '  Get your MCP key:  https://backenly.com/app → project → Connect → Agents',
      '',
    ].join('\n'),
  )
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`[@backenly/mcp-server] fatal: ${msg}\n`)
  process.exit(1)
})
