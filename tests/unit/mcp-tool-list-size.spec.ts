/**
 * What tools/list costs every session.
 *
 * Production QA (2026-11-09, report 99): tools/list was about 49 KB (~12k
 * tokens), sent to the model at the start of every session before the user
 * typed anything. Long prose that fetch_docs already serves, repeated
 * sentences and an argument only the brain's own model uses were cut from it.
 * A tool added later fits in this budget by saying what an agent needs to call
 * it, and leaves the rest to its docs topic.
 */
import { mcpTools } from '@/lib/mcp/protocol/remote-server'

const bytes = (readOnly: boolean) => Buffer.byteLength(JSON.stringify({ tools: mcpTools(readOnly) }), 'utf8')

it('fits a read-write key’s tools/list in 44 KB', () => {
  expect(bytes(false)).toBeLessThanOrEqual(44_000)
})

it('fits a read-only key’s tools/list in 17 KB', () => {
  expect(bytes(true)).toBeLessThanOrEqual(17_000)
})

it('offers no argument only the brain’s own model uses', () => {
  const connect = mcpTools(false).find((t: { name: string }) => t.name === 'connect') as unknown as { inputSchema: { properties: Record<string, unknown> } }
  expect(Object.keys(connect.inputSchema.properties)).not.toContain('force')
})
