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
 *
 * Since then a rollback became what people took it for: an agent asks for the
 * backend to be restored to a published version, a person approves
 * Backenly's list of the changes it would undo, and approving undoes them
 * (lib/changes/range.ts). Moving the version label alone is left only to
 * lib/deployment/rollback.ts, which still says it is bookkeeping.
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
    expect(src).toContain('a person uses Restore on that version (History or Deploy)')
  })

  // An agent's rollback is a request to restore the backend to a published
  // version, approved by a person, and approving restores it (lib/changes/range.ts).
  it('the brain tool description tells the agent what rollback really does', () => {
    const tool = BRAIN_TOOLS.find((t) => t.function.name === 'rollback_deploy')!
    expect(tool.function.description).toContain('Ask for the backend to be restored to a published version')
    expect(tool.function.description).toContain('waits for a person to approve')
    expect(tool.function.description).toContain('You cannot run or approve it yourself')
    expect(tool.function.description).not.toContain('bookkeeping')
  })

  it('the domain gloss matches', () => {
    const deploy = (DOMAIN_TOOLS as any[]).find((d) => d.name === 'deploy')
    const gloss: string = deploy.actions.rollback.gloss
    expect(gloss).toContain('ask to restore the backend to a published version')
    expect(gloss).toContain('a person approves')
    expect(gloss).not.toContain('bookkeeping')
  })

  it('the generated agent doc carries the regenerated gloss', () => {
    const md = read('public/docs/agents/deploy.md')
    expect(md).toContain("ask to restore the backend to a published version (version or deploymentId); a person approves Backenly's list")
    expect(md).not.toContain('which can be rolled back to')
  })

  it('the executor\'s own rollback runs nothing and says how to ask', () => {
    const src = read('lib/ai/minimal-executor.ts')
    expect(src).toContain("error: 'RESTORE_NEEDS_A_PERSON'")
    expect(src).toContain('ask for it with')
  })

  it('the Deploy page describes publishing as recording a version', () => {
    const src = read('app/app/projects/[id]/deploy/page.tsx')
    expect(src).toContain('Publishing records a version')
    expect(src).toContain('serves changes as they are made')
  })
})
