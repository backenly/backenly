/**
 * The realtime agent doc says which stream carries broadcast and presence
 * frames (medium finding RT-09, the half #311 left).
 *
 * The doc showed the stream opened with `?table=` and said broadcasts arrive on
 * "this same stream". They do not: both SSE routes pass a frame only when no
 * table filter is set or the frame's table matches, and broadcast and presence
 * frames carry no table, so a hand-rolled client filtered to one table never
 * saw them and could not tell why. The SDK already opens an unfiltered stream
 * for them. These pin the code facts the doc rests on, and the doc.
 */

import fs from 'fs'
import path from 'path'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

it('both SSE routes pass a frame only when unfiltered or when its table matches', () => {
  for (const route of ['server/routes/realtime.ts', 'app/api/v1/[projectId]/realtime/route.ts']) {
    expect(read(route)).toContain('if (!tableFilter || payload.table === tableFilter)')
  }
})

it('broadcast and presence frames carry no table', () => {
  for (const route of ['server/routes/broadcast.ts', 'app/api/v1/[projectId]/broadcast/route.ts']) {
    const source = read(route)
    const at = source.indexOf("type: 'broadcast'")
    expect(at).toBeGreaterThan(-1)
    const frame = source.slice(source.lastIndexOf('{', at), source.indexOf('}', at) + 1)
    expect(frame).not.toMatch(/\btable\b/)
  }
  const presence = [...read('server/routes/presence.ts').matchAll(/json_build_object\('type','presence'[^;]*?\)::text/g)]
  expect(presence.length).toBe(3)
  for (const m of presence) expect(m[0]).not.toContain("'table'")
})

it('the agent doc says they arrive only on a stream opened without ?table=', () => {
  const doc = read('public/docs/agents/realtime.md')
  expect(doc).toContain('Neither carries a `table`, so a stream opened with `?table=` never receives them')
  expect(doc).not.toContain('arrive on this same stream')
})
