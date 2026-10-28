/**
 * WHAT THE SITE SAYS BACKENLY DOES ON ITS OWN, HELD TO THE CODE
 * =============================================================
 * Self-healing, self-restructuring and History are described for search
 * engines and assistants in several places: llms.txt, the structured data, the
 * feature pages (/features/deployment-ready-backends,
 * /features/self-restructuring-schema, /features/undo-and-rollback), the agent
 * docs and the README. These are the claims in that copy that code decides, so
 * a change that makes one untrue fails here instead of leaving a page that
 * says otherwise:
 *
 *   one kind of restructuring    lib/evolution-engine/installed.ts installs one primitive
 *   the old columns are yours    lib/structural-evolution/plan.ts: contract is human_only
 *   no model, no credits         nothing in the evolution engine calls a model, and the
 *                                autonomy loop's own model calls are platform-paid
 *   agents cannot decide         the only architecture tool an agent has is a read
 *   restore windows              the pricing table and the self-hosted entitlements
 *   a revoked key stays revoked  lib/changes/resources/keys.ts
 */

import fs from 'fs'
import path from 'path'
import { FEATURES } from '@/app/features/data'
import { DOMAIN_TOOLS } from '@/lib/mcp/domains'
import { BRAIN_TOOLS } from '@/lib/ai/brain/tools'
import { defaultPayer } from '@/lib/ai/llm/spend'
import { selfHostedEntitlements } from '@/lib/entitlements/self-hosted'

const ROOT = process.cwd()
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function sources(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) return sources(rel)
    return /\.tsx?$/.test(e.name) ? [rel] : []
  })
}

const LLMS = read('public/llms.txt')
const restructuring = FEATURES['self-restructuring-schema']
const undo = FEATURES['undo-and-rollback']
const answer = (page: typeof undo, question: RegExp) => page.faq.find((f) => question.test(f.q))!.a

describe('self-restructuring', () => {
  it('is one kind of change, because the engine installs one primitive', () => {
    const installed = [...read('lib/evolution-engine/installed.ts').matchAll(/^import '([^']+)'/gm)].map((m) => m[1])
    expect(installed).toEqual(['@/lib/structural-evolution/primitive'])
    // On the day a second primitive is installed, this page says what it does too.
    expect(answer(restructuring, /restructure today/)).toMatch(/^One kind of change: moving a group of columns/)
  })

  it('leaves dropping the old columns to a person: the executor never runs contract', () => {
    expect(read('lib/structural-evolution/plan.ts')).toContain("contract: 'human_only@1'")
    expect(read('lib/structural-evolution/primitives.ts')).toContain('contract is performed by a person and is never run by the executor')
    for (const text of [restructuring.details.map((d) => d.body).join(' '), LLMS]) {
      expect(text).toMatch(/dropping the old columns is (left to a person|in the plan for you to see; Backenly never runs it)/i)
    }
  })

  it('calls no model, so it draws no AI credits', () => {
    const files = [...sources('lib/evolution-engine'), ...sources('lib/structural-evolution')]
    expect(files.length).toBeGreaterThan(10)
    const calling = files.filter((f) => /@\/lib\/ai\/llm|@anthropic-ai\/sdk|from 'openai'/.test(read(f)))
    expect(calling).toEqual([])
  })

  it('is approved by a person: the one architecture tool an agent has only reads', () => {
    const tools = [
      ...DOMAIN_TOOLS.flatMap((d) => Object.values(d.actions).map((a) => a.tool)),
      ...BRAIN_TOOLS.map((t) => t.function.name),
    ].filter((name) => /evolution|architecture/.test(name))
    expect([...new Set(tools)]).toEqual(['get_evolution_proposals'])
  })

  it('names the two switches a self-hosted install turns on', () => {
    const flags = read('lib/config/flags.ts')
    for (const flag of ['ENABLE_EVOLUTION_MUTATIONS', 'ENABLE_EVOLUTION_SCHEDULER']) {
      expect(flags).toContain(`get ${flag}()`)
      expect(answer(restructuring, /AI credits/)).toContain(flag)
    }
  })
})

describe('self-healing', () => {
  it('never charges AI credits: the loop’s own model calls are paid by the deployment', () => {
    expect(defaultPayer('autonomy.investigate')).toBe('platform')
    expect(LLMS).toMatch(/fixes are rule-based and never draw AI credits/)
    // The loop asks a model to explain what its rules could not conclude, so
    // "runs no model" would not be true.
    expect(LLMS).not.toMatch(/runs no model/)
    expect(read('public/docs/agents/autonomy.md')).not.toMatch(/runs no model/)
  })
})

describe('undo and rollback', () => {
  it('states the restore windows the plans and a self-hosted install really keep', () => {
    const row = /label: 'Schema change restore points kept'.*cells: \['(\d+) days', '(\d+) days', '(\d+) days'\]/.exec(read('app/pricing/page.tsx'))
    expect(row).not.toBeNull()
    const [, free, pro, enterprise] = row!
    const selfHosted = selfHostedEntitlements().logRetentionDays
    expect(answer(undo, /Free plan/)).toContain(
      `${free} days on Free, ${pro} on Pro and ${enterprise} on Enterprise, or ${selfHosted} when you self-host`,
    )
  })

  it('says a revoked key never comes back, as the key restore does', () => {
    expect(read('lib/changes/resources/keys.ts')).toContain('a revoked key never comes back')
    expect(undo.details.map((d) => d.body).join(' ')).toContain('a revoked key never comes back')
    expect(LLMS).toContain('a revoked key never comes back')
  })
})
