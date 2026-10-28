/**
 * WHAT AN APPROVAL STORES, AND WHAT THE MODEL MAY ROTATE
 * ======================================================
 * Two pins against credentials escaping through the approval machinery:
 *
 * 1. `storableResultSummary` — the only form in which an approved call's
 *    outcome may be persisted. `resultSummary` is served forever (the Review
 *    Queue to every member, `check_approval` to the agent's key), and
 *    executeRotateKey's summary prints the new key under "copy now — shown
 *    once". Storing it unwithheld made "once" mean "until the row is deleted".
 *
 * 2. `rotate_api_key` is not offered to the brain's model. The connect domain
 *    already refuses to route it because its result IS a new credential; the
 *    chat door parks destructive calls, which is how the rotation reached the
 *    stored summary in the first place. The tool stays in BRAIN_TOOLS (the
 *    by-name door refuses destructive tools outright, it does not park them).
 *
 * 3. `redactSecretParams` — the display copy of parked executor params: secret
 *    fields replaced, structure kept, input unmutated.
 */

import { storableResultSummary } from '@/lib/mcp/approvals'
import { redactSecretParams, withholdSecrets } from '@/lib/mcp/withhold-secrets'
import { BRAIN_TOOLS, BRAIN_MODEL_TOOLS, isDestructiveTool } from '@/lib/ai/brain/tools'

describe('storableResultSummary', () => {
  it('withholds every credential shape Backenly issues from a rotation summary', () => {
    const mcpKey = `mcp_live_${'a1b2c3d4'.repeat(8)}`
    const skKey = `sk_live_${'0123456789abcdef'.repeat(2)}`
    const projKey = `proj_live_${'A1b2C3d4'.repeat(4)}`
    const summary =
      `✅ **API key rotated.**\n\n**New key (copy now — shown once):**\n\`\`\`\n${skKey}\n\`\`\`\n` +
      // 'example' in the password marks the DSN illustrative for the OSS
      // preflight scanner; the withholder redacts by URL shape either way.
      `Also minted ${mcpKey} and ${projKey} for postgres://u:hunter2-example@localhost:5432/x`

    const stored = storableResultSummary(summary)

    expect(stored).not.toContain(mcpKey)
    expect(stored).not.toContain(skKey)
    expect(stored).not.toContain(projKey)
    expect(stored).not.toContain('hunter2-example')
    expect(stored).toContain('[withheld]')
    expect(stored.length).toBeLessThanOrEqual(2000)
  })

  it('caps at 2000 characters after withholding', () => {
    expect(storableResultSummary('x'.repeat(5000))).toHaveLength(2000)
  })
})

describe('redactSecretParams', () => {
  it('replaces secret-named string values at any depth and keeps the shape', () => {
    const params = {
      key: 'STRIPE_SECRET_KEY',
      value: 'fixture-supersecret-123456',
      description: 'billing',
      nested: { password: 'p@ssw0rd-123', keep: 42 },
      list: [{ apiKey: 'ak-123456789' }, { plain: 'ok' }],
    }
    const copy = JSON.parse(JSON.stringify(params))

    const redacted = redactSecretParams(params)

    expect(redacted).toEqual({
      key: 'STRIPE_SECRET_KEY',
      value: '[withheld]',
      description: 'billing',
      nested: { password: '[withheld]', keep: 42 },
      list: [{ apiKey: '[withheld]' }, { plain: 'ok' }],
    })
    // The input is not mutated: the executor still holds the real params.
    expect(params).toEqual(copy)
  })

  it('leaves non-secret params alone', () => {
    const params = { tableName: 'posts', columns: [{ name: 'title', type: 'text' }] }
    expect(redactSecretParams(params)).toEqual(params)
  })
})

describe('rotate_api_key exposure', () => {
  it('is destructive, stays dispatchable by name, and is not offered to the model', () => {
    expect(isDestructiveTool('rotate_api_key')).toBe(true)
    expect(BRAIN_TOOLS.some((t) => t.function.name === 'rotate_api_key')).toBe(true)
    expect(BRAIN_MODEL_TOOLS.some((t) => t.function.name === 'rotate_api_key')).toBe(false)
  })

  it('withholdSecrets masks a rotated key even when nothing names it', () => {
    const key = `sk_live_${'f'.repeat(32)}`
    expect(withholdSecrets(`the new key is ${key}`)).toBe('the new key is [withheld]')
  })
})
