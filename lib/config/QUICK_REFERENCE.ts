/**
 * QUICK REFERENCE CARD
 * ====================
 * 
 * Feature Rejection Framework
 * Print this. Keep it visible during development.
 *
 * This file is the reference itself — the rules below are the source of truth,
 * not a summary of one kept elsewhere.
 */

// ============================================================================
// THE GOLDEN RULE (Memorize This)
// ============================================================================

export const GOLDEN_RULE = `
  Only Database Management can create backend reality.
  All other sections manage existing reality.
` as const

// ============================================================================
// 3-QUESTION DECISION FRAMEWORK
// ============================================================================

export const DECISION_FRAMEWORK = {
  question1: {
    text: 'Does this create backend reality (APIs, tables, resources)?',
    yesAction: 'MUST be in Database Management with confirmation modal',
    noAction: 'Go to Question 2',
  },
  question2: {
    text: 'Does this manage existing reality (edit, configure, control)?',
    yesAction: 'Goes in appropriate management section',
    noAction: 'Go to Question 3',
  },
  question3: {
    text: 'Is this a bridge/connector (SDKs, integrations, docs)?',
    yesAction: 'Goes in Connect App or SDK generation',
    noAction: 'REJECT - Does not fit architecture',
  },
} as const

// ============================================================================
// INSTANT REJECTION LIST (Never Allow These)
// ============================================================================

export const FOREVER_BANNED = [
  'Quick create buttons outside Database',
  'AI generate API outside Database',
  'Preview/Draft API modes',
  'Workspace file execution',
  'Any bypass of confirmation modal',
  'Fake or simulated resources',
  'Magic auto-creation without user action',
] as const

// ============================================================================
// EXAMPLES (Pattern Recognition)
// ============================================================================

export const EXAMPLES = {
  rejected: [
    {
      request: 'Add "Create API" button in API Builder',
      reason: 'Violates Golden Rule (only Database creates)',
      answer: 'REJECTED',
    },
    {
      request: 'Add preview mode for APIs',
      reason: 'Violates "real only" principle',
      answer: 'REJECTED',
    },
    {
      request: 'Auto-generate tables without confirmation',
      reason: 'Bypasses required confirmation modal',
      answer: 'REJECTED',
    },
  ],
  approved: [
    {
      request: 'Add rate limit editor in API Builder',
      reason: 'Manages existing APIs (not creating)',
      answer: 'APPROVED',
    },
    {
      request: 'Show API call history in Monitoring',
      reason: 'Read-only display, no creation',
      answer: 'APPROVED',
    },
    {
      request: 'Add Swagger documentation export in Connect App',
      reason: 'Bridge/connector feature',
      answer: 'APPROVED',
    },
  ],
} as const

// ============================================================================
// SECTION CAPABILITIES (Quick Lookup)
// ============================================================================

export const SECTION_CAPABILITIES = {
  DATABASE: {
    canCreate: true,
    canManage: true,
    requiresConfirmation: true,
    purpose: 'Convert intent into reality',
  },
  API_BUILDER: {
    canCreate: false,
    canManage: true,
    requiresConfirmation: false,
    purpose: 'Manage real APIs',
  },
  FILE_STORAGE: {
    canCreate: false,
    canManage: true,
    requiresConfirmation: false,
    purpose: 'Store real files',
  },
  CONNECT_APP: {
    canCreate: false,
    canManage: false,
    requiresConfirmation: false,
    purpose: 'Bridge/connector only',
  },
  DEPLOY: {
    canCreate: false,
    canManage: true,
    requiresConfirmation: true,
    purpose: 'Publish existing backend',
  },
  AUTHENTICATION: {
    canCreate: false,
    canManage: true,
    requiresConfirmation: false,
    purpose: 'Protect existing resources',
  },
  API_KEYS: {
    canCreate: false,
    canManage: true,
    requiresConfirmation: false,
    purpose: 'Grant controlled access',
  },
  MONITORING: {
    canCreate: false,
    canManage: false,
    requiresConfirmation: false,
    purpose: 'Display-only observation',
  },
} as const

// ============================================================================
// CODE REVIEW CHECKLIST
// ============================================================================

export const CODE_REVIEW_CHECKLIST = `
Before approving ANY PR:

[ ] Does it create APIs/tables?
    → If YES: Must be in Database Management
    → If YES: Must have confirmation modal

[ ] Does it add "quick create" anywhere?
    → If YES: REJECT immediately

[ ] Does it show fake/preview data?
    → If YES: REJECT immediately

[ ] Does it bypass user confirmation?
    → If YES: REJECT immediately

[ ] Run validation script:
    → npx tsx scripts/validate-section-boundaries.ts
    → Must pass (exit code 0)

[ ] Check section file headers:
    → Every section must have boundary comment

[ ] Does it fit the 3-question framework?
    → Use DECISION_FRAMEWORK above
` as const

// ============================================================================
// VIOLATION RESPONSE TEMPLATE
// ============================================================================

export const VIOLATION_RESPONSE_TEMPLATE = (
  feature: string,
  reason: string,
  alternative?: string
) => `
❌ REJECTED: This violates the Golden Rule.

**Feature:** ${feature}

**Reason:** ${reason}

${alternative ? `**Alternative:** ${alternative}` : '**No alternative available** - feature does not fit architecture'}

**Decision Framework Used:**
1. Does this create backend reality? [YES/NO]
2. Does this manage existing reality? [YES/NO]
3. Is this a bridge/connector? [YES/NO]

**Conclusion:** Does not pass framework requirements.
`

// ============================================================================
// ONBOARDING FLOW (Non-Negotiable Sequence)
// ============================================================================

export const ONBOARDING_FLOW = [
  '1. Describe idea (natural language)',
  '2. See planned tables (metadata visible)',
  '3. Explicit confirmation ("Make Tables Real" button)',
  '4. APIs appear (auto-created from plans)',
  '5. Test APIs (API Builder)',
  '6. Deploy (Deploy section)',
] as const

export const ONBOARDING_RULES = {
  noSkipSteps: true,
  noAdvancedMode: true,
  noShortcuts: true,
  confirmationMandatory: true,
  reason: 'Enforces mental model and prevents confusion',
} as const

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

export function evaluateFeature(
  feature: string,
  createsReality: boolean,
  managesExisting: boolean,
  isBridge: boolean
): { approved: boolean; reason: string; section?: string } {
  if (createsReality) {
    return {
      approved: false,
      reason: 'Creates backend reality - must be in Database Management with confirmation',
      section: 'DATABASE',
    }
  }

  if (managesExisting) {
    return {
      approved: true,
      reason: 'Manages existing reality - goes in appropriate management section',
    }
  }

  if (isBridge) {
    return {
      approved: true,
      reason: 'Bridge/connector feature - goes in Connect App',
      section: 'CONNECT_APP',
    }
  }

  return {
    approved: false,
    reason: 'Does not fit architecture - reject',
  }
}

export function isForeverBanned(featureDescription: string): boolean {
  const lowerDesc = featureDescription.toLowerCase()

  const bannedPatterns = [
    /quick create/i,
    /create api.*(?!database)/i,
    /generate api.*(?!database)/i,
    /preview.*mode/i,
    /draft.*api/i,
    /test.*mode.*fake/i,
    /workspace.*execution/i,
    /bypass.*confirmation/i,
    /auto.*create.*without/i,
  ]

  return bannedPatterns.some((pattern) => pattern.test(lowerDesc))
}

// ============================================================================
// EXPORT SUMMARY
// ============================================================================

export const QUICK_REFERENCE_SUMMARY = {
  goldenRule: GOLDEN_RULE,
  decisionFramework: DECISION_FRAMEWORK,
  foreverBanned: FOREVER_BANNED,
  examples: EXAMPLES,
  sectionCapabilities: SECTION_CAPABILITIES,
  codeReviewChecklist: CODE_REVIEW_CHECKLIST,
  onboardingFlow: ONBOARDING_FLOW,
  onboardingRules: ONBOARDING_RULES,
  helpers: {
    evaluateFeature,
    isForeverBanned,
    generateViolationResponse: VIOLATION_RESPONSE_TEMPLATE,
  },
} as const

export default QUICK_REFERENCE_SUMMARY
