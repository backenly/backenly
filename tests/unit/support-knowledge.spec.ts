/**
 * What the support first responder is grounded in (lib/support/knowledge.ts)
 * and when a customer may ask it again (lib/support/constants.ts).
 *
 * The topic tables are held to the agent-docs registry, because a topic id
 * that is not a real file would be dropped silently and the responder would
 * answer that category ungrounded.
 */
import { AGENT_DOC_TOPICS } from '@/lib/mcp/agent-docs'
import {
  CATEGORY_TOPICS,
  KEYWORD_TOPICS,
  MAX_REFERENCE_CHARS,
  MAX_REFERENCE_TOPICS,
  humanDocLinks,
  supportDocTopics,
  supportReference,
} from '@/lib/support/knowledge'
import { SUPPORT_CATEGORIES, supportAiRetryAllowed } from '@/lib/support/constants'

const REAL = new Set(AGENT_DOC_TOPICS.map((t) => t.id))

describe('support doc topics', () => {
  it('names only real agent-doc topics, for every category', () => {
    for (const c of SUPPORT_CATEGORIES) {
      expect(CATEGORY_TOPICS[c.id]).toBeDefined()
      for (const topic of CATEGORY_TOPICS[c.id]) expect(REAL.has(topic)).toBe(true)
    }
    for (const [, topic] of KEYWORD_TOPICS) expect(REAL.has(topic)).toBe(true)
  })

  it('sends an MCP connection case to client setup, error codes and keys', () => {
    expect(supportDocTopics('agent', 'help me to solve this mcp not connecting to Claude code for backenly')).toEqual([
      'client-setup',
      'errors',
      'connect',
    ])
  })

  it('reads Claude Code as an agent connecting, not as calling Claude from a function', () => {
    const topics = supportDocTopics('other', 'Claude Code cannot see the Backenly tools')
    expect(topics).toContain('client-setup')
    expect(topics).not.toContain('anthropic')
  })

  it('adds what the text names past its category, within the cap', () => {
    expect(supportDocTopics('other', 'My Stripe webhook never fires')).toEqual(['webhooks', 'stripe'])
    const many = supportDocTopics('database', 'mcp sign-up upload realtime webhook stripe branch deploy')
    expect(many.length).toBe(MAX_REFERENCE_TOPICS)
    expect(many.slice(0, 2)).toEqual(['database', 'errors'])
  })

  it('links people to /docs pages, never the agent files, once each', () => {
    expect(humanDocLinks(['client-setup', 'errors', 'connect'], 'https://backenly.com')).toEqual([
      { title: 'Connect', url: 'https://backenly.com/docs/connect' },
    ])
    expect(humanDocLinks(['errors'], 'https://backenly.com')).toEqual([])
  })
})

describe('support reference block', () => {
  it('carries the real install command and error codes from public/docs/agents', async () => {
    const ref = await supportReference(['client-setup', 'errors'])
    expect(ref.topics).toEqual(['client-setup', 'errors'])
    expect(ref.text).toContain('<doc topic="client-setup" title="Connecting a client">')
    expect(ref.text).toContain('claude mcp add --transport http backenly https://backenly.com/api/mcp')
    expect(ref.text).toContain('INVALID_KEY')
  })

  it('stays within its size budget whatever is asked for', async () => {
    const ref = await supportReference(AGENT_DOC_TOPICS.map((t) => t.id))
    expect(ref.text.length).toBeLessThan(MAX_REFERENCE_CHARS + 2_000)
  })

  it('is empty, not an error, when no doc can be read', async () => {
    expect(await supportReference(['no-such-topic'])).toEqual({ topics: [], text: '' })
  })
})

describe('asking the AI first responder again', () => {
  const failed = { aiState: 'failed', aiError: 'rate_limited', aiAttempts: 3, status: 'open', firstStaffReplyAt: null }

  it('is offered after a transient failure, within the attempt cap', () => {
    expect(supportAiRetryAllowed(failed)).toBe(true)
    expect(supportAiRetryAllowed({ ...failed, aiError: null, aiAttempts: 0 })).toBe(true)
  })

  it('is not offered when it would fail the same way, or when it no longer helps', () => {
    expect(supportAiRetryAllowed({ ...failed, aiError: 'spend_limit' })).toBe(false)
    expect(supportAiRetryAllowed({ ...failed, aiError: 'access_denied' })).toBe(false)
    expect(supportAiRetryAllowed({ ...failed, aiAttempts: 5 })).toBe(false)
    expect(supportAiRetryAllowed({ ...failed, status: 'closed' })).toBe(false)
    expect(supportAiRetryAllowed({ ...failed, firstStaffReplyAt: new Date() })).toBe(false)
    expect(supportAiRetryAllowed({ ...failed, aiState: 'replied' })).toBe(false)
    expect(supportAiRetryAllowed({ ...failed, aiState: 'none' })).toBe(false)
  })
})
