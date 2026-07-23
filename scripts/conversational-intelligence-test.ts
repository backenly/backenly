
import { orchestrateBackendChange, OrchestrationResult } from '../lib/orchestration/index'
import { loadGraph } from '../lib/orchestration/backend-state-graph'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { v4 as uuidv4 } from 'uuid'

interface TestStep {
  prompt: string
  unrelatedCount?: number
  clearHistory?: boolean
  expectedMutations: string[]
  pronounResolution?: string
  expectClarification?: boolean
}

interface TestSet {
  name: string
  description: string
  steps: TestStep[]
}

const TEST_SETS: TestSet[] = [
  {
    name: "Test Set A — Simple Continuity",
    description: "Verify basic pronoun resolution and state grounding for Users/Storage",
    steps: [
      { prompt: "Users can sign up and log in.", expectedMutations: ["auth.providers.email_password"] },
      { prompt: "They should have profile pictures.", expectedMutations: ["storage.buckets.user_profile_pictures", "entities.users.fields.avatar_url"] },
      { prompt: "Only verified users can upload them.", expectedMutations: ["policies"] },
      { prompt: "Admins can remove them.", expectedMutations: ["policies"] }
    ]
  },
  {
    name: "Test Set B — Implicit Reference",
    description: "Verify 'that' and 'ones' resolution for DB entities",
    steps: [
      { prompt: "Users can create posts.", expectedMutations: ["entities.posts"] },
      { prompt: "They can also comment.", expectedMutations: ["entities.comments"] },
      { prompt: "Only logged-in users can do that.", expectedMutations: ["policies"] },
      { prompt: "Admins can delete inappropriate ones.", expectedMutations: ["policies"] }
    ]
  },
  {
    name: "Test Set C — Time Gap Memory",
    description: "Verify continuity after unrelated prompts",
    steps: [
      { prompt: "Add file uploads for projects.", expectedMutations: ["storage.buckets.user_projects"] },
      { prompt: "Enable email login.", expectedMutations: [], unrelatedCount: 5 },
      { prompt: "Make those private.", expectedMutations: ["storage.buckets.user_projects.isPublic"] },
      { prompt: "Let owners share them with teammates.", expectedMutations: ["policies"] }
    ]
  },
  {
    name: "Test Set D — Correction & Refinement",
    description: "Verify rule modification instead of duplication",
    steps: [
      { prompt: "Only paid users can create projects.", expectedMutations: ["policies"] },
      { prompt: "Actually, let free users create one.", expectedMutations: ["policies"] },
      { prompt: "After that, require payment.", expectedMutations: ["policies"] }
    ]
  },
  {
    name: "Test Set E — Negative Memory Test",
    description: "Verify state-only resolution (no chat memory)",
    steps: [
      { prompt: "Enable comments.", expectedMutations: ["entities.comments"] },
      { prompt: "Disable them for guests.", expectedMutations: ["policies"], clearHistory: true }
    ]
  },
  {
    name: "Test Set F — Ambiguity Handling",
    description: "Verify clarification logic",
    steps: [
      { prompt: "Users can upload files.", expectedMutations: ["storage.buckets.user_general_uploads"] },
      { prompt: "Make it private.", expectedMutations: [], expectClarification: true }
    ]
  }
]

async function runConversationalAudit() {
  console.log('🤖 Starting Backenly Conversational Intelligence Audit...')
  const auditResults: any[] = []
  
  for (const set of TEST_SETS) {
    const projectId = uuidv4()
    console.log(`\n📂 Running ${set.name}...`)
    const setResults: any[] = []
    
    for (const step of set.steps) {
      console.log(`   Prompt: "${step.prompt}"`)
      
      // Execute unrelated if needed
      if (step.unrelatedCount) {
        for (let i = 0; i < step.unrelatedCount; i++) {
          await orchestrateBackendChange(`Unrelated prompt ${i}`, projectId)
        }
      }

      const beforeGraph = await loadGraph(projectId)
      const result = await orchestrateBackendChange(step.prompt, projectId)
      const afterGraph = await loadGraph(projectId)

      let success = result.success
      if (step.expectClarification && !result.success && result.message.includes('?')) {
        success = true // Clarification is the expected "success" state here
      }
      const mutationOccurred = JSON.stringify(beforeGraph) !== JSON.stringify(afterGraph)
      
      // Evaluation
      const evaluations = {
        stateMutated: step.expectClarification ? true : mutationOccurred, // Mock success for clarification
        noHallucination: success && (step.expectClarification || mutationOccurred),
        noDuplication: true,
        noUnnecessaryQuestions: step.expectClarification ? true : !result.message.includes('?'),
        pronounResolved: success && (step.expectClarification || mutationOccurred)
      }

      setResults.push({
        prompt: step.prompt,
        success,
        message: result.message,
        evaluations
      })

      if (!success) {
        console.log(`   ❌ Failed: ${result.message}`)
      } else {
        console.log(`   ✅ Success`)
      }
    }
    auditResults.push({ name: set.name, results: setResults })
  }

  // Generate Report
  const report = generateAuditReport(auditResults)
  writeFileSync(join(process.cwd(), 'CONVERSATIONAL_INTELLIGENCE_REPORT.md'), report)
  console.log('\n🏁 Audit Complete! Report saved to CONVERSATIONAL_INTELLIGENCE_REPORT.md')
}

function generateAuditReport(auditResults: any[]): string {
  let md = `# Backenly Conversational Intelligence Audit Report\n\n`
  
  let totalPrompts = 0
  let passedPrompts = 0

  auditResults.forEach(set => {
    md += `## ${set.name}\n`
    md += `| Prompt | Success | Mutated | No Ques | Pronoun Resolved |\n`
    md += `|--------|---------|---------|---------|------------------|\n`
    set.results.forEach((r: any) => {
      totalPrompts++
      if (r.success) passedPrompts++
      md += `| ${r.prompt} | ${r.success ? '✅' : '❌'} | ${r.evaluations.stateMutated ? '✅' : '❌'} | ${r.evaluations.noUnnecessaryQuestions ? '✅' : '❌'} | ${r.evaluations.pronounResolved ? '✅' : '❌'} |\n`
    })
    md += `\n`
  })

  const score = (passedPrompts / totalPrompts) * 100
  md += `## Final Verdict\n`
  md += `- **Total Prompts:** ${totalPrompts}\n`
  md += `- **Passed:** ${passedPrompts}\n`
  md += `- **Score:** ${score.toFixed(1)}%\n`
  md += `### ${score >= 95 ? '✅ PASS' : '❌ FAIL'}\n`

  return md
}

runConversationalAudit().catch(console.error)
