/**
 * The /mcp page must describe the MCP server that actually ships.
 *
 * It is the page a developer reads to decide whether to connect an agent, so
 * each number and list on it is a promise: how many tools an agent sees, which
 * actions wait for a person, and the exact commands to install it. Each of
 * those already has a source of truth, so this holds the page to it rather
 * than trusting a copy edit to keep up:
 *
 *   tool counts        lib/mcp/catalog.ts         buildCatalog()
 *   the tool groups    lib/mcp/catalog.ts         every advertised tool, once
 *   approval list      lib/mcp/domains.ts         needsApproval()
 *   install commands   public/docs/agents/client-setup.md, the file agents read
 */

import fs from 'fs'
import { RESOURCE_ORDER } from '@/lib/changes/resources/core'
import path from 'path'
import { buildCatalog } from '@/lib/mcp/catalog'
import { DOMAIN_TOOLS, needsApproval } from '@/lib/mcp/domains'
import {
  ADVERTISED_TOOL_COUNT,
  FAQ,
  GATED_ACTIONS,
  INSTALLS,
  MCP_ENDPOINT,
  READ_ONLY_TOOL_COUNT,
  TOOL_GROUPS,
} from '@/app/mcp/data'

const CLIENT_SETUP = fs.readFileSync(path.join(process.cwd(), 'public', 'docs', 'agents', 'client-setup.md'), 'utf8')

describe('the /mcp page states the real tool surface', () => {
  const advertised = buildCatalog().map((t) => t.name)

  it('counts the tools a read-write and a read-only connection see', () => {
    expect(ADVERTISED_TOOL_COUNT).toBe(advertised.length)
    expect(READ_ONLY_TOOL_COUNT).toBe(buildCatalog({ readOnly: true }).length)
  })

  it('groups every advertised tool exactly once, and nothing else', () => {
    const grouped = TOOL_GROUPS.flatMap((g) => g.tools)
    expect([...grouped].sort()).toEqual([...advertised].sort())
    expect(new Set(grouped).size).toBe(grouped.length)
  })

  it('lists exactly the section actions that wait for a person', () => {
    const expected = DOMAIN_TOOLS.map((d) => ({
      tool: d.name,
      actions: Object.entries(d.actions)
        .filter(([, a]) => needsApproval(a.tool))
        .map(([name]) => name),
    })).filter((d) => d.actions.length > 0)
    expect(GATED_ACTIONS).toEqual(expected)
  })
})

describe('the install commands are the ones agents are told', () => {
  it.each(INSTALLS.filter((i) => i.language === 'bash').map((i) => [i.id, i.code]))(
    '%s appears verbatim in client-setup.md',
    (_id, code) => {
      expect(CLIENT_SETUP).toContain(code)
    },
  )

  it('points every remote config at the live endpoint', () => {
    expect(MCP_ENDPOINT).toBe('https://backenly.com/api/mcp')
    for (const install of INSTALLS.filter((i) => i.language === 'json')) {
      const config = JSON.parse(install.code) as { mcpServers: { backenly: { url: string } } }
      expect(config.mcpServers.backenly.url).toBe(MCP_ENDPOINT)
    }
  })

  it('names the read-only tool count the same way in the FAQ', () => {
    const answer = FAQ.find((f) => /read-only/i.test(f.q))!.a
    expect(answer).toContain(`${READ_ONLY_TOOL_COUNT} tools`)
  })

  it('names every part the one History records in the undo answer', () => {
    // lib/changes/resources records these beside the schema (docs/CHANGE_RECOVERY.md, "One history").
    const words: Record<string, string> = { env: 'environment variables' }
    const answer = FAQ.find((f) => /undo/i.test(f.q))!.a
    expect(answer).toMatch(/the schema/)
    for (const part of RESOURCE_ORDER) expect([part, answer.includes(words[part] ?? part)]).toEqual([part, true])
    expect(answer).toMatch(/never rewound/)
  })
})
