/**
 * Backenly MCP server configuration.
 *
 * Loaded from (in priority order):
 *   1. CLI flags (--key, --project, --endpoint)  — explicit override
 *   2. Process environment                       — BACKENLY_API_KEY, BACKENLY_PROJECT, BACKENLY_API_URL
 *   3. ~/.backenly/mcp.json                      — written by `init`
 *
 * All three paths are first-class. The published install snippet passes the key
 * as a CLI flag, MCP hosts that support an `env` block pass it as an env var,
 * and `init` persists it to the config file — every one of them must work.
 */

import { homedir } from 'os'
import { join } from 'path'
import { readFileSync } from 'fs'

export const DEFAULT_ENDPOINT = 'https://backenly.com'
export const CONFIG_PATH = join(homedir(), '.backenly', 'mcp.json')

export interface Config {
  apiKey: string
  endpoint: string
  /** Optional — used to detect a key/project mismatch and shown in the banner. */
  projectId?: string
}

/** Values parsed from CLI flags. Any field set here outranks env and file. */
export interface ConfigOverrides {
  apiKey?: string
  endpoint?: string
  projectId?: string
}

interface RawConfig {
  apiKey?: string
  endpoint?: string
  projectId?: string
}

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const envKey = process.env.BACKENLY_API_KEY
  const envEndpoint = process.env.BACKENLY_API_URL
  const envProject = process.env.BACKENLY_PROJECT || process.env.BACKENLY_PROJECT_ID

  let fileConfig: RawConfig = {}
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8')
    fileConfig = JSON.parse(raw) as RawConfig
  } catch {
    // No file is fine — flags or env vars may suffice.
  }

  const apiKey = overrides.apiKey || envKey || fileConfig.apiKey
  if (!apiKey) {
    throw new Error(
      'No Backenly API key configured.\n' +
        '\n' +
        'Pass it as a flag:\n' +
        '  npx -y @backenly/mcp-server --project <projectId> --key <mcp_live_…>\n' +
        '\n' +
        'Or set BACKENLY_API_KEY in your MCP host\'s env block.\n' +
        'Or run:  npx @backenly/mcp-server init\n' +
        '\n' +
        'Get a key: https://backenly.com/app → your project → Connect → MCP',
    )
  }

  return {
    apiKey,
    endpoint: overrides.endpoint || envEndpoint || fileConfig.endpoint || DEFAULT_ENDPOINT,
    projectId: overrides.projectId || envProject || fileConfig.projectId,
  }
}

/**
 * Parse the flags accepted when running as the MCP server (no subcommand).
 *
 * The install snippet published on backenly.com, in llms.txt, and in the
 * dashboard's Connect tab is:
 *
 *   npx -y @backenly/mcp-server --project <id> --key <key>
 *
 * Server mode previously parsed NO flags at all and read the key exclusively
 * from the environment, so the documented command started a server with no
 * credentials and exited with "No Backenly API key configured". Honoring these
 * flags is what makes the copy-pasted command work. Both `--key value` and
 * `--key=value` spellings are accepted; unknown flags are ignored rather than
 * fatal so a host passing extra args can never break startup.
 */
export function parseServerFlags(args: string[]): ConfigOverrides {
  const out: ConfigOverrides = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('-')) continue

    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)

    // Only consume the next argv entry when the value wasn't given inline and
    // the next entry isn't itself a flag — otherwise `--key --project x` would
    // silently swallow `--project` as the key.
    const take = (): string | undefined => {
      if (inline !== undefined) return inline
      const next = args[i + 1]
      if (next === undefined || next.startsWith('-')) return undefined
      i++
      return next
    }

    switch (flag) {
      case '--key':
      case '--api-key':
      case '-k':
        out.apiKey = take() ?? out.apiKey
        break
      case '--project':
      case '--project-id':
      case '-p':
        out.projectId = take() ?? out.projectId
        break
      case '--endpoint':
      case '--api-url':
      case '--url':
      case '-e':
        out.endpoint = take() ?? out.endpoint
        break
      default:
        // Unknown flag — ignore. Consume an inline-less value so it isn't
        // mistaken for a positional argument later.
        break
    }
  }

  return out
}
