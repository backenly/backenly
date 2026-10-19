/**
 * DEPLOY AND ROLLBACK SAY WHAT THEY DO
 * ====================================
 * The product's one true model is stated in app/docs/content.ts: "Your API
 * answers before you publish … Publishing records a version; it does not
 * switch the API on." Nothing on the data plane reads projectStatus, and
 * deploy-rollback moves `Project.activeGraphId` — version bookkeeping — with
 * no DDL.
 *
 * Yet the Deploy page said "Production changes only when you publish", "The
 * runtime stays locked until activation completes", "the previous version is
 * still serving"; and every rollback surface — the confirmation prompt, the
 * executor warning, the brain tool, the domain gloss, the docs — said "Live
 * consumers will start seeing the older schema and API shape immediately."
 * A user who rolled back after a bad change believed production was restored;
 * it was not.
 *
 * This suite pins every one of those surfaces to the true model, and pins the
 * lie's exact phrases to never return.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { BRAIN_TOOLS } from '@/lib/ai/brain/tools'
import { DOMAIN_TOOLS } from '@/lib/mcp/domains'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const FALSE_CLAIMS = [
  'Production changes only when you publish',
  'stays locked until activation completes',
  'previous version is still serving',
  'Live consumers will start seeing the older schema',
  'Live consumers will see the older schema',
  'older schema and API shape immediately',
]

const SURFACES = [
  'app/app/projects/[id]/deploy/page.tsx',
  'lib/deployment/rollback.ts',
  'lib/ai/minimal-executor.ts',
  'lib/ai/brain/tools.ts',
  'lib/ai/brain/capabilities.ts',
  'lib/mcp/domains.ts',
  'app/docs/content.ts',
  'public/docs/agents/deploy.md',
]

describe('the false claims never return', () => {
  for (const surface of SURFACES) {
    it(`${surface} carries none of them`, () => {
      const src = read(surface)
      for (const claim of FALSE_CLAIMS) {
        expect(src).not.toContain(claim)
      }
    })
  }
})

describe('every surface states the true model', () => {
  it('the rollback confirmation and result say bookkeeping, not restore', () => {
    const src = read('lib/deployment/rollback.ts')
    expect(src).toContain('does NOT change the live schema')
    expect(src).toContain('version bookkeeping, not a restore')
    expect(src).toContain("Database → Changes")
  })

  it('the brain tool description tells the agent what rollback really does', () => {
    const tool = BRAIN_TOOLS.find((t) => t.function.name === 'rollback_deploy')!
    expect(tool.function.description).toContain('does NOT change the live schema')
    expect(tool.function.description).toContain('bookkeeping')
  })

  it('the domain gloss matches', () => {
    const deploy = (DOMAIN_TOOLS as any[]).find((d) => d.name === 'deploy')
    const gloss: string = deploy.actions.rollback.gloss
    expect(gloss).toContain('bookkeeping')
    expect(gloss).toContain('unchanged')
  })

  it('the generated agent doc carries the regenerated gloss', () => {
    const md = read('public/docs/agents/deploy.md')
    expect(md).toContain('version bookkeeping; the live backend is unchanged')
  })

  it('the Deploy page describes publishing as recording a version', () => {
    const src = read('app/app/projects/[id]/deploy/page.tsx')
    expect(src).toContain('Publishing records a version')
    expect(src).toContain('serves changes as they are made')
  })
})
