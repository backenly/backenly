/**
 * What the investigator writes is read by the project's owner on the finding's
 * card. Production QA (2026-11-16): its explanations cited evidence ids ("the
 * single live review row (e4)") and rule names (`unique_by_name`), and the card
 * for a guessed rule said "Approve the pending finding" while its buttons were
 * "Keep it" and "Remove it".
 */

import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { investigateFinding, plainProse, type InvestigationInput } from '@/lib/autonomy/investigator'

const guessed: InvestigationInput = {
  projectId: 'p1',
  finding: {
    type: 'guessed_constraint',
    severity: 'warning',
    status: 'pending_approval',
    detectedAt: new Date('2026-11-16T00:00:00Z'),
    summary: 'Backenly’s name rules added UNIQUE on reviews.name. Remove it?',
    details: {
      tableName: 'reviews',
      columnName: 'name',
      constraintName: 'reviews_name_key',
      location: 'reviews.reviews_name_key',
      rule: 'unique_by_name',
      evidence: 'unrecorded',
      definition: 'UNIQUE (name)',
    },
  },
  deterministic: null,
  catalog: [{ name: 'reviews', columns: ['id', 'name', 'body'] }],
  recentActivity: [],
  priorAttempts: [],
  choices: ['Remove it', 'Keep it'],
}

const answer = (over: Record<string, unknown> = {}) =>
  scriptedMessage({
    text: JSON.stringify({
      verdict: 'explained',
      rootCause: 'The single live review row (e4) shares its name with no other row.',
      evidenceRefs: ['finding'],
      ruledOut: ['a duplicate already exists (e2)'],
      recommendation: 'Approve the pending finding (e1, e2) unless reviews need unique names.',
      proposedAction: null,
      riskNote: 'Removing it allows duplicates [e3].',
      namedTables: ['reviews'],
      namedColumns: ['reviews.name'],
      ...over,
    }),
  })

beforeEach(() => setSpendLedgerForTests(memorySpendLedger()))
afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

describe('the brief', () => {
  it('says what a guessed rule is in words, and names the card’s buttons', async () => {
    const provider = scriptedProvider([answer()])
    setProviderForTests(provider)
    await investigateFinding(guessed, async () => ({ outcome: 'x' }), [])
    const brief = JSON.stringify(provider.calls[0].params.messages[0])
    expect(brief).not.toContain('unique_by_name')
    expect(brief).not.toContain('unrecorded')
    expect(brief).toContain('because the column')
    expect(brief).toContain('\\"Remove it\\"')
    expect(brief).toContain('\\"Keep it\\"')
  })

  it('tells the model to keep evidence ids and internal codes out of what a person reads', async () => {
    const provider = scriptedProvider([answer()])
    setProviderForTests(provider)
    await investigateFinding(guessed, async () => ({ outcome: 'x' }), [])
    const system = JSON.stringify(provider.calls[0].params.system)
    expect(system).toMatch(/never put an evidence id/i)
    expect(system).toMatch(/buttons/i)
  })
})

describe('the answer', () => {
  it('keeps its citations in evidenceRefs, not in its sentences', async () => {
    setProviderForTests(scriptedProvider([answer()]))
    const r = await investigateFinding(guessed, async () => ({ outcome: 'x' }), [])
    expect(r.rootCause).toBe('The single live review row shares its name with no other row.')
    expect(r.recommendation).toBe('Approve the pending finding unless reviews need unique names.')
    expect(r.riskNote).toBe('Removing it allows duplicates.')
    expect(r.ruledOut).toEqual(['a duplicate already exists'])
    expect(r.evidenceRefs).toEqual(['finding'])
  })
})

describe('plain prose', () => {
  it.each([
    ['The row (e4) is the only one.', 'The row is the only one.'],
    ['Two probes agree (e1, e2).', 'Two probes agree.'],
    ['It is empty [e3], so nothing breaks.', 'It is empty, so nothing breaks.'],
    ['It is empty (see e2 and e5).', 'It is empty.'],
    ['The detector says so (finding).', 'The detector says so.'],
    ['The table is empty per e4.', 'The table is empty.'],
    ['As e3 shows, the column is unique.', 'As the evidence shows, the column is unique.'],
    ['The probe result in evidence e2 says it is unused.', 'The probe result in the evidence says it is unused.'],
  ])('%s', (text, plain) => {
    expect(plainProse(text)).toBe(plain)
  })

  it('leaves ordinary words alone', () => {
    const text = 'The finding names e2e tests, the e-mail column and an E164 number.'
    expect(plainProse(text)).toBe(text)
  })
})
