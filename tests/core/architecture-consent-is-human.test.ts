/**
 * ARCHITECTURE CHANGES ARE APPROVED BY A PERSON, THROUGH ONE DOOR
 * ===============================================================
 *
 * The Architecture Evolution Engine may propose, rehearse and observe on its
 * own. It may never decide that a production table is restructured: that is a
 * person's consent to one exact plan version. Agents (Claude Code, Cursor,
 * Codex over MCP) may read proposals and outcomes and must never be able to
 * approve, pause, resume or undo one.
 *
 * Source-level assertions, in the style of maintenance-gates-are-live: a
 * behavioural test proves the door works on the path it drives; these prove
 * there is no OTHER door, which is the property that matters.
 */

import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return []
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap(e => {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) return walk(rel)
    return /\.(ts|tsx)$/.test(e.name) ? [rel] : []
  })
}

/** Every function that records or changes consent, or moves a change forward or back. */
const DECISIONS = /\b(approveRequest|grantEvolutionApproval|revokeEvolutionApproval|claimRequest|executeExtraction|rollbackExtraction)\b|\b(pause|resume|undo|advance)\s*\(\s*\{\s*projectId/

describe('the decision door', () => {
  const ROUTE = 'app/api/projects/[id]/architecture/route.ts'

  it('is one route, and it requires a platform session', () => {
    const src = read(ROUTE)
    expect(src).toMatch(/export async function POST[\s\S]*withProjectValidation/)
    expect(src).toMatch(/export async function GET[\s\S]*withProjectValidation/)
    // withProjectValidation authenticates a SESSION; MCP credentials are API keys.
    expect(read('lib/middleware/projectValidation.ts')).toMatch(/requireAuth|verifySession/)
  })

  it('takes the spec from the request row, never from the body', () => {
    const route = read(ROUTE)
    expect(route).not.toMatch(/body\.spec/)
    const engine = read('lib/evolution-engine/engine.ts')
    expect(engine).toMatch(/normaliseSpec\(ev\.spec\)/)
  })

  it('the old structural-evolution route, which accepted a spec from the body, is gone', () => {
    expect(fs.existsSync(path.join(ROOT, 'app/api/projects/[id]/structural-evolution/route.ts'))).toBe(false)
  })
})

describe('agents can read and never decide', () => {
  const AGENT_SURFACES = [...walk('lib/mcp'), ...walk('lib/ai/brain'), ...walk('app/api/mcp')]

  it('finds the agent surfaces it is guarding', () => {
    expect(AGENT_SURFACES.length).toBeGreaterThan(5)
  })

  it.each(AGENT_SURFACES)('%s reaches no decision', file => {
    expect(read(file)).not.toMatch(DECISIONS)
  })

  it('the MCP tool is read-only and says where the decision is made', () => {
    const tools = read('lib/ai/brain/tools.ts')
    const handler = tools.slice(tools.indexOf("if (name === 'get_evolution_proposals')"), tools.indexOf('// ── Autonomy: set dial'))
    expect(handler).toMatch(/architectureSummary|decisionDetail/)
    expect(handler).not.toMatch(/approveRequest|\.grant\(|\bundo\(\{|\bpause\(\{|\bresume\(\{/)
    expect(handler).toMatch(/Autonomy page/)
  })
})

describe('the request row cannot be approved by any generic path', () => {
  it('is never written open and never carries a fix', () => {
    const src = read('lib/evolution-engine/request.ts')
    expect(src).not.toMatch(/status:\s*'open'/)
    expect(src).not.toMatch(/\bfix\s*:/)
    expect(src).toMatch(/status: 'pending_approval'/)
  })

  it.each([
    'app/api/projects/[id]/health/route.ts',
    'app/api/projects/[id]/health/approve/route.ts',
    'lib/ai/approval-manager.ts',
  ])('%s refuses it', file => {
    expect(read(file)).toMatch(/isEvolutionApprovalFinding\(/)
  })

  it('is never shown to a model, or rewritten, by the escalation diagnosis', () => {
    // It reads pending rows, calls a model and writes the row back whole: on
    // this type that would send the plan's SQL out and revert the engine's
    // own updates made during the call.
    expect(read('lib/autonomy/escalation-diagnosis.ts')).toMatch(/type: \{ not: EVOLUTION_FINDING_TYPE \}/)
  })
})
