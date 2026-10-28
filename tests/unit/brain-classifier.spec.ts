/**
 * How the classifier reads the model's answer (lib/ai/brain/classifier.ts).
 * The schema it asks for binds a provider that enforces structured output, but
 * OpenAI is sent it with strict: false, so an answer can still name a known
 * intent in lower case or write its confidence as a string. A scripted provider
 * stands in for the model and spend is kept in memory, so nothing here needs a
 * database. tests/integration/brain-on-gateway.spec.ts runs whole turns.
 */

import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { classify } from '@/lib/ai/brain/classifier'

/** Classify one message, with the model answering `answer` as its JSON. */
async function classifyAnswered(answer: Record<string, unknown>) {
  setProviderForTests(scriptedProvider([scriptedMessage({ text: JSON.stringify(answer) })]))
  return classify({ message: 'add a comments table linked to posts' })
}

beforeEach(() => setSpendLedgerForTests(memorySpendLedger()))

afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

describe('the classifier reads the answer it was given', () => {
  it('takes an intent written in lower case as the intent it names', async () => {
    await expect(classifyAnswered({ intent: 'build', confidence: 0.92, reasoning: 'adds a table' })).resolves.toMatchObject({
      intent: 'BUILD',
      confidence: 0.92,
    })
  })

  it('takes a confidence written as a string as that number', async () => {
    await expect(classifyAnswered({ intent: 'BUILD', confidence: '0.92', reasoning: 'adds a table' })).resolves.toMatchObject({
      intent: 'BUILD',
      confidence: 0.92,
    })
  })

  it('still reads an intent it does not know, or a confidence that is not a number, as unclear', async () => {
    await expect(classifyAnswered({ intent: 'build it', confidence: 0.92, reasoning: '' })).resolves.toMatchObject({
      intent: 'UNCLEAR',
    })
    await expect(classifyAnswered({ intent: 'BUILD', confidence: 'high', reasoning: '' })).resolves.toMatchObject({
      intent: 'UNCLEAR',
      confidence: 0,
    })
  })
})
