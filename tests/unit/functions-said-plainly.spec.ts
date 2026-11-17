/**
 * FUNCTIONS ARE CALLED FUNCTIONS, AND THEIR CODE IS CALLED CODE
 * =============================================================
 *
 * Production QA re-test, 2026-11-16, #47 (partly fixed by #696): History said
 * "Changed function qa-status: description, generated code" for code an agent
 * deployed exactly as written, and a build's summary still counted "AI
 * functions". These pin the words; tool names and API values are unchanged.
 * Deploy readiness is pinned in tests/integration/deploy-readiness-says-functions.spec.ts.
 */

import { describeOp } from '@/lib/changes/resources'
import type { ResourceItem, ResourceOp } from '@/lib/changes/resources/core'
import { BuildGraph } from '@/lib/ai/build-runtime/build-graph'
import { ecommercePhases } from '@/lib/ai/build-runtime/domain-phases'
import { renderBuildResponse } from '@/lib/ai/build-runtime/build-renderer'
import type { BuildJob } from '@/lib/ai/build-runtime/types'

function fn(fields: Record<string, unknown>, label = 'function qa-status'): ResourceItem {
  return {
    label,
    fields: {
      name: 'qa-status',
      description: 'Sets an order status',
      generatedCode: 'return 1',
      codeOrigin: 'generated',
      triggerType: 'manual',
      triggerTable: 'POST /api/v1/p1/fn/qa-status',
      power: 'on',
      ...fields,
    },
  } as ResourceItem
}

const change = (before: ResourceItem, after: ResourceItem): ResourceOp => ({ resource: 'functions', key: 'function:f1', before, after })

describe('History', () => {
  it('calls a function’s code its code, whoever wrote it', () => {
    expect(describeOp(change(fn({}), fn({ description: 'Sets an order’s status', generatedCode: 'return 2' })))).toBe(
      'Changed function qa-status: description, code',
    )
    // deploy_code replacing Backenly's code with an agent's own: one change, to the code.
    expect(describeOp(change(fn({}), fn({ generatedCode: 'return 2', codeOrigin: 'agent' })))).toBe('Changed function qa-status: code')
  })

  it('names a trigger once, as a trigger, and a schedule as a schedule', () => {
    expect(describeOp(change(fn({}), fn({ triggerType: 'on_db_insert', triggerTable: 'orders' })))).toBe('Changed function qa-status: trigger')
    const job = (expression: string) => fn({ name: 'nightly', triggerType: 'cron', triggerTable: expression }, 'schedule nightly')
    expect(describeOp(change(job('0 3 * * *'), job('0 4 * * *')))).toBe('Changed schedule nightly: schedule')
  })

  it('still says who wrote the code when that is all that changed', () => {
    expect(describeOp(change(fn({}), fn({ codeOrigin: 'agent' })))).toBe('Changed function qa-status: who wrote the code')
  })
})

describe('a finished build', () => {
  it('counts functions as functions', () => {
    const graph = new BuildGraph(ecommercePhases())
    for (const node of graph.getAllNodes()) graph.markVerified(node.id, 'built')
    const job: BuildJob = {
      id: 'job-1',
      projectId: 'p1',
      userId: 'u1',
      originalPrompt: 'a store',
      domain: 'ecommerce',
      status: 'pending',
      phases: ecommercePhases(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const response = renderBuildResponse(job, graph)
    expect(response.markdown).toMatch(/\b\d+ functions?\b/)
    expect(response.markdown).not.toMatch(/AI functions?/)
    expect(response.reasoning?.decision).toContain('functions')
    expect(response.reasoning?.decision).not.toMatch(/AI functions/)
  })
})
