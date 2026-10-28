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
 *
 * The pages that describe plans follow: no restore asks for the plan, so
 * every plan has rollback, and what a plan sets is how long restore points
 * are kept (lib/changes/policy.ts).
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

  it('the pricing page sells rollback on every plan, since no restore asks for the plan', () => {
    const pricing = read('app/pricing/page.tsx')
    expect(pricing).toContain("label: 'Deployment history and rollback', cells: ['Full history', 'Full history', 'Full history']")
    // Pro's list is "Everything in Free, plus": rollback there says Free has none.
    expect(pricing).not.toContain('Full deployment history and rollback')
    expect(pricing).not.toContain('rollback history')
    expect(pricing).toContain("{ text: 'Restore points kept for 30 days' }")
    // The plan's rollback flag is read only by the label-only rollback, which no console flow calls.
    for (const f of ['app/api/projects/[id]/changes/restore-to/route.ts', 'lib/changes/range.ts', 'lib/changes/recovery.ts', 'lib/mcp/approvals.ts', 'lib/ai/brain/tools.ts']) {
      expect([f, read(f).includes('allowDeploymentRollback')]).toEqual([f, false])
    }
  })

  it('no page says rollback is limited to paid plans', () => {
    // "rolled back" and "undone" too: "on Pro and above any recorded change can
    // be rolled back" sat in a features FAQ after every other line was fixed,
    // because only "rollback" and "roll back" were looked for.
    const rollback = /roll(?:ed|ing)? ?back|\bundo(?:ne)?\b/i
    const gated = /Pro and (higher|above)|plan-gated|not available on Free|Pro:[^'"\n]*(?:roll(?:ed|ing)? ?back|\bundo)/i
    for (const f of ['app/docs/content.ts', 'app/features/data.ts', 'app/use-cases/data.ts', 'app/comparisons/data.ts', 'app/pricing/page.tsx', 'app/terms/page.tsx', 'public/llms.txt']) {
      const claims = read(f).split(/(?<=[.!?])\s+|\n/).filter((s) => rollback.test(s) && gated.test(s))
      expect([f, claims]).toEqual([f, []])
    }
  })
})
