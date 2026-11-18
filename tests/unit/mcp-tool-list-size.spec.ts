/**
 * What tools/list costs every session.
 *
 * Production QA (2026-11-09, report 99): tools/list was about 49 KB (~12k
 * tokens), sent to the model at the start of every session before the user
 * typed anything. Long prose that fetch_docs already serves, repeated
 * sentences and an argument only the brain's own model uses were cut from it
 * (#745, to 43.6 KB). Then each description was cut to what an agent needs to
 * call the tool correctly, with a pointer to the docs topic that has the rest
 * (tests/unit/mcp-tool-docs-topics.spec.ts): 29.3 KB, of which 25.7 KB is
 * what a host hands the model (name, description, input schema; titles and
 * annotations stay with the host). For comparison, measured the same way from
 * their published source on 2026-11-12: GitHub's default toolsets 53.7 KB,
 * Supabase's default 33.2 KB, Neon's recommended categories 81.0 KB, Stripe's
 * 22-tool local server 20.8 KB.
 *
 * The read-write budgets leave about 2% of room: a few arguments fit, a
 * paragraph does not. A tool or action added later says what an agent needs to
 * call it and leaves the rest to its docs topic. If it still does not fit,
 * raise the budget here by what the addition costs, where a reviewer sees it.
 *
 * Raised so far: storage's set_uploads action and create_bucket's uploads
 * argument (who may upload into a bucket), 267 bytes on a read-write key and
 * nothing on a read-only one, measured against main with every earlier
 * addition in (2026-11-17).
 */
import { mcpTools } from '@/lib/mcp/protocol/remote-server'

const tools = (readOnly: boolean) => mcpTools(readOnly) as unknown as Array<{ name: string; description: string; inputSchema: unknown }>
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

/** All of tools/list, as the server sends it. */
const wire = (readOnly: boolean) => bytes({ tools: tools(readOnly) })

/** What a host passes to the model for each tool. */
const model = (readOnly: boolean) =>
  bytes({ tools: tools(readOnly).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })

it('fits a read-write key’s tools/list in 30.27 KB', () => {
  expect(wire(false)).toBeLessThanOrEqual(30_267)
})

it('fits a read-only key’s tools/list in 12.5 KB', () => {
  expect(wire(true)).toBeLessThanOrEqual(12_500)
})

it('hands the model at most 26.67 KB of tool definitions on a read-write key, and 10.1 KB on a read-only one', () => {
  expect(model(false)).toBeLessThanOrEqual(26_667)
  expect(model(true)).toBeLessThanOrEqual(10_100)
})

it('offers no argument only the brain’s own model uses', () => {
  const connect = mcpTools(false).find((t: { name: string }) => t.name === 'connect') as unknown as { inputSchema: { properties: Record<string, unknown> } }
  expect(Object.keys(connect.inputSchema.properties)).not.toContain('force')
})
