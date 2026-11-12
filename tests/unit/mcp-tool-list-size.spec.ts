/**
 * What tools/list costs every session.
 *
 * Production QA (2026-11-09, report 99): tools/list was about 49 KB (~12k
 * tokens), sent to the model at the start of every session before the user
 * typed anything. Long prose that fetch_docs already serves, repeated
 * sentences and an argument only the brain's own model uses were cut from it
 * (#745, to 43.6 KB). Then each description was cut to what an agent needs to
 * call the tool correctly, with a pointer to the docs topic that has the rest
 * (tests/unit/mcp-tool-docs-topics.spec.ts): 29.0 KB, of which 25.4 KB is
 * what a host hands the model (name, description, input schema; titles and
 * annotations stay with the host). For comparison, measured the same way from
 * their published source on 2026-11-12: GitHub's default toolsets 53.7 KB,
 * Supabase's default 33.2 KB, Neon's recommended categories 81.0 KB, Stripe's
 * 22-tool local server 20.8 KB.
 *
 * A tool or action added later fits in this budget by saying what an agent
 * needs to call it, and leaves the rest to its docs topic.
 */
import { mcpTools } from '@/lib/mcp/protocol/remote-server'

const tools = (readOnly: boolean) => mcpTools(readOnly) as unknown as Array<{ name: string; description: string; inputSchema: unknown }>
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

/** All of tools/list, as the server sends it. */
const wire = (readOnly: boolean) => bytes({ tools: tools(readOnly) })

/** What a host passes to the model for each tool. */
const model = (readOnly: boolean) =>
  bytes({ tools: tools(readOnly).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })

it('fits a read-write key’s tools/list in 29.5 KB', () => {
  expect(wire(false)).toBeLessThanOrEqual(29_500)
})

it('fits a read-only key’s tools/list in 12.5 KB', () => {
  expect(wire(true)).toBeLessThanOrEqual(12_500)
})

it('hands the model at most 25.8 KB of tool definitions on a read-write key, and 10.1 KB on a read-only one', () => {
  expect(model(false)).toBeLessThanOrEqual(25_800)
  expect(model(true)).toBeLessThanOrEqual(10_100)
})

it('offers no argument only the brain’s own model uses', () => {
  const connect = mcpTools(false).find((t: { name: string }) => t.name === 'connect') as unknown as { inputSchema: { properties: Record<string, unknown> } }
  expect(Object.keys(connect.inputSchema.properties)).not.toContain('force')
})
