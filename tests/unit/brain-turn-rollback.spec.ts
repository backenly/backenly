/**
 * The brain is offered no tool that cannot run, and claims no undo of a turn.
 *
 * `rollback` was offered to the model as "Undo the last N agent actions in this
 * turn", and the manifest said it "Drops created tables, removes generated
 * APIs" and that the agent "can roll back this turn". Its dispatch refused
 * every call, so the model could promise an undo, spend a step on it and get
 * nothing back. A change is restored on its own, by a person
 * (revert_schema_change, History); nothing may say otherwise.
 */

import { BRAIN_MODEL_TOOLS, BRAIN_TOOLS, dispatchTool } from '@/lib/ai/brain/tools'
import { TOOL_CAPABILITIES } from '@/lib/ai/brain/capabilities'
import { agentSystemPrompt, answererPrompt, assistantPrompt } from '@/lib/ai/brain/prompts'

/** An undo of the turn itself, or of its last few steps. */
const TURN_UNDO = /\b(?:undo|roll(?:ing)? ?back)\b[^.]{0,40}\b(?:this turn|the turn|the last \S+ (?:agent )?actions?)\b/i

describe('no undo of a turn', () => {
  it('offers the model no rollback tool, and dispatches none', async () => {
    expect(BRAIN_MODEL_TOOLS.map((t) => t.function.name).filter((name) => name === 'rollback')).toEqual([])
    const result = await dispatchTool('rollback', { steps: 1 }, { projectId: 'p' })
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/^Unknown tool/)
  })

  it('advertises only tools that exist', () => {
    const tools = new Set(BRAIN_TOOLS.map((t) => t.function.name))
    expect(TOOL_CAPABILITIES.filter((c) => c.tool && !tools.has(c.tool)).map((c) => c.id)).toEqual([])
  })

  it.each([
    ['the agent prompt', agentSystemPrompt()],
    ['the answerer prompt', answererPrompt()],
    ['the dashboard prompt', assistantPrompt('')],
  ])('%s does not claim one', (_name, prompt) => {
    expect(prompt.match(TURN_UNDO)?.[0] ?? null).toBeNull()
  })

  it('no tool the model is offered describes one', () => {
    const claims = BRAIN_MODEL_TOOLS.filter((t) => TURN_UNDO.test(t.function.description ?? '')).map((t) => t.function.name)
    expect(claims).toEqual([])
  })
})
