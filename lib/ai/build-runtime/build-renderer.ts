/**
 * BUILD RENDERER
 * ==============
 * Renders BuildJob state as a structured response.
 *
 * CRITICAL RULE: All output is derived from BuildJob/BuildGraph state.
 * No freeform LLM summaries. No "typically", "usually", "you may want".
 * No "let me know if you need anything".
 *
 * The renderer produces a strict contract:
 *   - built: what was executed and verified
 *   - verified: what passed explicit verification checks
 *   - partial: what is partially done
 *   - blocked: what is blocked and exactly why
 *   - failed: what failed and why
 *   - remaining: what hasn't started yet
 *   - next_step: the one thing the user should do next
 *
 * Build mode is execution-first. The response proves what was done.
 */

import type { BuildJob, BuildResponse, BuildJobStatus, BuildNode, PostBuildValidationReport } from './types'
import type { BuildGraph } from './build-graph'
import type { PlanResponse, Domain } from './types'
import { buildStatusLabel } from './status-labels'

// ── Contextual Label Derivation ───────────────────────────────────────────────

/**
 * Derive a human-readable backend label from the user's original prompt.
 * Used for 'generic' domain builds where the static map would produce the
 * unhelpful "Backend" label. Priority order: explicit app-type keywords first,
 * then noun extraction, then fallback to "Backend".
 */
function deriveContextualLabel(prompt: string): string {
  const lower = prompt.toLowerCase()

  const KEYWORD_LABELS: Array<[RegExp, string]> = [
    [/\b3d\b.*\bvideo\b|\bvideo\b.*\b3d\b/,                    '3D Video Backend'],
    [/\bvideo\b.{0,30}\b(generation|render|ai|platform)\b/,     'Video Generation Backend'],
    [/\bvideo\b/,                                                 'Video Backend'],
    [/\b(photo|image).{0,20}\b(edit|generat|ai|platform)\b/,    'Image Backend'],
    [/\b(ai|ml|machine.?learning).{0,30}\b(platform|service)\b/, 'AI Platform Backend'],
    [/\baudio\b.{0,20}\b(stream|generat|podcast)\b/,            'Audio Backend'],
    [/\b(booking|appointment|reserv)/,                           'Booking Backend'],
    [/\b(food|restaurant|delivery|meal)/,                        'Food Delivery Backend'],
    [/\b(blog|cms|content.?management)/,                         'Content Backend'],
    [/\b(social|feed|follow|post)/,                              'Social Backend'],
    [/\b(health|medical|clinical|patient)/,                      'Health Backend'],
    [/\b(education|course|learning|student|lms)/,                'Education Backend'],
    [/\b(real.?estate|property|listing.{0,10}apartment)/,        'Real Estate Backend'],
    [/\b(crypto|nft|blockchain|defi)/,                           'Web3 Backend'],
    [/\b(analytics|dashboard|reporting|metric)/,                 'Analytics Backend'],
    [/\b(logistics|shipping|freight|supply.?chain)/,             'Logistics Backend'],
    [/\b(hr|payroll|employee|hiring|recruit)/,                   'HR Backend'],
    [/\b(finance|fintech|banking|payment|invoice)/,              'Fintech Backend'],
    [/\b(gaming|game|leaderboard|score)/,                        'Gaming Backend'],
    [/\b(iot|device|sensor|telemetry)/,                          'IoT Backend'],
    [/\b(chat|messaging|communication)/,                         'Messaging Backend'],
    [/\b(event|ticket|concert|venue)/,                           'Events Backend'],
    [/\b(travel|hotel|flight|tour)/,                             'Travel Backend'],
    [/\b(news|media|article|publisher)/,                         'Media Backend'],
    [/\b(fitness|workout|gym|exercise)/,                         'Fitness Backend'],
  ]

  for (const [pattern, label] of KEYWORD_LABELS) {
    if (pattern.test(lower)) return label
  }

  // Fallback: extract the first meaningful noun phrase from the prompt
  const words = prompt
    .replace(/build|create|make|set up|generate|spin up|a|an|the|me|us|backend|platform|app|application|api|service|system/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 3)
    .join(' ')

  return words.length > 2 ? `${words} Backend` : 'Backend'
}

// ── Build Response Renderer ───────────────────────────────────────────────────

/**
 * Render a complete BuildResponse from the current BuildJob + graph state.
 * This is the only function that should produce Build mode chat responses.
 */
export function renderBuildResponse(
  job: BuildJob,
  graph: BuildGraph,
  validationReport?: PostBuildValidationReport,
): BuildResponse {
  const all = graph.getAllNodes()

  const builtNodes = all.filter(n =>
    (n.status === 'verified') && n.type !== 'verification'
  )
  const partialNodes = all.filter(n => n.status === 'partial')
  const blockedNodes = all.filter(n => n.status === 'blocked')
  const failedNodes = all.filter(n => n.status === 'failed')
  const remainingNodes = all.filter(n => n.status === 'pending' && n.type !== 'verification')

  const verifiedNodes = all.filter(n => n.type === 'verification' && n.status === 'verified')

  const jobStatus = graph.computeJobStatus()

  const response: BuildResponse = {
    mode: 'build',
    built: builtNodes.map(n => ({
      id: n.id,
      label: n.label,
      detail: n.executionDetail,
    })),
    verified: verifiedNodes.map(n => n.label),
    partial: partialNodes.map(n => ({
      id: n.id,
      label: n.label,
      detail: n.executionDetail ?? n.failureReason,
    })),
    blocked: blockedNodes.map(n => ({
      id: n.id,
      label: n.label,
      reason: n.blockedReason?.description ?? 'Manual step required',
      requiredAction: n.blockedReason?.userAction,
      integrationId: n.blockedReason?.resumeOnIntegration,
      envVar: n.blockedReason?.requiredEnvVar,
    })),
    failed: failedNodes.map(n => ({
      id: n.id,
      label: n.label,
      reason: n.failureReason ?? 'Unknown error',
    })),
    remaining: remainingNodes.map(n => n.label),
    next_step: computeNextStep(job, graph, blockedNodes, remainingNodes, jobStatus),
    jobStatus,
    validationReport,
    markdown: '',
  }

  response.markdown = renderMarkdown(response, job)
  response.reasoning = buildReasoning(response, job)
  return response
}

// ── Integration Context ───────────────────────────────────────────────────────

/**
 * Returns a contextual heading + body for a credential request, explaining
 * WHAT was just built and WHY this specific credential is needed right now.
 * Exported so block-resume.ts can use it for post-resume messages.
 */
export function getIntegrationContext(
  integrationId: string,
  builtCount: number,
  originalPrompt: string = '',
): { heading: string; body: string } {
  const id = (integrationId ?? '').toLowerCase().replace(/[^a-z]/g, '')
  const prompt = originalPrompt.toLowerCase()

  const CONTEXTS: Record<string, { heading: string; body: string }> = {
    google: {
      heading: 'Connecting Google Sign-In',
      body: `Auth infrastructure is ready (${builtCount} components built). To activate Google OAuth so your users can sign in with their Google account, I need your OAuth 2.0 credentials from the Google Cloud Console.`,
    },
    payment_provider: {
      heading: 'Payment Flow Planned — Provider Not Selected',
      body: `Payment tables are ready and order tracking is wired up. To activate checkout, choose your payment processor:\n\n→ Type **"Connect Stripe"** for Stripe (most common)\n→ Type **"Connect PayPal"** for PayPal\n→ Type **"Connect Paddle"** for Paddle (SaaS billing)`,
    },
    stripe: {
      heading: 'Connecting Stripe Payments',
      body: `Payment tables, checkout flow, and webhook handler are all scaffolded. To process real transactions, handle subscription billing, and receive Stripe webhook events (charges, refunds, subscription updates), I need your Stripe secret key.`,
    },
    openai: {
      heading: 'Connecting OpenAI',
      body: prompt.includes('video') || prompt.includes('generat')
        ? `Your AI function layer is wired up — prompt enhancement, generation job analysis, output scoring, and content moderation are all ready. To activate these functions, I need your OpenAI API key.`
        : `Your AI function layer is scaffolded. To activate serverless AI functions (completions, embeddings, analysis), I need your OpenAI API key.`,
    },
    resend: {
      heading: 'Connecting Email (Resend)',
      body: `Email templates are configured: welcome email on signup, payment receipts, job completion notifications, and credit alert emails. To actually deliver these emails, I need your Resend API key.`,
    },
    sendgrid: {
      heading: 'Connecting Email (SendGrid)',
      body: `Transactional email templates are ready (welcome flows, receipts, alerts). To send these emails, I need your SendGrid API key.`,
    },
    anthropic: {
      heading: 'Connecting Anthropic (Claude)',
      body: `Your AI function layer is ready. To activate Claude-powered functions, I need your Anthropic API key.`,
    },
    posthog: {
      heading: 'Connecting PostHog Analytics',
      body: `Event tracking is scaffolded. To stream usage analytics to PostHog, I need your PostHog project API key.`,
    },
    replicate: {
      heading: 'Connecting Replicate',
      body: `Your video/image generation pipeline is scaffolded. To run models on Replicate (Kling, Stable Video, etc.), I need your Replicate API token.`,
    },
  }

  // Partial key matches for provider variants
  for (const [key, ctx] of Object.entries(CONTEXTS)) {
    if (id.includes(key) || key.includes(id)) return ctx
  }

  return {
    heading: `Connecting ${integrationId.charAt(0).toUpperCase() + integrationId.slice(1)}`,
    body: `This integration's infrastructure is ready. Paste your API key to activate it.`,
  }
}

// ── Markdown Renderer ─────────────────────────────────────────────────────────

/**
 * No-op message when the build runtime produced zero actionable output.
 * Never return an empty/misleading "Build complete." in this case.
 */
function renderNoOpMessage(response: BuildResponse, job: BuildJob): string {
  const executableNodes = job.phases
    .flatMap(p => p.nodes)
    .filter(n => n.type !== 'verification')

  if (executableNodes.length === 0) {
    // Compiler produced 0 nodes — couldn't parse the request into a build plan.
    const nouns = job.originalPrompt
      .replace(/\b(add|build|create|and|with|support|for|the|a|an|to|of|or|please|can you|me|my|i want|i need)\b/gi, ' ')
      .trim()
      .split(/\s+/)
      .map(w => w.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase())
      .filter(w => w.length > 2 && /^[a-z]/.test(w))
      .slice(0, 4)

    if (nouns.length > 0) {
      return [
        `I couldn't determine what to add for: **${nouns.join(', ')}**.`,
        ``,
        `Do you want me to create these as new database tables? Describe what columns they need — for example:`,
        `"Add a carts table with user_id and product_id columns, and a wishlists table with user_id and product_id."`,
      ].join('\n')
    }
    return [
      `I couldn't determine what to add.`,
      ``,
      `Try describing what you want more specifically — for example: "Add a carts table with user_id and product_id columns".`,
    ].join('\n')
  }

  // Nodes were compiled but execution produced zero output.
  // Most likely: all requested tables already exist in the schema (idempotent CREATE).
  const schemaNames = executableNodes
    .filter(n => n.type === 'schema')
    .map(n => n.id.replace(/^schema\./, ''))

  if (schemaNames.length > 0) {
    const display = schemaNames.slice(0, 3).join(', ') +
      (schemaNames.length > 3 ? ` (+${schemaNames.length - 3} more)` : '')
    return `Nothing changed — **${display}** already exist${schemaNames.length === 1 ? 's' : ''} in your schema.`
  }

  return [
    `I attempted this but no changes were made.`,
    ``,
    `Try describing what you need more specifically — for example: "Add a carts table with user_id and product_id columns".`,
  ].join('\n')
}

function renderMarkdown(response: BuildResponse, job: BuildJob): string {
  // ── No-op guard ─────────────────────────────────────────────────────────────
  // Never produce an empty/misleading response when the build had zero output.
  // This fires when: 0 built, 0 blocked, 0 partial, 0 failed, 0 remaining.
  const hasAnyOutput =
    response.built.length > 0 ||
    response.blocked.length > 0 ||
    response.partial.length > 0 ||
    response.failed.length > 0 ||
    response.remaining.length > 0

  if (!hasAnyOutput) {
    return renderNoOpMessage(response, job)
  }

  const lines: string[] = []

  const domainLabel: Record<string, string> = {
    ecommerce:   'Ecommerce Backend',
    saas:        'SaaS Backend',
    marketplace: 'Marketplace Backend',
    social:      'Social Platform Backend',
    'ai-saas':   'AI SaaS Backend',
    fintech:     'Fintech Backend',
    media:       'Media Platform Backend',
    messaging:   'Messaging Backend',
    gaming:      'Gaming Backend',
    generic:     'Backend',
  }

  // Header — always derive contextually from the original prompt.
  const staticLabel = domainLabel[job.domain] ?? 'Backend'
  const contextualLabel = deriveContextualLabel(job.originalPrompt)
  const domainHeader = contextualLabel !== 'Backend' ? contextualLabel : staticLabel
  const onlyCredentialBlocked =
    response.remaining.length === 0 &&
    response.failed.length === 0 &&
    response.partial.length === 0 &&
    response.blocked.length > 0

  // Step 5: A single-table or minimal build must NOT claim "Prototype Ready".
  // "Prototype Ready" requires at minimum: schema + auth + API layer all verified.
  // Without that depth, the header reads "Created" so the user knows this is
  // a partial result, not a fully-functional backend.
  const schemaBuiltCount = response.built.filter(n => n.id.startsWith('schema.')).length
  const hasBuiltAuth = response.built.some(n => n.id.startsWith('auth.'))
  const hasBuiltApis = response.built.some(n => n.id.startsWith('flow.'))
  const isMinimalBuild =
    response.jobStatus === 'verified' &&
    !(schemaBuiltCount >= 2 && hasBuiltAuth && hasBuiltApis)

  const headerStatus = onlyCredentialBlocked
    ? 'Workflow Incomplete — credentials needed'
    : isMinimalBuild
      ? 'Created'
      : statusLabel(response.jobStatus)
  lines.push(`**${domainHeader} — ${headerStatus}**`)
  lines.push('')

  // ── Proof summary — concise status snapshot before the detailed sections ─
  {
    const summaryParts: string[] = []
    if (response.built.length > 0) summaryParts.push(`Built: ${response.built.length} component${response.built.length !== 1 ? 's' : ''}`)
    if (response.verified.length > 0) summaryParts.push(`Verified: ${response.verified.length} check${response.verified.length !== 1 ? 's' : ''} passed`)
    if (response.blocked.length > 0) {
      const names = [...new Set(response.blocked.map(b => b.integrationId ?? b.label))].slice(0, 2).join(', ')
      summaryParts.push(`Blocked: ${names} — credentials missing`)
    }
    if (response.failed.length > 0) summaryParts.push(`Failed: ${response.failed.length} component${response.failed.length !== 1 ? 's' : ''}`)
    if (response.remaining.length > 0) summaryParts.push(`Remaining: ${response.remaining.length} pending`)
    if (summaryParts.length > 0) {
      lines.push(`*${summaryParts.join(' · ')}*`)
      lines.push('')
    }
  }

  // ── Conversational intro — explains what was done, like a developer agent ─
  const schemaCount = response.built.filter(n => n.id.startsWith('schema.')).length
  const flowCount = response.built.filter(n => n.id.startsWith('flow.')).length
  const hasAuth = response.built.some(n => n.id.startsWith('auth.'))
  const storageCount = response.built.filter(n => n.id.startsWith('storage.')).length
  const functionCount = response.built.filter(n => n.id.startsWith('function.')).length
  const blockedCount = response.blocked.length
  const failedCount = response.failed.length

  if (response.jobStatus === 'verified' || response.jobStatus === 'partial' || onlyCredentialBlocked) {
    const parts: string[] = []
    if (schemaCount > 0) parts.push(`${schemaCount} database table${schemaCount > 1 ? 's' : ''}`)
    if (flowCount > 0) parts.push(`${flowCount} API group${flowCount > 1 ? 's' : ''}`)
    if (hasAuth) parts.push('authentication')
    if (storageCount > 0) parts.push(`${storageCount} storage bucket${storageCount > 1 ? 's' : ''}`)
    if (functionCount > 0) parts.push(`${functionCount} AI function${functionCount > 1 ? 's' : ''}`)

    if (parts.length > 0) {
      lines.push(`I built your ${domainHeader}: ${parts.join(', ')}.`)
    }
    if (blockedCount > 0) {
      const credentialNames = [...new Set(response.blocked.map(b => b.integrationId ?? b.label))]
      lines.push(`${blockedCount} integration${blockedCount > 1 ? 's' : ''} (${credentialNames.slice(0, 3).join(', ')}) need credentials to activate.`)
    }
    if (failedCount > 0) {
      lines.push(`${failedCount} component${failedCount > 1 ? 's' : ''} encountered errors — details below.`)
    }
    lines.push('')
  } else if (response.jobStatus === 'failed') {
    lines.push(`I ran into issues building parts of your ${domainHeader}. Here is what happened:`)
    lines.push('')
  }

  // Built section
  if (response.built.length > 0) {
    lines.push('**Built:**')
    for (const item of response.built) {
      const detail = item.detail ? ` — ${item.detail}` : ''
      lines.push(`- ${item.label}${detail}`)
    }
    lines.push('')
  }

  // Verified section
  if (response.verified.length > 0) {
    lines.push('**Verified:**')
    for (const v of response.verified) {
      lines.push(`- ${v}`)
    }
    lines.push('')
  }

  // Partial section
  if (response.partial.length > 0) {
    lines.push('**Partial:**')
    for (const item of response.partial) {
      const detail = item.detail ? ` — ${item.detail}` : ''
      lines.push(`- ${item.label}${detail}`)
    }
    lines.push('')
  }

  // Blocked section — show ONE credential at a time with contextual explanation.
  // Showing all credentials together breaks the agent feel and is overwhelming.
  // Each credential is asked only when the infrastructure that needs it is ready.
  if (response.blocked.length > 0) {
    const [next, ...upcoming] = response.blocked
    const ctx = getIntegrationContext(next.integrationId ?? next.id, response.built.length, job.originalPrompt)
    lines.push(`**${ctx.heading}**`)
    lines.push('')
    lines.push(ctx.body)
    if (next.envVar) {
      lines.push(``)
      lines.push(`→ Paste your \`${next.envVar}\` here — build resumes automatically.`)
    }
    lines.push('')
    if (upcoming.length > 0) {
      lines.push(`*After this: ${upcoming.map(u => u.label).join(' → ')}*`)
      lines.push('')
    }
  }

  // Failed section — explain what failed and why so the user understands
  if (response.failed.length > 0) {
    lines.push('**Failed:**')
    for (const item of response.failed) {
      lines.push(`- **${item.label}**: ${item.reason}`)
    }
    lines.push('')
    lines.push('*I stopped on these errors. You can ask me to retry, or describe a different approach.*')
    lines.push('')
  }

  // Remaining section
  if (response.remaining.length > 0) {
    lines.push('**Remaining:**')
    for (const label of response.remaining) {
      lines.push(`- ${label}`)
    }
    lines.push('')
  }

  // ── Validation / Health Report — actionable, never hidden ────────────────
  if (response.validationReport) {
    lines.push('')
    lines.push(renderValidationReportMarkdown(response.validationReport))
  }

  // ── Credential summary — listed at the end so users know exactly what is missing ─
  // This runs even when there is no blocked section (e.g. validation found missing keys)
  if (response.blocked.length > 0) {
    const allBlocked = response.blocked
    const credentialLines: string[] = []
    for (const b of allBlocked) {
      const integId = b.integrationId ?? b.id ?? b.label
      const envVar = b.envVar ? ` (\`${b.envVar}\`)` : ''
      if (integId === 'payment_provider') {
        credentialLines.push(`- **Payment provider not selected** — payment flow is planned, choose Stripe / PayPal / Paddle to activate`)
      } else if (integId === 'stripe') {
        credentialLines.push(`- **Stripe${envVar}** is missing — payment processing and checkout are prepared but inactive`)
      } else if (integId === 'resend' || integId === 'sendgrid') {
        credentialLines.push(`- **Email${envVar}** is missing — email sending is prepared but inactive`)
      } else if (integId === 'openai') {
        credentialLines.push(`- **OpenAI${envVar}** is missing — AI-powered features are prepared but inactive`)
      } else if (integId === 'google' || integId === 'google_auth') {
        credentialLines.push(`- **Google OAuth${envVar}** is missing — Google sign-in is prepared but inactive`)
      } else if (integId === 'anthropic') {
        credentialLines.push(`- **Anthropic${envVar}** is missing — Claude-powered features are prepared but inactive`)
      } else if (integId === 'replicate') {
        credentialLines.push(`- **Replicate${envVar}** is missing — image/video generation is prepared but inactive`)
      } else {
        const label = b.label ?? integId
        credentialLines.push(`- **${label}${envVar}** needs credentials to activate`)
      }
    }
    if (credentialLines.length > 0) {
      lines.push('')
      lines.push('**Credential Summary:**')
      lines.push('The following integrations are structurally complete but need credentials:')
      lines.push(...credentialLines)
      lines.push('*Paste each credential above — the build resumes automatically for each one.*')
    }
  }

  // Next step — always unambiguous
  if (response.next_step) {
    lines.push('')
    lines.push(`**Next:** ${response.next_step}`)
  }

  // ── What happens after the build — set expectations about the safety layer ──
  // A real backend was built and verified. From now on the autonomous system
  // watches it continuously. New users are alarmed when the Review Queue shows
  // an item on a brand-new project ("did I break something?"), so state plainly
  // that findings there are the safety layer working, not a defect. Deterministic
  // (not LLM prose) and only on a genuine full-depth build, so it stays honest.
  if (response.jobStatus === 'verified' && !isMinimalBuild) {
    lines.push('')
    lines.push('---')
    lines.push(
      'From here on, Backenly keeps watching this backend. Safe hardening — indexes, ' +
      'foreign-key constraints, row-level security — it applies on its own. Anything ' +
      'risky or hard to reverse it holds in your **Review Queue** for a one-click approve, ' +
      'with a rollback snapshot captured first. Items appearing there are the safety layer ' +
      'doing its job — not a sign the backend is broken.',
    )
  }

  // ── Inspector navigation hints — context-aware deep links ─────────────────
  // Shown only when there are actionable issues to investigate
  const inspectorHints: string[] = []
  if (response.failed.length > 0) {
    const failedTypes = new Set(response.failed.map(n => n.id.split('.')[0]))
    if (failedTypes.has('schema') || failedTypes.has('schema')) inspectorHints.push('Open Inspector → Database')
    if (failedTypes.has('auth')) inspectorHints.push('Open Inspector → Auth')
    if (failedTypes.has('storage')) inspectorHints.push('Open Inspector → Storage')
    if (failedTypes.has('flow')) inspectorHints.push('Open Inspector → API Builder')
  }
  if (response.blocked.length > 0 && response.failed.length === 0) {
    const firstBlocked = response.blocked[0]
    const integId = (firstBlocked.integrationId ?? '').toLowerCase()
    if (integId.includes('stripe') || integId.includes('payment')) inspectorHints.push('Open Inspector → Settings (Integrations)')
    else if (integId.includes('google') || integId.includes('auth')) inspectorHints.push('Open Inspector → Auth')
    else if (integId.includes('storage') || integId.includes('s3')) inspectorHints.push('Open Inspector → Storage')
    else inspectorHints.push('Open Inspector → Settings')
  }
  if (inspectorHints.length > 0) {
    lines.push('')
    lines.push(`*${inspectorHints.join(' · ')}*`)
  }

  return lines.join('\n').trim()
}

// ── Execution Reasoning ───────────────────────────────────────────────────────

function buildReasoning(
  response: BuildResponse,
  job: BuildJob,
): BuildResponse['reasoning'] {
  const builtTypes = [...new Set(response.built.map(n => n.id.split('.')[0]))]

  // Decision summary — what the AI chose and why
  const parts: string[] = []
  if (builtTypes.includes('schema')) parts.push('database schema')
  if (builtTypes.includes('auth')) parts.push('authentication')
  if (builtTypes.includes('flow')) parts.push('REST APIs')
  if (builtTypes.includes('storage')) parts.push('file storage')
  if (builtTypes.includes('function')) parts.push('AI functions')
  if (builtTypes.includes('permissions')) parts.push('row-level security')
  if (builtTypes.includes('integration')) parts.push('integrations')
  if (builtTypes.includes('realtime')) parts.push('realtime subscriptions')

  const decision = parts.length > 0
    ? `Built ${parts.join(', ')} for a ${job.domain} backend based on your goal.`
    : `Processed your request for a ${job.domain} backend.`

  const changed = response.built.map(n => n.detail ?? n.label).filter(Boolean)

  const repaired: string[] = []
  for (const n of response.built) {
    if (n.detail?.toLowerCase().includes('repaired') || n.detail?.toLowerCase().includes('fixed')) {
      repaired.push(n.label)
    }
  }

  const blockedReasons = response.blocked.map(b =>
    b.reason ?? `${b.label} needs credentials to activate`
  )

  return { decision, changed, repaired, blockedReasons }
}

/**
 * Render the post-build validation report as a markdown section.
 * Shows what was tested, what passed, what failed, what needs attention.
 * Each issue includes the exact table/field affected and a concrete fix suggestion.
 */
function renderValidationReportMarkdown(report: PostBuildValidationReport): string {
  const lines: string[] = []
  const overallIcon = report.passed ? '✓' : '⚠'
  lines.push(`**Backend Health — ${overallIcon} ${report.passed ? 'All checks passed' : 'Issues found'}**`)
  lines.push('')

  // ── Behavioral scenarios ───────────────────────────────────────────────────
  const b = report.behavioral
  const bIcon = b.passed ? '✓' : '✗'
  lines.push(`**${bIcon} Behavioral Testing** — ${b.passedScenarios}/${b.totalScenarios} scenarios passed`)
  if (b.failures.length > 0) {
    for (const f of b.failures) {
      lines.push(`  - Issue: ${f}`)
      lines.push(`    → Ask me to fix this: "Fix the failing ${f.split(':')[0]?.toLowerCase() ?? 'test'} scenario"`)
    }
  } else {
    lines.push(`  - Auth signup/login, cross-user data isolation, and access control all passed`)
  }
  lines.push('')

  // ── Security audit ─────────────────────────────────────────────────────────
  const s = report.security
  const sIcon = s.passed ? '✓' : '⚠'
  const scoreLabel = s.score >= 80 ? 'Good' : s.score >= 50 ? 'Fair' : 'Needs Attention'
  lines.push(`**${sIcon} Security Audit** — Score: ${s.score}/100 (${scoreLabel})`)

  if (s.criticalCount > 0 || s.highCount > 0) {
    if (s.criticalCount > 0) lines.push(`  - ${s.criticalCount} critical issue${s.criticalCount > 1 ? 's' : ''} found — must fix before going live`)
    for (const f of s.topFindings.filter(f => f.severity === 'critical' || f.severity === 'high')) {
      lines.push(`  - **[${f.severity.toUpperCase()}]** ${f.category} at \`${f.location}\`: ${f.description}`)
      lines.push(`    → Fix: ${f.recommendation}`)
      lines.push(`    → Ask me: "Fix the ${f.category} issue at ${f.location}"`)
    }
  } else if (s.mediumCount > 0) {
    lines.push(`  - No critical issues. ${s.mediumCount} advisory item${s.mediumCount > 1 ? 's' : ''} to review before production`)
    for (const f of s.topFindings.filter(f => f.severity === 'medium').slice(0, 3)) {
      lines.push(`  - [MEDIUM] \`${f.location}\`: ${f.description} — ${f.recommendation}`)
    }
  } else {
    lines.push(`  - No SQL injection, missing auth, or data exposure issues found`)
  }
  lines.push('')

  // ── Load test ──────────────────────────────────────────────────────────────
  const l = report.loadTest
  const lIcon = l.passed ? '✓' : '⚠'
  const latencyLabel = l.overallP95Ms < 300 ? 'Excellent' : l.overallP95Ms < 800 ? 'Good' : l.overallP95Ms < 2000 ? 'Acceptable' : 'Slow — consider adding indexes'
  lines.push(`**${lIcon} Performance** — p95 latency: ${l.overallP95Ms}ms (${latencyLabel})`)
  if (l.regressionDetected && l.regressions.length > 0) {
    lines.push(`  - Performance regression detected:`)
    for (const r of l.regressions.slice(0, 3)) {
      lines.push(`    - ${r}`)
      lines.push(`    → Ask me: "Optimize the slow query for ${r.split(' ')[0]}"`)
    }
  } else if (l.overallP95Ms >= 2000) {
    lines.push(`  - Response time is slow. Ask me: "Add indexes to speed up queries"`)
  } else {
    lines.push(`  - Response times are healthy across ${l.endpointsTested} endpoint${l.endpointsTested !== 1 ? 's' : ''}`)
  }

  return lines.join('\n')
}

// ── Next Step Computation ─────────────────────────────────────────────────────

function computeNextStep(
  job: BuildJob,
  graph: BuildGraph,
  blockedNodes: BuildNode[],
  remainingNodes: BuildNode[],
  jobStatus: BuildJobStatus,
): string {
  if (jobStatus === 'verified') {
    // Optional integration nodes can still be blocked even when all required nodes are verified.
    if (blockedNodes.length > 0) {
      const integrationLabels = [...new Set(
        blockedNodes.map(n => {
          const id = n.blockedReason?.resumeOnIntegration
          return id ? id.charAt(0).toUpperCase() + id.slice(1).replace('_', ' ') : n.label
        })
      )].join(', ')
      return `Structure is built — connect ${integrationLabels} above to reach "Build Complete".`
    }

    const allNodes = graph.getAllNodes()
    const schemaVerified = allNodes.filter(n => n.type === 'schema' && n.status === 'verified').length
    const authVerified = allNodes.some(n => n.type === 'auth' && n.status === 'verified')
    const apisVerified = allNodes.some(n => n.type === 'flow' && n.status === 'verified')
    const hasFullDepth = schemaVerified >= 2 && authVerified && apisVerified

    if (hasFullDepth) {
      return 'Build Complete — schema, auth, and APIs verified. Say "deploy" to go live, or say "/scan" for a production readiness report.'
    }
    if (schemaVerified === 1 && !authVerified) {
      return 'Table created and verified. Say "build the full backend" to add auth and APIs, or say "deploy" to expose this endpoint.'
    }
    return 'Tables created and verified. Add auth, APIs, or more features — or say "deploy" to go live.'
  }

  // Separate truly-pending nodes from nodes that are only pending because a
  // credential-blocked dependency hasn't resolved yet (transitively blocked)
  const transitivelyBlocked = remainingNodes.filter(n =>
    n.dependencies.some(depId => blockedNodes.some(bn => bn.id === depId))
  )
  const trulyPending = remainingNodes.filter(n =>
    !n.dependencies.some(depId => blockedNodes.some(bn => bn.id === depId))
  )

  // All internal work done — only credentials remain
  if (blockedNodes.length > 0 && trulyPending.length === 0) {
    const firstBlocked = blockedNodes[0]
    const integrationId = firstBlocked.blockedReason?.resumeOnIntegration
    const integrationLabel = integrationId
      ? integrationId.charAt(0).toUpperCase() + integrationId.slice(1)
      : firstBlocked.label
    if (transitivelyBlocked.length > 0) {
      return `Connect ${integrationLabel} using the button above — build will resume and also unlock ${transitivelyBlocked.map(n => n.label).join(', ')}.`
    }
    if (integrationId) {
      return `Connect ${integrationLabel} using the button above — build resumes automatically.`
    }
    return firstBlocked.blockedReason?.description ?? `Provide credentials for ${firstBlocked.label}`
  }

  if (trulyPending.length > 0) {
    // Don't ask the user to say "continue" — the build runtime auto-loops through ready nodes.
    // Only show this if the job has genuinely stalled (partial status with nothing blocked or failed).
    if (jobStatus === 'partial' && blockedNodes.length === 0) {
      return 'Building remaining components — this continues automatically.'
    }
    return `Building ${trulyPending.slice(0, 3).map(n => n.label).join(', ')}${trulyPending.length > 3 ? ` and ${trulyPending.length - 3} more` : ''}…`
  }

  if (jobStatus === 'failed') {
    const firstFailed = graph.getNodesByStatus('failed')[0]
    return firstFailed
      ? `Fix error in ${firstFailed.label}: ${firstFailed.failureReason ?? 'check logs'}`
      : 'Build failed — check the failed nodes above'
  }

  if (jobStatus === 'partial') {
    if (blockedNodes.length > 0) {
      return `Structure built — connect ${blockedNodes.length} integration${blockedNodes.length !== 1 ? 's' : ''} above. Workflows still need verification.`
    }
    return 'Structure built — workflows still need verification. Ask about any feature or say "deploy" to go live.'
  }

  return 'Backend is processing — check back shortly.'
}

// ── Status Label ──────────────────────────────────────────────────────────────
// Truthful labels — see ./status-labels.ts. We delegate so the dashboard,
// and the markdown renderer all stay in sync.

function statusLabel(status: BuildJobStatus): string {
  return buildStatusLabel(status)
}

// ── Plan Mode Renderer ────────────────────────────────────────────────────────

/**
 * Render a Plan-mode response (non-mutating).
 * Shows proposed architecture without executing anything.
 * The user must say "build it" to trigger execution.
 */
export function renderPlanResponse(job: BuildJob): PlanResponse {
  const phases = job.phases.map(phase => ({
    number: phase.number,
    name: phase.name,
    items: phase.nodes.map(n => {
      const blocked = n.status === 'blocked'
      return blocked ? `${n.label} *(requires ${n.blockedReason?.requiredEnvVar ?? 'credential'})*` : n.label
    }),
  }))

  const integrations = job.phases
    .flatMap(p => p.nodes)
    .filter(n => n.type === 'integration')
    .map(n => ({
      name: n.label,
      required: !n.optional,
      credentialRequired: n.blockedReason?.requiredEnvVar,
    }))

  const totalNodes = job.phases.flatMap(p => p.nodes).length

  const markdown = renderPlanMarkdown(job.domain, phases, integrations)

  return {
    mode: 'plan',
    domain: job.domain,
    phases,
    integrations,
    estimatedNodes: totalNodes,
    markdown,
  }
}

function renderPlanMarkdown(
  domain: Domain,
  phases: PlanResponse['phases'],
  integrations: PlanResponse['integrations'],
): string {
  const lines: string[] = []

  const domainLabel: Record<Domain, string> = {
    ecommerce:   'Ecommerce Backend',
    saas:        'SaaS Backend',
    marketplace: 'Marketplace Backend',
    social:      'Social Platform Backend',
    'ai-saas':   'AI SaaS Backend',
    fintech:     'Fintech Backend',
    media:       'Media Platform Backend',
    messaging:   'Messaging Backend',
    gaming:      'Gaming Backend',
    generic:     'Backend',
  }

  lines.push(`**Proposed Architecture — ${domainLabel[domain] ?? 'Backend'}**`) // plan mode uses static label (no prompt available here)
  lines.push('')
  lines.push('*Plan mode: no changes made yet. Say "build it" to execute.*')
  lines.push('')

  for (const phase of phases) {
    lines.push(`**Phase ${phase.number}: ${phase.name}**`)
    for (const item of phase.items) {
      lines.push(`- ${item}`)
    }
    lines.push('')
  }

  if (integrations.length > 0) {
    const blocked = integrations.filter(i => i.credentialRequired)
    if (blocked.length > 0) {
      lines.push('**Integrations that need credentials:**')
      for (const i of blocked) {
        lines.push(`- ${i.name}: requires \`${i.credentialRequired}\``)
      }
      lines.push('')
      lines.push('*These will be built as infrastructure first, then activated when you provide the credentials.*')
      lines.push('')
    }
  }

  lines.push('Say **"build it"** to start execution, or ask to modify the plan.')

  return lines.join('\n')
}

// ── Blocked-only response ─────────────────────────────────────────────────────

/**
 * Render a compact blocked-state response for when nothing can proceed.
 * Used when the build is stuck on credentials only.
 */
export function renderBlockedResponse(blockedNodes: BuildNode[]): string {
  const lines: string[] = ['**Build paused — credentials needed:**', '']

  for (const node of blockedNodes) {
    lines.push(`- **${node.label}**`)
    if (node.blockedReason?.userAction) {
      lines.push(`  → ${node.blockedReason.userAction}`)
    }
    if (node.blockedReason?.manualSteps) {
      for (const step of node.blockedReason.manualSteps) {
        lines.push(`  ${step}`)
      }
    }
  }

  lines.push('')
  lines.push('*Paste the credential above and the build will resume automatically.*')
  return lines.join('\n')
}

// ── Strict prose guard ────────────────────────────────────────────────────────

/**
 * Forbidden patterns that must never appear in Build mode responses.
 * Call this in tests to validate that rendered output is clean.
 */
export const FORBIDDEN_BUILD_PROSE_PATTERNS = [
  /\bgreat question\b/i,
  /\btypically\b/i,
  /\byou may want\b/i,
  /\blet me know\b/i,
  /\bi recommend\b/i,
  /\bhere'?s what usually\b/i,
  /\bfeel free to\b/i,
  /\bdon'?t hesitate\b/i,
  /\bhappy to help\b/i,
  /\bif you need anything\b/i,
  /\bhope that helps\b/i,
]

export function containsForbiddenProse(text: string): { found: boolean; pattern?: string } {
  for (const pattern of FORBIDDEN_BUILD_PROSE_PATTERNS) {
    if (pattern.test(text)) {
      return { found: true, pattern: pattern.source }
    }
  }
  return { found: false }
}
