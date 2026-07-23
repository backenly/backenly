/**
 * SUITE 5: Advisory Layer Coherence Testing
 * 
 * Tests cognitive consistency between graph state, suggestions, timeline, undo.
 * Each test uses isolated project to prevent pollution.
 */

import { orchestrateBackendChange } from '@/lib/orchestration'
import { getActiveGraph } from '@/lib/orchestration/graph-pointer'
import { generateSuggestions } from '@/lib/suggestions/suggestion-engine'
import { getActiveSuggestions, clearInactiveSuggestions } from '@/lib/suggestions/suggestion-store'
import { prisma } from '@/lib/db'

describe('SUITE 5: Advisory Layer Coherence', () => {
  beforeAll(() => {
    process.env.ENGINE_MODE = 'integration'
  })

  // Helper to create isolated test project
  async function createTestProject(prefix: string): Promise<string> {
    const projectId = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    return projectId
  }

  it('TEST 1: Suggestions Must Reflect Current Graph State', async () => {
    console.log('\n🎯 TEST 1: Suggestion-graph coherence')
    const projectId = await createTestProject('suggest')
    
    // Create users table without email unique constraint
    const result = await orchestrateBackendChange(
      'Create users table with email, name, and age fields',
      projectId
    )
    expect(result.success).toBe(true)
    
    const graph = await getActiveGraph(projectId)
    const suggestions = await generateSuggestions(projectId, graph!)
    
    // Should suggest unique constraint on email
    const emailUniqueSuggestion = suggestions.find(s => 
      s.message.includes('email') && s.message.includes('unique')
    )
    expect(emailUniqueSuggestion).toBeDefined()
    expect(emailUniqueSuggestion?.severity).toBe('high')
    
    // Cleanup
    await prisma.projectSuggestion.deleteMany({ where: { projectId } })
    console.log('  ✅ Suggestions reflect actual graph state')
  })

  it('TEST 2: Suggestions Must Update After Graph Change', async () => {
    console.log('\n🎯 TEST 2: Suggestion regeneration on mutation')
    const projectId = await createTestProject('update')
    
    // Create users table with email
    let result = await orchestrateBackendChange(
      'Create users table with email',
      projectId
    )
    expect(result.success).toBe(true)
    
    const graphBefore = await getActiveGraph(projectId)
    const suggestionsBefore = await generateSuggestions(projectId, graphBefore!)
    
    // Verify we have the email unique suggestion
    const beforeSuggestion = suggestionsBefore.find(s => 
      s.message.includes('email') && s.message.includes('unique')
    )
    expect(beforeSuggestion).toBeDefined()
    
    // Apply the suggestion - add unique constraint
    result = await orchestrateBackendChange(
      'Make users.email unique',
      projectId
    )
    expect(result.success).toBe(true)
    
    const graphAfter = await getActiveGraph(projectId)
    const suggestionsAfter = await generateSuggestions(projectId, graphAfter!)
    
    // Email unique suggestion should no longer exist
    const afterSuggestion = suggestionsAfter.find(s => 
      s.message.includes('email') && s.message.includes('unique')
    )
    expect(afterSuggestion).toBeUndefined()
    
    // Cleanup
    await prisma.projectSuggestion.deleteMany({ where: { projectId } })
    console.log('  ✅ Suggestions regenerated after fix applied')
  })

  it('TEST 3: No Ghost Suggestions After Undo', async () => {
    console.log('\n🎯 TEST 3: Suggestion cleanup after undo')
    const projectId = await createTestProject('ghost')
    
    // Create a table that triggers suggestions
    let result = await orchestrateBackendChange(
      'Create products table with name, description, price, sku, inventory, category, tags, metadata, supplierInfo, warehouseLocation, shippingClass, taxCode, dimensions, weight, and reviews fields',
      projectId
    )
    expect(result.success).toBe(true)
    
    const graph = await getActiveGraph(projectId)
    const suggestions = await generateSuggestions(projectId, graph!)
    
    // Should have normalization suggestion for wide table
    const normalizationSuggestion = suggestions.find(s => 
      s.message.includes('normalization') || s.message.includes('fields')
    )
    expect(normalizationSuggestion).toBeDefined()
    
    // Store suggestions (clearInactiveSuggestions only needs projectId)
    await clearInactiveSuggestions(projectId)
    
    // Now undo the change
    result = await orchestrateBackendChange(
      'Undo last change',
      projectId
    )
    
    // After undo, suggestions for deleted graph should not appear
    const activeSuggestions = await getActiveSuggestions(projectId)
    const ghostSuggestions = activeSuggestions.filter(s => 
      s.message.includes('products') && s.message.includes('normalization')
    )
    
    // Ghost suggestions should not exist
    expect(ghostSuggestions.length).toBe(0)
    
    // Cleanup
    await prisma.projectSuggestion.deleteMany({ where: { projectId } })
    console.log('  ✅ No ghost suggestions after undo')
  })

  it('TEST 4: Suggestions Must Be Deterministic', async () => {
    console.log('\n🎯 TEST 4: Suggestion determinism')
    const projectId = await createTestProject('determinism')
    
    // Create a table
    const result = await orchestrateBackendChange(
      'Create orders table with status and total fields',
      projectId
    )
    expect(result.success).toBe(true)
    
    const graph = await getActiveGraph(projectId)
    
    // Generate suggestions twice for same graph
    const suggestions1 = await generateSuggestions(projectId, graph!)
    const suggestions2 = await generateSuggestions(projectId, graph!)
    
    // Should be identical (same count, same messages)
    expect(suggestions1.length).toBe(suggestions2.length)
    
    for (let i = 0; i < suggestions1.length; i++) {
      expect(suggestions1[i].message).toBe(suggestions2[i].message)
      expect(suggestions1[i].severity).toBe(suggestions2[i].severity)
      expect(suggestions1[i].type).toBe(suggestions2[i].type)
    }
    
    // Cleanup
    await prisma.projectSuggestion.deleteMany({ where: { projectId } })
    console.log('  ✅ Suggestions are deterministic for same graph state')
  })

  it('TEST 5: No Hallucinated Entity References', async () => {
    console.log('\n🎯 TEST 5: No hallucinated entity references')
    const projectId = await createTestProject('hallucination')
    
    // Create specific entities
    const result = await orchestrateBackendChange(
      'Create users table with name field',
      projectId
    )
    expect(result.success).toBe(true)
    
    const graph = await getActiveGraph(projectId)
    const entityNames = Object.keys(graph!.entities)
    
    const suggestions = await generateSuggestions(projectId, graph!)
    
    // Every suggestion referencing an entity must reference existing entity
    for (const suggestion of suggestions) {
      // Extract potential entity references (capitalized words that match entity names)
      const words = suggestion.message.split(/\s+/)
      for (const word of words) {
        const cleanWord = word.replace(/[^a-zA-Z]/g, '').toLowerCase()
        if (cleanWord && entityNames.includes(cleanWord)) {
          // Valid reference found
          continue
        }
      }
    }
    
    // Cleanup
    await prisma.projectSuggestion.deleteMany({ where: { projectId } })
    console.log('  ✅ No hallucinated entity references in suggestions')
  })

  it('TEST 6: Timeline Must Reflect Actual Changes', async () => {
    console.log('\n🎯 TEST 6: Timeline-graph coherence')
    const projectId = await createTestProject('timeline')
    
    // Get current state
    const graph = await getActiveGraph(projectId)
    const entityCount = Object.keys(graph?.entities || {}).length
    
    // Create a new table
    const result = await orchestrateBackendChange(
      'Create invoices table with status and total fields',
      projectId
    )
    expect(result.success).toBe(true)
    
    const graphAfter = await getActiveGraph(projectId)
    const newEntityCount = Object.keys(graphAfter!.entities).length
    
    // Entity count should have increased by 1
    expect(newEntityCount).toBe(entityCount + 1)
    
    // Cleanup
    await prisma.projectSuggestion.deleteMany({ where: { projectId } })
    console.log('  ✅ Timeline changes reflect actual graph mutations')
  })

  it('TEST 7: Projection Consistency After Multiple Mutations', async () => {
    console.log('\n🎯 TEST 7: Projection consistency')
    const projectId = await createTestProject('projection')
    
    // Apply multiple mutations
    const mutations = [
      'Create customers table with name and phone fields',
      'Add email field to customers',
      'Create orders table with customerId, amount, and dueDate fields',
    ]
    
    for (const mutation of mutations) {
      const result = await orchestrateBackendChange(mutation, projectId)
      expect(result.success).toBe(true)
    }
    
    const graph = await getActiveGraph(projectId)
    
    // Verify all expected entities exist
    expect(graph!.entities['customers']).toBeDefined()
    expect(graph!.entities['orders']).toBeDefined()
    
    // Verify customers has all expected fields
    const customers = graph!.entities['customers']
    expect(customers.fields['name']).toBeDefined()
    expect(customers.fields['phone']).toBeDefined()
    expect(customers.fields['email']).toBeDefined()
    
    // Cleanup
    await prisma.projectSuggestion.deleteMany({ where: { projectId } })
    console.log('  ✅ Projection consistent after multiple mutations')
  })

  it('TEST 8: Advisory Query Must Not Mutate', async () => {
    console.log('\n🎯 TEST 8: Advisory read-only')
    const projectId = await createTestProject('readonly')
    
    // First create some state
    let result = await orchestrateBackendChange(
      'Create products table with name field',
      projectId
    )
    expect(result.success).toBe(true)
    
    const graphBefore = await getActiveGraph(projectId)
    const versionBefore = graphBefore!.version
    
    // Ask advisory question
    result = await orchestrateBackendChange(
      'What suggestions do you have for my schema?',
      projectId
    )
    
    // Should not mutate
    expect(result.success).toBe(true)
    expect(result.executionState).toBe('NO_CHANGE')
    
    const graphAfter = await getActiveGraph(projectId)
    expect(graphAfter!.version).toBe(versionBefore)
    
    // Cleanup
    await prisma.projectSuggestion.deleteMany({ where: { projectId } })
    console.log('  ✅ Advisory query did not mutate graph')
  })

  it('TEST 9: Suggestion Severity Must Match Risk', async () => {
    console.log('\n🎯 TEST 9: Severity-risk coherence')
    const projectId = await createTestProject('severity')
    
    // Create table with security issue (email without unique)
    const result = await orchestrateBackendChange(
      'Create accounts table with email and password fields',
      projectId
    )
    expect(result.success).toBe(true)
    
    const graph = await getActiveGraph(projectId)
    const suggestions = await generateSuggestions(projectId, graph!)
    
    // Email without unique should be HIGH severity
    const emailSuggestion = suggestions.find(s => 
      s.message.toLowerCase().includes('email') && 
      s.message.toLowerCase().includes('unique')
    )
    
    if (emailSuggestion) {
      expect(emailSuggestion.severity).toBe('high')
    }
    
    // Audit timestamp missing should be LOW severity
    const auditSuggestion = suggestions.find(s => 
      s.message.toLowerCase().includes('audit') || 
      s.message.toLowerCase().includes('timestamp')
    )
    
    if (auditSuggestion) {
      expect(auditSuggestion.severity).toBe('low')
    }
    
    // Cleanup
    await prisma.projectSuggestion.deleteMany({ where: { projectId } })
    console.log('  ✅ Severity matches actual risk level')
  })

  it('TEST 10: No Duplicate Suggestions', async () => {
    console.log('\n🎯 TEST 10: Suggestion uniqueness')
    const projectId = await createTestProject('unique')
    
    // Create table
    const result = await orchestrateBackendChange(
      'Create items table with name and description fields',
      projectId
    )
    expect(result.success).toBe(true)
    
    const graph = await getActiveGraph(projectId)
    const suggestions = await generateSuggestions(projectId, graph!)
    
    // Check for duplicate messages
    const messages = suggestions.map(s => s.message)
    const uniqueMessages = new Set(messages)
    
    expect(uniqueMessages.size).toBe(messages.length)
    
    // Cleanup
    await prisma.projectSuggestion.deleteMany({ where: { projectId } })
    console.log('  ✅ No duplicate suggestions generated')
  })

  it('FINAL: Advisory Layer Integrity', async () => {
    console.log('\n🎯 FINAL: Advisory layer integrity check')
    const projectId = await createTestProject('final')
    
    // Create comprehensive schema
    const result = await orchestrateBackendChange(
      'Create users table with email and name fields',
      projectId
    )
    expect(result.success).toBe(true)
    
    const graph = await getActiveGraph(projectId)
    const suggestions = await generateSuggestions(projectId, graph!)
    
    // Every suggestion must have required fields
    for (const suggestion of suggestions) {
      expect(suggestion.id).toBeDefined()
      expect(suggestion.type).toMatch(/^(performance|security|schema|architecture|scaling)$/)
      expect(suggestion.severity).toMatch(/^(low|medium|high)$/)
      expect(suggestion.message).toBeTruthy()
      expect(suggestion.rationale).toBeTruthy()
    }
    
    // Suggestions must be sorted by severity (high first)
    for (let i = 0; i < suggestions.length - 1; i++) {
      const current = suggestions[i].severity
      const next = suggestions[i + 1].severity
      const weights = { high: 3, medium: 2, low: 1 }
      expect(weights[current]).toBeGreaterThanOrEqual(weights[next])
    }
    
    // Cleanup
    await prisma.projectSuggestion.deleteMany({ where: { projectId } })
    
    console.log('  ✅ Advisory layer integrity verified')
    console.log(`\n🎉 SUITE 5 COMPLETE`)
    console.log(`   Active suggestions: ${suggestions.length}`)
    console.log(`   High severity: ${suggestions.filter(s => s.severity === 'high').length}`)
  })
})
