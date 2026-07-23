/**
 * DOMAIN COMPILER
 * ===============
 * Converts a user prompt into a concrete BuildJob with phases + nodes.
 *
 * Two modes:
 *
 *   Mode A — Template (vague prompt: "create an ecommerce platform")
 *     1. Detect domain (ecommerce / saas / marketplace / generic)
 *     2. Load preset starter template for that domain
 *     3. Replace schema nodes with LLM-extracted entities from the prompt
 *     4. Prune/augment storage and integrations based on prompt signals
 *
 *   Mode B — Requirement-Driven (explicit prompt: "products, orders, Stripe, 4 buckets")
 *     1. Parse explicit requirements: required tables, integrations, storage, features, exclusions
 *     2. Build phases from ONLY those explicit requirements (Category A)
 *     3. Auto-add supporting infrastructure to make A work (Category B: auth, RLS, webhooks)
 *     4. Never add optional domain defaults like cart, wishlist, coupons (Category C)
 *     5. Respect all explicit exclusions ("no cart", "no shipping")
 *
 * Rules:
 *  - Explicit user requirements are BINDING — never overwritten by domain presets
 *  - Presets are used ONLY when the prompt is vague/underspecified
 *  - Auto-added nodes (Category B) must be required for correctness, not "nice to have"
 *  - Integration nodes are ALWAYS pre-blocked if no secret exists
 *  - No generic chatbot output is produced here — only BuildJob structure
 */

import { randomUUID } from 'crypto'
import type { BuildJob, BuildNode, BuildPhase, Domain, BuildContext } from './types'
import { phasesForDomain, detectDomain, genericPhases } from './domain-phases'
import { injectBlueprintNodes, filterSchemaToBlueprintEntities } from './blueprint-injector'
import { getOpenAIClient } from '../openai-service'
import { getModel } from '../model-router'
import {
  classifyDomainSemantically,
  analyzeAllTablePurposes,
  extractWorkflowsFromPrompt,
  extractBusinessRulesFromPrompt,
  buildSystemPromptEnrichment,
} from '../semantic-domain-analyzer'
import { shouldAutoGenerateCheckout, shouldAutoGenerateAdmin, shouldAutoGenerateAdminFromTables } from './domain-business-logic'

// ── Parsed Requirements ───────────────────────────────────────────────────────

export interface ParsedRequirements {
  /** 'template' = use preset starter; 'requirement-driven' = follow explicit user spec */
  mode: 'template' | 'requirement-driven'
  /** Tables explicitly named by the user (Category A) */
  requiredTables: string[]
  /** Integrations explicitly requested */
  requiredIntegrations: Array<'stripe' | 'google_auth' | 'resend' | 'openai'>
  /** Number of storage buckets explicitly requested (0 = not specified) */
  storageBucketCount: number
  /** Explicit bucket names if user provided them */
  storageBucketNames: string[]
  /** Features explicitly requested: 'realtime', 'chat', 'auth', etc. */
  requiredFeatures: string[]
  /** Tables or features explicitly excluded by the user */
  excludedItems: string[]
}

// ── Integration brand-name guard ──────────────────────────────────────────────
// Only allow an integration to be included when its brand name appears LITERALLY
// in the user's prompt. "pay online" / "payment" / "checkout" do NOT qualify for
// "stripe". Used both as a post-LLM filter and in blueprint entity-first override.
const EXPLICIT_INTEGRATION_BRAND_RE: Partial<Record<string, RegExp>> = {
  stripe:      /\bstripe\b/i,
  google_auth: /\bgoogle\s*(auth|oauth|sign.?in|login)\b/i,
  resend:      /\bresend\b/i,
  openai:      /\bopenai\b/i,
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compile a user prompt into a BuildJob.
 *
 * Two modes:
 *  - Mode A (Template):            vague prompt → use preset domain starter template
 *  - Mode B (Requirement-Driven):  explicit prompt → build only what was asked +
 *                                  necessary support infrastructure
 */
export async function compileBuildJob(
  prompt: string,
  ctx: BuildContext,
): Promise<BuildJob> {
  // Fast synchronous domain detection first
  let domain: Domain = detectDomain(prompt)
  const now = new Date().toISOString()

  // Parse requirements and extract entities in parallel with semantic analysis.
  // #50 fix: if fast detect returns 'generic', run LLM semantic classification
  // concurrently so synonyms ("account", "identity", "member") are handled correctly.
  const semanticDomainPromise = domain === 'generic'
    ? classifyDomainSemantically(prompt)
    : Promise.resolve(null)

  let [requirements, entities, detailedSchema, semanticDomain] = await Promise.all([
    parseRequirementsFromPrompt(prompt),
    extractEntities(prompt),
    extractDetailedSchema(prompt),
    semanticDomainPromise,
  ])

  // Apply semantic domain when it is confident and fast-detect was uncertain
  if (semanticDomain && semanticDomain.confidence >= 0.7 && semanticDomain.domain !== 'generic') {
    domain = semanticDomain.domain as Domain
    console.log(`[DomainCompiler] Semantic domain override: generic → ${domain} (${semanticDomain.confidence.toFixed(2)} confidence, signals: ${semanticDomain.signals.join(', ')})`)
  }

  // ── Blueprint entity-first override (CB1 fix) ─────────────────────────────
  // When a ProductBlueprint is available from goalUnderstandingStage, it has the
  // correct semantic entity ordering (users → stores → products → ...) derived
  // from the full product description. Use it as the authoritative table list,
  // preventing the LLM from over-indexing on payment keywords ("pay online" →
  // stripe/orders) at the expense of foundational schema entities.
  // Integration keywords like "pay online", "checkout", "billing" must NEVER
  // override foundational schema planning — only explicit brand names qualify.
  if (ctx.productBlueprint && ctx.productBlueprint.entities.length >= 3) {
    const blueprintEntities = ctx.productBlueprint.entities
      .map((e: { name: string }) => (e.name as string).toLowerCase().replace(/\s+/g, '_'))
      .filter((t: string) => !requirements.excludedItems.includes(t))
    if (blueprintEntities.length > 0) {
      requirements = {
        ...requirements,
        requiredTables: blueprintEntities,
        mode: 'requirement-driven',
        // Strip LLM-inferred integrations: blueprint integrations are added as blocked
        // nodes separately by injectBlueprintNodes (called later in compileBuildJob).
        // Only keep integrations whose exact brand name appears literally in the prompt.
        requiredIntegrations: requirements.requiredIntegrations.filter(
          integ => EXPLICIT_INTEGRATION_BRAND_RE[integ]?.test(prompt) ?? false
        ) as ParsedRequirements['requiredIntegrations'],
      }
      console.log(`[DomainCompiler] Blueprint entity-first override: [${blueprintEntities.join(', ')}]`)
    }
  }

  let phases: BuildPhase[]

  if (requirements.mode === 'requirement-driven') {
    // ── Mode B: Requirement-Driven ────────────────────────────────────────────
    // User gave explicit requirements. Build exactly what was asked for.
    // Only add Category B support infrastructure needed to make those work.
    // Category C (optional domain defaults like cart, wishlist, coupons) are
    // NOT added unless explicitly requested.
    phases = buildRequirementDrivenPhases(requirements, entities, prompt)
  } else {
    // ── Mode A: Template Mode ─────────────────────────────────────────────────
    // Vague prompt — user only gave the domain. Use preset starter template.
    // Schema nodes are still derived from LLM entity extraction; the template
    // provides structural scaffolding (auth, flows, integrations, verification).
    if (domain === 'generic') {
      phases = genericPhases(entities)
      phases = augmentWithStorage(phases, prompt, entities)
      phases = await augmentWithIntegrations(phases, prompt)
    } else {
      const templatePhases = phasesForDomain(domain)
      phases = replaceSchemaNodesWithEntities(templatePhases, entities)
      phases = pruneIrrelevantPhases(phases, prompt, domain)
      phases = augmentWithStorage(phases, prompt, entities)
      phases = await augmentWithIntegrations(phases, prompt)
    }
  }

  // Inject prompt-parsed column specs into schema nodes (overrides blueprints)
  if (detailedSchema.size > 0) {
    phases = injectPromptColumns(phases, detailedSchema)
  }

  // Inject originalPrompt into every schema node's executionParams so that
  // node-executor can pass it to the LLM column generator for unknown tables.
  phases = injectOriginalPrompt(phases, prompt)

  // ── Semantic enrichment (#46, #47, #48, #49) ───────────────────────────────
  // Analyze table purposes, detect state machines, extract workflows and business rules.
  // Run concurrently — none of these block phase construction.
  const schemaNodes = phases.flatMap(p => p.nodes).filter(n => n.type === 'schema')
  const tableInputs = schemaNodes.map(n => ({
    name: n.id.replace(/^schema\./, ''),
    // Prefer parsed columns from detailedSchema; fall back to column blueprint names
    columns: (detailedSchema.get(n.id.replace(/^schema\./, ''))?.columns.map(c => c.name) ?? []),
  }))

  const [semanticAnalysis, workflows, businessRules] = await Promise.all([
    tableInputs.length > 0 ? analyzeAllTablePurposes(tableInputs) : Promise.resolve({ purposes: {}, stateMachines: [] }),
    extractWorkflowsFromPrompt(prompt),
    extractBusinessRulesFromPrompt(prompt),
  ])

  // Build the enrichment block and inject it into every schema node's executionParams
  // so node-executor can surface it to the LLM when generating column schemas / functions.
  const enrichmentBlock = buildSystemPromptEnrichment(
    semanticAnalysis.stateMachines,
    businessRules,
    workflows,
  )

  if (enrichmentBlock.trim()) {
    phases = injectSemanticEnrichment(phases, enrichmentBlock, semanticAnalysis.purposes)
    console.log(`[DomainCompiler] Injected semantic enrichment: ${semanticAnalysis.stateMachines.length} state machines, ${businessRules.length} business rules, ${workflows.length} workflows`)
  }

  // ── Schema-based storage auto-detection (#72) ─────────────────────────────
  // If any column in any table is named with a file-URL convention
  // (fileUrl, avatarUrl, thumbnailUrl, videoUrl, imageUrl, etc.) and no
  // storage phase has been built yet, auto-provision the appropriate buckets.
  phases = injectSchemaBasedStorageBuckets(phases, detailedSchema, schemaNodes)

  // Always check integration credentials and mark blocked/pending accordingly
  phases = markIntegrationsBlocked(phases, ctx.availableSecrets ?? [])

  // ── Blueprint injection ────────────────────────────────────────────────────
  // When a ProductBlueprint was computed by goalUnderstandingStage, its inferred
  // dimensions (storage, integrations, realtime, functions, permissions) REPLACE
  // auto-detected equivalents so every GUE inference becomes a real BuildNode.
  if (ctx.productBlueprint) {
    phases = injectBlueprintNodes(phases, ctx.productBlueprint, ctx.availableSecrets ?? [])
    phases = filterSchemaToBlueprintEntities(phases, ctx.productBlueprint)
    console.log(
      `[DomainCompiler] Blueprint injected: ${ctx.productBlueprint.entities.length} entities, ` +
      `${ctx.productBlueprint.storageBuckets.length} buckets, ${ctx.productBlueprint.integrations.length} integrations, ` +
      `${ctx.productBlueprint.functions.length} functions`,
    )
  }

  const job: BuildJob = {
    id: randomUUID(),
    projectId: ctx.projectId,
    userId: ctx.userId,
    originalPrompt: prompt,
    domain,
    status: 'pending',
    phases,
    createdAt: now,
    updatedAt: now,
    goalSummary: summarizeGoal(prompt, domain),
    buildMode: requirements.mode,
  }

  return job
}

// ── Requirement Parser ────────────────────────────────────────────────────────

/**
 * Classify prompt as 'template' or 'requirement-driven', then extract
 * explicit requirements when in requirement-driven mode.
 *
 * Detection heuristics (fast, no LLM):
 *  - Exclusion language ("no cart", "without wishlist") → requirement-driven
 *  - Explicit table listing ("these 6 tables") → requirement-driven
 *  - Named integrations (Stripe, Google auth, Resend) → requirement-driven
 *  - Explicit storage count ("4 storage buckets") → requirement-driven
 *  - Long structured prompt (> 120 chars) with "and/with/plus" → requirement-driven
 *  - Otherwise → template mode
 */
async function parseRequirementsFromPrompt(prompt: string): Promise<ParsedRequirements> {
  const lower = prompt.toLowerCase()

  const hasExclusions   = /\bno\s+\w+|\bwithout\s+\w+|\bexclude\b|only\s+(these|the\s+following)\b/i.test(prompt)
  const hasTableList    = /\bthese\s+\d+\s+tables?\b|\btables?\s*:\s*[\n\r]|only\s+\w[\w,\s]+\s+tables?\b/i.test(prompt)
  const hasNamedInteg   = /\bstripe\b|\bgoogle\s*(auth|oauth|sign.?in|login)\b|\bresend\b|\bsendgrid\b|\bgithub\s*(auth|oauth)\b|\bopenai\b/i.test(prompt)
  // Explicit bucket name ("create uploads bucket") OR numeric bucket count ("4 storage buckets")
  const hasBucketSpec   = /\b\d+\s+(?:storage\s+)?buckets?\b/i.test(prompt) ||
                          /\b(?:create|add|make|new|delete|remove)\b.{0,40}\b\w+\s+bucket\b/i.test(prompt) ||
                          /\bcreate\s+(?:a\s+)?(?:storage\s+)?bucket\b/i.test(prompt)
  const isDetailed      = prompt.length > 120 && /\b(and|plus|with)\b/.test(lower)

  const isRequirementDriven = hasExclusions || hasTableList || hasNamedInteg || hasBucketSpec || isDetailed

  if (!isRequirementDriven) {
    return {
      mode: 'template',
      requiredTables: [],
      requiredIntegrations: [],
      storageBucketCount: 0,
      storageBucketNames: [],
      requiredFeatures: [],
      excludedItems: [],
    }
  }

  // Use LLM to extract the explicit requirements
  try {
    const openai = getOpenAIClient()
    const response = await openai.chat.completions.create({
      model: getModel('classify'),
      messages: [
        {
          role: 'system',
          content: `You are a backend requirements extractor. Extract explicit user requirements from a prompt.

Return ONLY this JSON shape:
{
  "requiredTables": ["table1", "table2"],
  "requiredIntegrations": [],
  "storageBucketCount": 0,
  "storageBucketNames": [],
  "requiredFeatures": [],
  "excludedItems": []
}

Extraction rules:
- requiredTables: ONLY tables the user explicitly named (snake_case). Do NOT add tables the user didn't mention. Include "users" if auth is requested OR if any table has a user_id column.
- requiredIntegrations: from ["stripe","google_auth","resend","openai"]. CRITICAL RULE: only add an integration if its brand name appears LITERALLY in the user's message. "pay online", "payment", "checkout", "billing", "e-commerce", "buy", "purchase", "transactions" do NOT qualify for "stripe" — the user must have typed "Stripe" or "stripe" literally. "email", "notifications", "send emails" do NOT qualify for "resend". "AI features", "smart search" do NOT qualify for "openai". When uncertain, return [].
- storageBucketCount: if user says "4 storage buckets" → 4, "2 buckets" → 2, not specified → 0.
- storageBucketNames: if user named specific buckets (e.g. "product_images bucket, avatars bucket") → include them, else [].
- requiredFeatures: IMPORTANT auth examples — "enable user auth" → ["auth"], "enable user authentication" → ["auth"], "user authentication with email and password" → ["auth"], "sign in" → ["auth"], "login" → ["auth"], "register" → ["auth"], "JWT" → ["auth"]. Also: "realtime chat" → ["realtime","chat"]. "realtime notifications" → ["realtime"].
- excludedItems: if user says "no cart", "without wishlist", "no shipping" → add those words (snake_case).`,
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    })

    const raw = JSON.parse(response.choices[0].message.content || '{}')
    const parsedIntegrations: ParsedRequirements['requiredIntegrations'] = Array.isArray(raw.requiredIntegrations)
      ? raw.requiredIntegrations
      : []
    // BUG-07: Domain inference — if the prompt describes an AI-generative product
    // (video generation, image AI, text AI, etc.) auto-suggest OpenAI even when the
    // user didn't say "openai" explicitly. The LLM extraction rule "only what user
    // explicitly named" is too strict for domain-implied AI dependencies.
    if (!parsedIntegrations.includes('openai') && isAiNativeDomain(prompt)) {
      parsedIntegrations.push('openai')
    }

    // Hard guard: strip integrations that the LLM inferred from context rather than
    // explicit brand naming ("pay online" → stripe, "send emails" → resend).
    // openai is exempted from this guard because isAiNativeDomain covers domain-implied AI.
    const guardedIntegrations = parsedIntegrations.filter(integ =>
      integ === 'openai'
        ? true // openai allowed via isAiNativeDomain domain inference
        : EXPLICIT_INTEGRATION_BRAND_RE[integ]?.test(prompt) ?? false
    ) as ParsedRequirements['requiredIntegrations']

    // Always run the deterministic list parser alongside the LLM extraction.
    // If the LLM returned fewer tables than the deterministic parser found, merge.
    // This handles cases where LLM omits entities from long prompts.
    const llmTables: string[] = Array.isArray(raw.requiredTables)
      ? raw.requiredTables.map((t: unknown) => String(t).toLowerCase())
      : []
    const deterministicTables = extractEntitiesFromExplicitList(prompt)
    const mergedTables = [...new Set([...llmTables, ...deterministicTables])]
      .filter(t => !Array.isArray(raw.excludedItems) || !raw.excludedItems.map((i: unknown) => String(i).toLowerCase()).includes(t))

    return {
      mode: 'requirement-driven',
      requiredTables:       mergedTables.length > 0 ? mergedTables : llmTables,
      requiredIntegrations: guardedIntegrations,
      storageBucketCount:   typeof raw.storageBucketCount === 'number' ? raw.storageBucketCount : 0,
      storageBucketNames:   Array.isArray(raw.storageBucketNames) ? raw.storageBucketNames : [],
      requiredFeatures:     Array.isArray(raw.requiredFeatures) ? raw.requiredFeatures.map((f: unknown) => String(f).toLowerCase()) : [],
      excludedItems:        Array.isArray(raw.excludedItems) ? raw.excludedItems.map((i: unknown) => String(i).toLowerCase()) : [],
    }
  } catch {
    // Heuristic fallback (includes deterministic list parser)
    return heuristicRequirementExtraction(prompt)
  }
}

/**
 * BUG-07: Domain-implied AI dependency detection.
 * Returns true when the prompt describes a product that inherently requires an
 * LLM/generative model, even if the user did not say "openai" explicitly.
 */
function isAiNativeDomain(prompt: string): boolean {
  const lower = prompt.toLowerCase()
  return (
    // Generative media
    /\b(ai.?generat|generat.{0,20}(video|image|audio|3d|model|content|text))\b/.test(lower) ||
    /\b(video.{0,20}generat|image.{0,20}generat|3d.{0,20}generat|text.{0,20}generat)\b/.test(lower) ||
    // AI rendering / creation
    /\b(ai.{0,15}render|ai.{0,15}creat|ai.{0,15}complet|ai.{0,15}summar|ai.{0,15}translat)\b/.test(lower) ||
    // Specific generative product categories
    /\b(diffusion|stable.?diffusion|dall.?e|midjourney|runway|sora|luma|kling|pika)\b/.test(lower) ||
    // LLM-powered features (explicit terms that imply OpenAI even without "openai")
    /\b(llm|large.?language.?model|gpt|chatgpt|embedding|vector.?search|semantic.?search)\b/.test(lower) ||
    // Chatbot / assistant products
    /\b(ai.{0,20}(chat|assistant|bot|copilot|agent))\b/.test(lower)
  )
}

/**
 * Deterministic entity extractor for explicit list formats.
 *
 * Parses section headings ("Core entities:", "Tables:", etc.) followed by
 * bullet or numbered lists, and also extracts standalone table-like nouns
 * from common phrases ("create users, stores, products").
 *
 * This runs even when the LLM extraction succeeds, to ensure we never miss
 * explicitly named entities due to LLM brevity or hallucination.
 *
 * Returns snake_case table names in declaration order (referenced first).
 */
export function extractEntitiesFromExplicitList(prompt: string): string[] {
  const found: string[] = []
  const lower = prompt.toLowerCase()

  // ── 1. Section-headed list (most reliable) ─────────────────────────────────
  // Matches patterns like:
  //   "Core entities:\n- users\n- stores\n- products"
  //   "Tables:\n1. users\n2. orders"
  //   "- users\n- stores\n- products\n- orders" (no heading needed)
  const sectionRE = /(?:(?:core\s+)?(?:entities|tables|models|schemas?|resources?)\s*:\s*\n)((?:[ \t]*[-*•\d.]+[ \t]+\w[\w_ ]*\n?)+)/gi
  let m: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((m = sectionRE.exec(prompt)) !== null) {
    const block = m[1]
    const items = block.match(/[-*•\d.]+[ \t]+(\w[\w_ ]*)/g) ?? []
    for (const item of items) {
      const name = item.replace(/^[-*•\d.]+[ \t]+/, '').trim().toLowerCase().replace(/\s+/g, '_')
      if (name && !found.includes(name)) found.push(name)
    }
  }

  // ── 2. Bare bullet/numbered list (no heading required) ────────────────────
  // Match lines that look like "- users" or "• products" or "1. orders"
  if (found.length === 0) {
    const bulletRE = /^[ \t]*[-*•][ \t]+(\w[\w_]*)[ \t]*$/gm
    const numberedRE = /^[ \t]*\d+\.[ \t]+(\w[\w_]*)[ \t]*$/gm
    for (const re of [bulletRE, numberedRE]) {
      let bm: RegExpExecArray | null
      // eslint-disable-next-line no-cond-assign
      while ((bm = re.exec(prompt)) !== null) {
        const name = bm[1].toLowerCase()
        if (!found.includes(name)) found.push(name)
      }
    }
  }

  // ── 3. Comma-separated entity list after build verbs ──────────────────────
  // "build users, stores, products, orders, order_items, reviews"
  if (found.length === 0) {
    const verbListRE = /\b(?:build|create|generate|make|need|with)\b[^.!?\n]*\b((?:[\w_]+)(?:\s*,\s*[\w_]+){2,})/gi
    // eslint-disable-next-line no-cond-assign
    while ((m = verbListRE.exec(lower)) !== null) {
      const parts = m[1].split(/\s*,\s*/)
      for (const p of parts) {
        const name = p.trim().replace(/\s+/g, '_')
        if (name && !found.includes(name)) found.push(name)
      }
    }
  }

  // ── 4. Explicit "do NOT create" exclusion — returns a separate set ────────
  // Not returned here; exclusions are handled in heuristicRequirementExtraction.

  // Filter: keep only plausible table names (2-40 chars, no reserved words)
  const NOISE = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'with', 'my', 'me', 'i', 'you', 'we', 'to', 'in', 'on', 'of', 'at', 'as', 'by', 'up', 'it', 'its', 'not', 'no', 'all', 'any', 'yes', 'only', 'only', 'each', 'every', 'this', 'that', 'these', 'those', 'they', 'them', 'their', 'jwt', 'rls', 'api', 'auth', 'rest', 'sql', 'db', 'production', 'grade', 'backend'])
  return found.filter(t => t.length >= 2 && t.length <= 40 && !NOISE.has(t))
}

function heuristicRequirementExtraction(prompt: string): ParsedRequirements {
  const lower = prompt.toLowerCase()

  const integrations: ParsedRequirements['requiredIntegrations'] = []
  if (/\bstripe\b/.test(lower))                                   integrations.push('stripe')
  if (/\bgoogle\s*(auth|oauth|sign.?in|login)\b/i.test(prompt))  integrations.push('google_auth')
  if (/\bresend\b/.test(lower))                                   integrations.push('resend')
  if (/\bopenai\b/.test(lower) || isAiNativeDomain(prompt))      integrations.push('openai')

  const bucketMatch = lower.match(/(\d+)\s+(?:storage\s+)?buckets?/)
  const storageBucketCount = bucketMatch ? parseInt(bucketMatch[1], 10) : 0

  // Bucket names from storage/upload mentions
  const storageBucketNames: string[] = []
  const bucketNameRE = /\b([\w_]+(?:\s+[\w_]+)?)\s+(?:bucket|storage|uploads?)\b/gi
  let bm: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((bm = bucketNameRE.exec(prompt)) !== null) {
    const name = bm[1].trim().toLowerCase().replace(/\s+/g, '_')
    if (name && !storageBucketNames.includes(name) && name.length < 40) storageBucketNames.push(name)
  }

  const features: string[] = []
  if (/\brealtime\b/.test(lower)) features.push('realtime')
  if (/\bchat\b/.test(lower))     features.push('chat')
  if (/\bauth(entication)?\b/i.test(prompt) || /\bsign[\s-]?(in|up)\b/i.test(prompt) || /\blogin\b/i.test(lower)) features.push('auth')

  const excluded: string[] = []
  // "do NOT create X, Y, Z" or "no X" or "without X"
  const doNotRE = /\bdo\s+not\s+(?:create|add|include|build)\s+([\w,\s]+?)(?:\.|$)/gi
  let dm: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((dm = doNotRE.exec(lower)) !== null) {
    const parts = dm[1].split(/,|\band\b/)
    for (const p of parts) {
      const name = p.trim().replace(/\s+/g, '_').replace(/\btable(s)?\b/g, '').trim()
      if (name && name.length > 1) excluded.push(name)
    }
  }
  const noMatches = lower.match(/\bno\s+(\w+)\b/g) ?? []
  for (const nm of noMatches) {
    const w = nm.replace(/^no\s+/, '')
    if (!excluded.includes(w)) excluded.push(w)
  }

  // ── Deterministic entity extraction from explicit lists ────────────────────
  const explicitEntities = extractEntitiesFromExplicitList(prompt)
  // Apply keyword-based domain table detection as supplemental fallback
  const keywordTables: string[] = []
  if (explicitEntities.length === 0) {
    if (/\buser|account|member|person\b/.test(lower)) keywordTables.push('users')
    if (/\bstore|vendor|seller|merchant|shop\b/.test(lower)) keywordTables.push('stores')
    if (/\bpost|article|content|blog\b/.test(lower)) keywordTables.push('posts')
    if (/\bcomment|reply\b/.test(lower)) keywordTables.push('comments')
    if (/\bproduct|listing|item|good\b/.test(lower)) keywordTables.push('products')
    if (/\border\b/.test(lower)) keywordTables.push('orders')
    if (/\border_item|line.?item\b/.test(lower)) keywordTables.push('order_items')
    if (/\breview|rating\b/.test(lower)) keywordTables.push('reviews')
    if (/\bcart\b/.test(lower)) keywordTables.push('carts')
    if (/\bcart.?item|item.?in.?cart\b/.test(lower)) keywordTables.push('cart_items')
    if (/\bwishlist|wish.?list\b/.test(lower)) keywordTables.push('wishlists')
    if (/\bcategory|categor\b/.test(lower)) keywordTables.push('categories')
    if (/\bmessage|chat\b/.test(lower)) keywordTables.push('messages')
    if (/\btask|todo\b/.test(lower)) keywordTables.push('tasks')
    if (/\bnote\b/.test(lower)) keywordTables.push('notes')
    if (/\bworkspace|team\b/.test(lower)) keywordTables.push('workspaces')
    if (/\bpayment|invoice|transaction\b/.test(lower)) keywordTables.push('payments')
    if (/\bsubscription\b/.test(lower) && !excluded.includes('subscription') && !excluded.includes('subscriptions')) keywordTables.push('subscriptions')
  }

  const requiredTables = (explicitEntities.length > 0 ? explicitEntities : keywordTables)
    .filter(t => !excluded.some(e => t.includes(e) || e.includes(t)))

  return {
    mode: 'requirement-driven',
    requiredTables,
    requiredIntegrations: integrations,
    storageBucketCount,
    storageBucketNames,
    requiredFeatures: features,
    excludedItems: excluded,
  }
}

// ── Requirement-Driven Phase Builder ─────────────────────────────────────────

/**
 * Build phases from explicit user requirements (Mode B).
 *
 * Three categories:
 *  A. User-required     → explicitly named tables/integrations/features (locked)
 *  B. System-required   → support infra needed to make A work (auth, RLS, webhooks)
 *  C. Domain defaults   → NOT included (cart, wishlist, coupons, etc.) unless in A
 *
 * Explicit exclusions override everything — if user said "no cart", cart is never added.
 */
function buildRequirementDrivenPhases(
  requirements: ParsedRequirements,
  entities: string[], // LLM-extracted entities — used only when requiredTables is empty
  originalPrompt = '', // used for admin-intent detection (#58)
): BuildPhase[] {
  const phases: BuildPhase[] = []

  // Resolve final table list: prefer explicit requirements, fall back to LLM
  let tables = (requirements.requiredTables.length > 0 ? requirements.requiredTables : entities)
    .filter(t => !requirements.excludedItems.includes(t))

  // Detect auth need from features array (any auth-related term) OR direct prompt scan
  const authFeatureSignal = requirements.requiredFeatures.some(f =>
    /^(auth|authentication|user_auth|email_auth|login|register|signup|sign_?in|jwt|password)$/.test(f)
  )
  const authPromptSignal = /\b(enable\s+(user\s+)?auth|user\s+auth(entication)?|email\s+and\s+password|sign[\s-]?(in|up)|login|register|jwt\s+auth|password\s+auth)\b/i.test(originalPrompt)
  // Also treat presence of user_id column in any table as an auth signal
  const userIdSignal = /\buser_?id\b/i.test(originalPrompt)

  const needsAuth = tables.includes('users')
    || requirements.requiredIntegrations.includes('google_auth')
    || authFeatureSignal
    || authPromptSignal

  // If auth is needed but no users table was listed, auto-add it
  if (needsAuth && !tables.includes('users')) {
    tables = ['users', ...tables]
  }
  // If any table has user_id references but no users table, auto-add users
  if (userIdSignal && !tables.includes('users') && !requirements.excludedItems.includes('users')) {
    tables = ['users', ...tables]
  }

  const hasUsers = tables.includes('users')
  const needsRealtime = requirements.requiredFeatures.includes('realtime')
    || requirements.requiredFeatures.includes('chat')

  // ── Phase 1: Core Schema ───────────────────────────────────────────────────
  if (tables.length > 0) {
    const schemaNodes: BuildNode[] = tables.map((table, i) => ({
      id:           `schema.${table}`,
      label:        `${table} table`,
      type:         'schema' as const,
      phase:        1,
      status:       'pending' as const,
      dependencies: i > 0 && hasUsers && table !== 'users' ? ['schema.users'] : [],
    }))
    phases.push({
      number:      1,
      name:        'Core Schema',
      description: 'Database tables from explicit requirements',
      nodes:       schemaNodes,
    })
  }

  // ── Phase 2: Auth (Category B — support for users / Google auth) ───────────
  if (needsAuth) {
    const authNodes: BuildNode[] = []

    authNodes.push({
      id:           'auth.jwt',
      label:        'JWT authentication',
      type:         'auth',
      phase:        2,
      status:       'pending',
      dependencies: hasUsers ? ['schema.users'] : [],
    })

    // RLS — needed whenever user-owned tables exist (security support infra)
    const rlsTables = tables.filter(t => t !== 'users')
    if (hasUsers && rlsTables.length > 0) {
      authNodes.push({
        id:           'permissions.rls',
        label:        'Row-level security (RLS)',
        type:         'permissions',
        phase:        2,
        status:       'pending',
        dependencies: ['auth.jwt'],
        executionParams: {
          tables:    rlsTables,
          condition: 'user_id = auth.uid()',
        },
      })
    }

    // Google OAuth — only if explicitly requested
    if (requirements.requiredIntegrations.includes('google_auth')) {
      authNodes.push({
        id:           'auth.google',
        label:        'Google OAuth sign-in',
        type:         'auth',
        phase:        2,
        status:       'blocked',
        dependencies: ['auth.jwt'],
        optional:     true,
        blockedReason: {
          type:               'missing_credential',
          description:        'Google Client ID and Client Secret required to activate Google sign-in',
          requiredEnvVar:     'GOOGLE_CLIENT_ID',
          resumeOnIntegration:'google',
          userAction:         'Go to console.cloud.google.com → Credentials → Create OAuth 2.0 Client, then paste: google_client_id: YOUR_ID\ngoogle_client_secret: YOUR_SECRET',
          manualSteps: [
            'Go to https://console.cloud.google.com/apis/credentials',
            'Create project → Enable OAuth 2.0 → Create OAuth client ID (Web application)',
            'Add authorized redirect URI: {your-domain}/api/v1/{projectId}/auth/google/callback',
            'Copy Client ID and Client Secret and paste them in chat',
          ],
        },
      })
    }

    phases.push({
      number:      2,
      name:        'Auth',
      description: 'Authentication and access control as required',
      nodes:       authNodes,
    })
  }

  // ── Phase 3: API Layer ─────────────────────────────────────────────────────
  const flowNodes: BuildNode[] = tables.map(t => ({
    id:           `flow.${t}_apis`,
    label:        `${t} REST endpoints`,
    type:         'flow' as const,
    phase:        3,
    status:       'pending' as const,
    dependencies: [`schema.${t}`, ...(needsAuth ? ['auth.jwt'] : [])],
    executionParams: { tableName: t },
  }))

  // Realtime — support infra for explicitly requested realtime/chat feature
  if (needsRealtime) {
    const chatTable = tables.find(t => /message|chat|conversation/.test(t))
    // Use the actual table name (or 'all_tables') as the node sub-ID so the realtime
    // executor can derive a meaningful detail string from it.
    const realtimeTableId = chatTable ?? 'all_tables'
    flowNodes.push({
      id:           `realtime.${realtimeTableId}`,
      label:        'Realtime subscriptions',
      type:         'realtime',
      phase:        3,
      status:       'pending',
      dependencies: [
        ...(chatTable ? [`schema.${chatTable}`] : []),
        ...(needsAuth ? ['auth.jwt'] : []),
      ],
      executionParams: {
        tableNames: chatTable ? [chatTable, ...tables.filter(t => t !== chatTable)] : tables,
        displayLabel: 'all subscriptions',
      },
    })
  }

  // ── #57 Auto-trigger checkout flow ────────────────────────────────────────
  // If the project tables imply billing (payments, orders, subscriptions) AND the
  // user did NOT explicitly exclude a checkout flow, auto-add a checkout flow node.
  // This is Category B support infrastructure — it makes billing tables work correctly.
  if (shouldAutoGenerateCheckout(tables) && !requirements.excludedItems.includes('checkout')) {
    const billingDep = tables.find(t => /payment|order|invoice|checkout/.test(t))
    const alreadyHasCheckoutNode = flowNodes.some(n => n.id === 'flow.checkout')
    if (!alreadyHasCheckoutNode) {
      flowNodes.push({
        id:           'flow.checkout',
        label:        'Checkout flow (auto-generated from billing tables)',
        type:         'flow',
        phase:        3,
        status:       'pending',
        dependencies: [
          ...(billingDep ? [`schema.${billingDep}`] : []),
          ...(needsAuth ? ['auth.jwt'] : []),
        ],
        executionParams: { autoGenerated: true },
      })
    }
  }

  // ── #58 Auto-generate admin node ───────────────────────────────────────────
  // When the prompt signals admin intent (admin role, back-office, staff portal)
  // AND the users table is present, inject an admin flow node.
  // This is Category B support infrastructure — required for admin-role projects.
  // #97: Also auto-generate admin when tables imply SaaS (users + billing/jobs),
  // even if the prompt didn't say "admin" explicitly.
  const allTableNames = flowNodes.filter(n => n.id.startsWith('schema.')).map(n => n.id.replace('schema.', ''))
  const adminByPrompt = shouldAutoGenerateAdmin(originalPrompt)
  const adminByTables = shouldAutoGenerateAdminFromTables(allTableNames)
  if (hasUsers && (adminByPrompt || adminByTables) && !requirements.excludedItems.includes('admin')) {
    const alreadyHasAdminNode = flowNodes.some(n => n.id === 'flow.admin_apis')
    if (!alreadyHasAdminNode) {
      flowNodes.push({
        id:           'flow.admin_apis',
        label:        'Admin API endpoints',
        type:         'flow',
        phase:        3,
        status:       'pending',
        dependencies: ['schema.users', ...(needsAuth ? ['auth.jwt'] : [])],
        executionParams: { adminMode: true },
      })
    }
  }

  if (flowNodes.length > 0) {
    phases.push({
      number:      3,
      name:        'API Layer',
      description: 'REST endpoints for each required table',
      nodes:       flowNodes,
    })
  }

  // ── Phase 4: Integrations ──────────────────────────────────────────────────
  const integrationNodes: BuildNode[] = []
  const intPhase = phases.length + 1

  if (requirements.requiredIntegrations.includes('stripe')) {
    const paymentsTable = tables.find(t => /order|payment|invoice/.test(t))
    // Category B: checkout + webhook are both needed to make Stripe work correctly
    integrationNodes.push({
      id:           'integration.stripe.checkout',
      label:        'Stripe checkout',
      type:         'integration',
      phase:        intPhase,
      status:       'blocked',
      optional:     true,
      dependencies: paymentsTable ? [`schema.${paymentsTable}`] : [],
      blockedReason: {
        type:               'missing_credential',
        description:        'Stripe secret key required',
        requiredEnvVar:     'STRIPE_SECRET_KEY',
        resumeOnIntegration:'stripe',
        userAction:         'Paste your Stripe secret key (sk_live_... or sk_test_...) in the chat',
      },
    })
    integrationNodes.push({
      id:           'integration.stripe.webhook',
      label:        'Stripe webhook handler',
      type:         'integration',
      phase:        intPhase,
      status:       'blocked',
      optional:     true,
      dependencies: ['integration.stripe.checkout'],
      blockedReason: {
        type:               'missing_credential',
        description:        'Stripe webhook secret required for signature verification',
        requiredEnvVar:     'STRIPE_WEBHOOK_SECRET',
        resumeOnIntegration:'stripe_webhook',
        userAction:         'After creating webhook in Stripe dashboard, paste the signing secret',
        manualSteps: [
          'Go to https://dashboard.stripe.com/webhooks',
          'Add endpoint: {your-domain}/api/v1/{projectId}/webhooks/stripe',
          'Select events: payment_intent.succeeded, payment_intent.payment_failed',
          'Copy the signing secret and paste it here',
        ],
      },
    })
  }

  // ── Generic payment plan (pay online without explicit provider) ────────────
  // When the prompt signals payment intent but the user didn't name a provider,
  // add a blocked "provider not selected" node rather than silently skipping payments.
  // This keeps autonomy high while avoiding false Stripe assumptions.
  const PAYMENT_KEYWORD_RE =
    /\b(pay(\s+online)?|payment(?!\s*provider)|checkout|billing|buy|purchase|e-commerce|ecommerce|transaction|subscribe)\b/i
  const hasPaymentKeyword = PAYMENT_KEYWORD_RE.test(originalPrompt)
  const hasExplicitProvider = requirements.requiredIntegrations.some(i => i === 'stripe')
  const alreadyHasPaymentNode = integrationNodes.some(n => /stripe|paypal|paddle|payment/.test(n.id))

  if (hasPaymentKeyword && !hasExplicitProvider && !alreadyHasPaymentNode) {
    const paymentsTable = tables.find(t => /order|payment|invoice|checkout/.test(t))
    integrationNodes.push({
      id:           'integration.payment_provider',
      label:        'Payment provider (not selected)',
      type:         'integration',
      phase:        intPhase,
      status:       'blocked',
      optional:     true,
      dependencies: paymentsTable ? [`schema.${paymentsTable}`] : [],
      blockedReason: {
        type:               'missing_credential',
        description:        'Payment flow planned — provider not selected',
        requiredEnvVar:     'PAYMENT_PROVIDER',
        resumeOnIntegration:'payment_provider',
        userAction:         'Type "Connect Stripe", "Connect PayPal", or "Connect Paddle" to activate checkout',
      },
    })
    console.log(`[DomainCompiler] Added generic payment_provider node (keyword detected, no explicit provider)`)
  }

  if (requirements.requiredIntegrations.includes('resend')) {
    integrationNodes.push({
      id:           'integration.resend.email',
      label:        'Email notifications (Resend)',
      type:         'integration',
      phase:        intPhase,
      status:       'blocked',
      optional:     true,
      dependencies: [],
      blockedReason: {
        type:               'missing_credential',
        description:        'Resend API key required',
        requiredEnvVar:     'RESEND_API_KEY',
        resumeOnIntegration:'resend',
        userAction:         'Paste your Resend API key (re_...) in the chat',
      },
    })
  }

  if (requirements.requiredIntegrations.includes('openai')) {
    integrationNodes.push({
      id:           'integration.openai.function',
      label:        'OpenAI AI functions',
      type:         'integration',
      phase:        intPhase,
      status:       'blocked',
      optional:     true,
      dependencies: [],
      blockedReason: {
        type:               'missing_credential',
        description:        'OpenAI API key required',
        requiredEnvVar:     'OPENAI_API_KEY',
        resumeOnIntegration:'openai',
        userAction:         'Paste your OpenAI API key (sk-...) in the chat',
      },
    })
  }

  // ── #36/#89 Auto-detect email provider need from table names ─────────────────
  // When tables like 'notifications', 'emails', 'invoices', 'newsletters' are
  // present, the build clearly needs email sending capability — but users rarely
  // say "resend" explicitly in their prompt. Without this check, the notifications
  // table gets created but nothing ever sends an email.
  // Also trigger on prompt signals: "email notification", "invoice", "newsletter".
  const EMAIL_IMPLIED_TABLE_PATTERNS = [
    /^notifications?$/,
    /^email_?logs?$/,
    /^emails?$/,
    /^invoices?$/,
    /^newsletters?$/,
    /^newsletter_subscriptions?$/,
    /^email_?campaigns?$/,
    /^mailer_?queue$/,
    /^outbound_?emails?$/,
  ]
  const hasEmailImpliedTable = tables.some(t =>
    EMAIL_IMPLIED_TABLE_PATTERNS.some(p => p.test(t))
  )
  const hasEmailPromptSignal = /\b(email\s+notification|send\s+email|invoice\s+email|newsletter|transactional\s+email|welcome\s+email|receipt)\b/i.test(originalPrompt)
  const hasEmailIntegrationAlready = integrationNodes.some(n =>
    /^integration\.(resend|sendgrid|smtp)/.test(n.id)
  )

  if ((hasEmailImpliedTable || hasEmailPromptSignal) && !hasEmailIntegrationAlready) {
    const emailDepTable = tables.find(t => EMAIL_IMPLIED_TABLE_PATTERNS.some(p => p.test(t)))
    integrationNodes.push({
      id:           'integration.resend.email',
      label:        'Email notifications (Resend / SendGrid)',
      type:         'integration',
      phase:        intPhase,
      status:       'blocked',
      optional:     true,
      dependencies: emailDepTable ? [`schema.${emailDepTable}`] : [],
      blockedReason: {
        type:               'missing_credential',
        description:        `Email provider credentials required. Your build includes email-dependent tables (${emailDepTable ?? 'notifications'}) — without an API key, no emails will ever be sent.`,
        requiredEnvVar:     'RESEND_API_KEY',
        resumeOnIntegration:'resend',
        userAction:         'Paste your Resend API key (re_...) or SendGrid key (SG...) in the chat.\nGet a free Resend key at resend.com',
        manualSteps: [
          'Option A — Resend (recommended, free tier): go to resend.com → API Keys → Create Key',
          'Paste here: resend_api_key: re_YOUR_KEY',
          'Option B — SendGrid: go to app.sendgrid.com → Settings → API Keys → Create',
          'Paste here: sendgrid_api_key: SG.YOUR_KEY',
          'Option C — SMTP: provide host/port/user/pass in chat',
        ],
      },
    })
    console.log(`[DomainCompiler] Auto-added email integration node (table: ${emailDepTable ?? 'prompt signal'})`)
  }

  if (integrationNodes.length > 0) {
    phases.push({
      number:      intPhase,
      name:        'Integrations',
      description: 'Explicitly requested integrations + their required support infrastructure',
      nodes:       integrationNodes,
    })
  }

  // ── Storage ────────────────────────────────────────────────────────────────
  const storagePhaseNum = phases.length + 1
  if (requirements.storageBucketCount > 0 || requirements.storageBucketNames.length > 0) {
    const storageNodes: BuildNode[] = []

    if (requirements.storageBucketNames.length > 0) {
      // User named explicit buckets
      for (const name of requirements.storageBucketNames) {
        const id = name.toLowerCase().replace(/\s+/g, '_')
        storageNodes.push({
          id:           `storage.${id}`,
          label:        `${name} bucket`,
          type:         'storage',
          phase:        storagePhaseNum,
          status:       'pending',
          optional:     true,
          dependencies: [],
        })
      }
    } else {
      // User gave a count but not names — derive semantic names from tables
      const defaultBucketNames = ['uploads', 'avatars', 'documents', 'media', 'attachments']
      const count = Math.min(requirements.storageBucketCount, 8)
      for (let i = 0; i < count; i++) {
        const name = defaultBucketNames[i] ?? `bucket_${i + 1}`
        storageNodes.push({
          id:           `storage.${name}`,
          label:        `${name} bucket`,
          type:         'storage',
          phase:        storagePhaseNum,
          status:       'pending',
          optional:     true,
          dependencies: [],
        })
      }
    }

    if (storageNodes.length > 0) {
      phases.push({
        number:      storagePhaseNum,
        name:        'Storage',
        description: 'Storage buckets as explicitly specified',
        nodes:       storageNodes,
      })
    }
  }

  // ── Verification ──────────────────────────────────────────────────────────
  const verPhaseNum = phases.length + 1
  const verNodes: BuildNode[] = []

  if (needsAuth) {
    verNodes.push({
      id:           'verification.auth',
      label:        'Auth verification',
      type:         'verification',
      phase:        verPhaseNum,
      status:       'pending',
      dependencies: ['auth.jwt'],
    })
  }
  if (tables.length > 0) {
    verNodes.push({
      id:           'verification.apis',
      label:        'API verification',
      type:         'verification',
      phase:        verPhaseNum,
      status:       'pending',
      dependencies: [`flow.${tables[0]}_apis`],
    })
  }

  if (verNodes.length > 0) {
    phases.push({
      number:      verPhaseNum,
      name:        'Verification',
      description: 'Post-build verification against real state',
      nodes:       verNodes,
    })
  }

  return phases
}

/**
 * Create a Plan-only BuildJob (non-mutating preview).
 */
export async function compilePlanJob(
  prompt: string,
  ctx: BuildContext,
): Promise<BuildJob> {
  const job = await compileBuildJob(prompt, ctx)
  job.planOnly = true
  return job
}

// ── Entity Extraction (LLM) ───────────────────────────────────────────────────

// ── Column-Level Prompt Parsing ───────────────────────────────────────────────

export interface PromptColumn {
  name: string
  type: string
  /** e.g. 'pending/processing/shipped' → becomes a CHECK constraint */
  enumValues?: string[]
  unique?: boolean
  required?: boolean
  foreignKey?: string  // e.g. 'categories'
}

export interface PromptEntitySchema {
  tableName: string
  columns: PromptColumn[]
  /** True when the entity description mentions guest/no-auth checkout (no user_id) */
  guestMode?: boolean
}

/**
 * Parse column specifications from a user's detailed prompt.
 * Handles formats like:
 *   - "price (numeric 10,2)"
 *   - "status (pending/processing/shipped/delivered/cancelled)"
 *   - "slug (unique)"
 *   - "category_id (FK → categories)"
 *   - "featured (boolean)"
 *   - "customer_name, customer_email" (on orders = guest mode)
 *
 * Returns a map of tableName → PromptEntitySchema.
 * Falls back to empty map if the prompt is not detailed enough.
 */
export async function extractDetailedSchema(prompt: string): Promise<Map<string, PromptEntitySchema>> {
  const result = new Map<string, PromptEntitySchema>()
  const lower = prompt.toLowerCase()

  // ── Guest checkout detection ────────────────────────────────────────────────
  const guestOrderMode = /customer_name|customer_email|guest.{0,20}checkout|no.{0,10}auth|without.{0,10}login/i.test(prompt)

  // ── LLM-based column extraction (best effort) ────────────────────────────────
  // Only call if the prompt is detailed enough to have column specs
  const hasColumnSpec = /\(.*?\)/.test(prompt) || /\bcolumn|field|attribute|property\b/i.test(prompt)
  if (!hasColumnSpec && !guestOrderMode) return result

  try {
    const { getOpenAIClient } = await import('../openai-service')
    const { getModel } = await import('../model-router')
    const openai = getOpenAIClient()

    const response = await openai.chat.completions.create({
      model: getModel('classify'),
      messages: [
        {
          role: 'system',
          content: `Extract database table schemas from a backend specification.
Return JSON: { "tables": [ { "tableName": "...", "guestMode": boolean, "columns": [ { "name": "...", "type": "TEXT|INTEGER|DECIMAL|BOOLEAN|UUID|TIMESTAMP|JSONB|SERIAL", "enumValues": ["val1","val2"] | null, "unique": boolean, "required": boolean, "foreignKey": "tablename" | null } ] } ] }

Rules:
- Map "numeric(10,2)" → DECIMAL
- Map "serial" / "auto-increment" → SERIAL (do not include as a column — it means auto-PK)
- Map "boolean" / "bool" → BOOLEAN
- Map "text" / "varchar" / "string" → TEXT
- Map "integer" / "int" → INTEGER
- Map "timestamp" → TIMESTAMP
- Map "jsonb" / "json" → JSONB
- "status (pending/processing/...)" → type TEXT, enumValues: ["pending","processing",...]
- "FK → categories" → foreignKey: "categories"
- "(unique)" → unique: true
- If orders table has customer_name or customer_email → set guestMode: true
- Omit "id", "created_at", "updated_at" — those are auto-added
- Return only tables that have explicit column specs in the prompt
- Return empty tables array if no column specs found`,
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
    })

    const raw = JSON.parse(response.choices[0].message.content || '{"tables":[]}')
    const tables: any[] = Array.isArray(raw.tables) ? raw.tables : []

    for (const t of tables) {
      if (!t.tableName || !Array.isArray(t.columns)) continue
      const cols: PromptColumn[] = t.columns
        .filter((c: any) => c.name && c.type)
        .map((c: any) => ({
          name: String(c.name).toLowerCase(),
          type: String(c.type).toUpperCase(),
          ...(c.enumValues?.length ? { enumValues: c.enumValues.map(String) } : {}),
          ...(c.unique ? { unique: true } : {}),
          ...(c.required ? { required: true } : {}),
          ...(c.foreignKey ? { foreignKey: String(c.foreignKey) } : {}),
        }))

      result.set(t.tableName.toLowerCase(), {
        tableName: t.tableName.toLowerCase(),
        columns: cols,
        guestMode: t.guestMode ?? (t.tableName === 'orders' && guestOrderMode),
      })
    }
  } catch {
    // LLM failed — use heuristic fallback
    if (guestOrderMode) {
      result.set('orders', {
        tableName: 'orders',
        columns: [],
        guestMode: true,
      })
    }
  }

  // Always mark orders as guest mode if detected, even if LLM didn't include it
  if (guestOrderMode && !result.has('orders')) {
    result.set('orders', { tableName: 'orders', columns: [], guestMode: true })
  } else if (guestOrderMode && result.has('orders')) {
    result.get('orders')!.guestMode = true
  }

  return result
}

async function extractEntities(prompt: string): Promise<string[]> {
  // Always run the deterministic parser first — it's fast and handles explicit lists.
  const deterministicEntities = extractEntitiesFromExplicitList(prompt)

  try {
    const openai = getOpenAIClient()
    const response = await openai.chat.completions.create({
      model: getModel('classify'),
      messages: [
        {
          role: 'system',
          content: `Extract database table names from a backend build request.
Return ONLY a JSON array of lowercase snake_case table names.
Always include "users" if the app has accounts.
Order by dependency (referenced tables first).
Maximum 10 tables.
Example: ["users", "posts", "comments", "likes"]`,
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 150,
      response_format: { type: 'json_object' },
    })
    const raw = JSON.parse(response.choices[0].message.content || '{"tables":[]}')
    const llmTables: string[] = Array.isArray(raw) ? raw : (raw.tables ?? [])
    const filtered = llmTables
      .filter((t): t is string => typeof t === 'string')
      .map(t => t.toLowerCase().replace(/\s+/g, '_'))
      .slice(0, 10)

    // Merge LLM results with deterministic results: explicit list takes precedence
    // but LLM may add entities implied by context that the list parser missed.
    const merged = [...new Set([...deterministicEntities, ...filtered])]
    return merged.length > 0 ? merged : extractEntitiesHeuristic(prompt)
  } catch {
    // Fallback: deterministic parser first, then keyword heuristic
    return deterministicEntities.length > 0 ? deterministicEntities : extractEntitiesHeuristic(prompt)
  }
}

function extractEntitiesHeuristic(prompt: string): string[] {
  // First: try the deterministic list parser (handles bullet/numbered explicit lists)
  const explicit = extractEntitiesFromExplicitList(prompt)
  if (explicit.length > 0) return explicit

  const tables: string[] = []
  const lower = prompt.toLowerCase()

  if (/\buser|account|member|person\b/.test(lower)) tables.push('users')
  if (/\bstore|vendor|seller|merchant|shop\b/.test(lower)) tables.push('stores')
  if (/\bpost|article|content|blog\b/.test(lower)) tables.push('posts')
  if (/\bcomment|reply\b/.test(lower)) tables.push('comments')
  if (/\bproduct|listing|item\b/.test(lower)) tables.push('products')
  if (/\border\b/.test(lower)) tables.push('orders')
  if (/\border.?item|line.?item\b/.test(lower)) tables.push('order_items')
  if (/\breview|rating\b/.test(lower)) tables.push('reviews')
  if (/\bcart\b/.test(lower)) tables.push('carts')
  if (/\bcart.?item|item.?in.?cart\b/.test(lower)) tables.push('cart_items')
  if (/\bwishlist|wish.?list\b/.test(lower)) tables.push('wishlists')
  if (/\bcategory|categor\b/.test(lower)) tables.push('categories')
  if (/\bmessage|chat\b/.test(lower)) tables.push('messages')
  if (/\btask|todo\b/.test(lower)) tables.push('tasks')
  if (/\bnote\b/.test(lower)) tables.push('notes')
  if (/\bworkspace|team\b/.test(lower)) tables.push('workspaces')
  if (/\bpayment|invoice|transaction\b/.test(lower)) tables.push('payments')

  // Never return a single generic fallback for prompts that contain explicit "build" intent
  // with specific entity words — return what we found even if sparse, but never 'items'
  // for a prompt that clearly lists tables.
  return tables.length > 0 ? tables : []
}

// ── Integration Detection ─────────────────────────────────────────────────────

async function augmentWithIntegrations(
  phases: BuildPhase[],
  prompt: string,
): Promise<BuildPhase[]> {
  const lower = prompt.toLowerCase()
  const integrationPhase: BuildPhase = {
    number: Math.max(...phases.map(p => p.number)) + 1,
    name: 'Integrations',
    nodes: [],
  }

  if (/\bstripe|payment|checkout|billing\b/.test(lower)) {
    const ordersPhaseNode = phases
      .flatMap(p => p.nodes)
      .find(n => n.type === 'schema' && /order/.test(n.id))

    integrationPhase.nodes.push({
      id: 'integration.stripe.checkout',
      label: 'Stripe checkout',
      type: 'integration',
      phase: integrationPhase.number,
      status: 'blocked',
      dependencies: ordersPhaseNode ? [ordersPhaseNode.id] : [],
      optional: true,
      blockedReason: {
        type: 'missing_credential',
        description: 'Stripe secret key required',
        requiredEnvVar: 'STRIPE_SECRET_KEY',
        resumeOnIntegration: 'stripe',
        userAction: 'Paste your Stripe secret key (sk_live_... or sk_test_...) in the chat',
      },
    })
    integrationPhase.nodes.push({
      id: 'integration.stripe.webhook',
      label: 'Stripe webhook handler',
      type: 'integration',
      phase: integrationPhase.number,
      status: 'blocked',
      dependencies: ['integration.stripe.checkout'],
      optional: true,
      blockedReason: {
        type: 'missing_credential',
        description: 'Stripe webhook secret required',
        requiredEnvVar: 'STRIPE_WEBHOOK_SECRET',
        resumeOnIntegration: 'stripe_webhook',
        userAction: 'Paste your Stripe webhook signing secret',
      },
    })
  }

  // Email provider: triggered by explicit prompt words OR by schema node names that
  // imply email-sending (notifications, invoices, newsletters, email_logs, etc.)
  const schemaNodeIds = phases.flatMap(p => p.nodes).filter(n => n.type === 'schema').map(n => n.id)
  const emailImpliedBySchema = schemaNodeIds.some(id =>
    /\.(notifications?|email_?logs?|emails?|invoices?|newsletters?|email_?campaigns?)$/.test(id)
  )
  const alreadyHasEmailNode = integrationPhase.nodes.some(n => /^integration\.(resend|sendgrid|smtp)/.test(n.id))

  if ((/\bresend|email|sendgrid|smtp|notification\b/.test(lower) || emailImpliedBySchema) && !alreadyHasEmailNode) {
    integrationPhase.nodes.push({
      id: 'integration.resend.email',
      label: 'Email notifications (Resend / SendGrid)',
      type: 'integration',
      phase: integrationPhase.number,
      status: 'blocked',
      dependencies: [],
      optional: true,
      blockedReason: {
        type: 'missing_credential',
        description: emailImpliedBySchema
          ? 'Email provider credentials required — your schema includes notification/invoice tables that need email sending to function.'
          : 'Email provider API key required',
        requiredEnvVar: 'RESEND_API_KEY',
        resumeOnIntegration: 'resend',
        userAction: 'Paste your Resend API key (re_...) or SendGrid key (SG...) in the chat',
        manualSteps: [
          'Option A — Resend (free tier): go to resend.com → API Keys → Create Key, paste: resend_api_key: re_YOUR_KEY',
          'Option B — SendGrid: go to app.sendgrid.com → Settings → API Keys, paste: sendgrid_api_key: SG.YOUR_KEY',
        ],
      },
    })
  }

  if (/\bopenai|ai function|artificial intelligence\b/.test(lower)) {
    integrationPhase.nodes.push({
      id: 'integration.openai.function',
      label: 'OpenAI AI function',
      type: 'integration',
      phase: integrationPhase.number,
      status: 'blocked',
      dependencies: [],
      optional: true,
      blockedReason: {
        type: 'missing_credential',
        description: 'OpenAI API key required',
        requiredEnvVar: 'OPENAI_API_KEY',
        resumeOnIntegration: 'openai',
        userAction: 'Paste your OpenAI API key (sk-...) in the chat',
      },
    })
  }

  if (integrationPhase.nodes.length > 0) {
    return [...phases, integrationPhase]
  }
  return phases
}

// ── Storage Phase Generation ──────────────────────────────────────────────────

/**
 * Detect file/media needs in the prompt and inject storage buckets accordingly.
 * Storage is only created when at least one entity has upload/file/media needs.
 * Buckets are named after what the prompt actually describes — not generic defaults.
 */
function augmentWithStorage(
  phases: BuildPhase[],
  prompt: string,
  entities: string[],
): BuildPhase[] {
  const lower = prompt.toLowerCase()
  // "uploads" (plural), "bucket" itself, and all standard file-type words count as storage signals
  const hasFileNeeds = /\b(images?|photos?|files?|uploads?|media|avatars?|documents?|attachments?|videos?|pdf|certificate|logo|thumbnails?|buckets?)\b/.test(lower)
  if (!hasFileNeeds) return phases

  // Derive bucket names from entities that likely have media/file associations
  const storageNodes: BuildNode[] = []
  const fileEntityPatterns: Array<[RegExp, string, string]> = [
    [/\b(product|listing|item|boat|vehicle|property|course)\b/, `${entities.find(e => /product|listing|boat|vehicle|property|course/.test(e)) ?? 'listing'}_images`, 'Listing images bucket'],
    [/\b(avatar|profile|user)\b/, 'avatars', 'User avatars bucket'],
    [/\b(document|certificate|license|pdf|attachment)\b/, 'documents', 'Documents bucket'],
    [/\b(video|recording|media)\b/, 'videos', 'Video/media bucket'],
    [/\b(logo|brand)\b/, 'logos', 'Logos bucket'],
  ]

  const phaseNumber = Math.max(...phases.map(p => p.number)) + 1
  for (const [pattern, bucketName, label] of fileEntityPatterns) {
    if (pattern.test(lower)) {
      storageNodes.push({
        id: `storage.${bucketName}`,
        label,
        type: 'storage',
        phase: phaseNumber,
        status: 'pending',
        dependencies: [],
        optional: true,
      })
    }
  }

  if (storageNodes.length === 0) return phases

  return [...phases, { number: phaseNumber, name: 'Storage', description: 'File storage buckets derived from entity needs', nodes: storageNodes }]
}

// ── Prompt Column Injection ───────────────────────────────────────────────────

/**
 * Inject parsed column specs from the user's prompt into schema nodes.
 * When a schema node's table name matches a parsed entity, we store
 * the columns (and constraints) in executionParams so node-executor
 * uses them instead of the built-in blueprint.
 */
function injectPromptColumns(
  phases: BuildPhase[],
  detailedSchema: Map<string, PromptEntitySchema>,
): BuildPhase[] {
  return phases.map(phase => ({
    ...phase,
    nodes: phase.nodes.map(node => {
      if (node.type !== 'schema') return node
      const tableName = node.id.replace(/^schema\./, '')
      const parsed = detailedSchema.get(tableName)
      if (!parsed) return node

      // Build column definitions from parsed spec
      const columns = parsed.columns.map(col => ({
        name: col.name,
        type: col.type,
        ...(col.enumValues?.length ? { enumValues: col.enumValues } : {}),
        ...(col.unique ? { unique: true } : {}),
        ...(col.required ? { required: true } : {}),
        ...(col.foreignKey ? { foreignKey: col.foreignKey } : {}),
      }))

      return {
        ...node,
        executionParams: {
          ...node.executionParams,
          columns: columns.length > 0 ? columns : node.executionParams?.columns,
          guestMode: parsed.guestMode ?? node.executionParams?.guestMode,
          promptDriven: true,
        },
      }
    }),
  }))
}

// ── Schema Node Replacement ───────────────────────────────────────────────────

/**
 * Replace the hardcoded schema nodes in a domain template with LLM-extracted
 * entities. Structural nodes (auth, permissions, flows, integrations, functions,
 * verification) are preserved from the template; only schema nodes are replaced.
 *
 * This ensures the phase architecture reflects what the user actually described
 * rather than a fixed domain blueprint.
 */
function replaceSchemaNodesWithEntities(
  templatePhases: BuildPhase[],
  entities: string[],
): BuildPhase[] {
  if (entities.length === 0) return templatePhases

  // Build new schema nodes from LLM-extracted entities
  const schemaNodes: BuildNode[] = entities.map((entity, i) => ({
    id: `schema.${entity}`,
    label: `${entity} table`,
    type: 'schema' as const,
    phase: 1,
    status: 'pending' as const,
    // users is typically the anchor — others depend on it if it exists
    dependencies: i > 0 && entities.includes('users') && entity !== 'users'
      ? ['schema.users']
      : [],
  }))

  // Find the Core Schema phase and replace its nodes; keep all other phases
  return templatePhases.map(phase => {
    if (phase.name === 'Core Schema') {
      return { ...phase, nodes: schemaNodes }
    }
    return phase
  })
}

// ── Phase Pruning ─────────────────────────────────────────────────────────────

function pruneIrrelevantPhases(
  phases: BuildPhase[],
  prompt: string,
  _domain: Domain,
): BuildPhase[] {
  const lower = prompt.toLowerCase()
  const hasFileNeeds = /\b(image|photo|file|upload|media|avatar|document|attachment|video|pdf|certificate)\b/.test(lower)

  return phases.map(phase => {
    // Prune storage nodes if the prompt doesn't mention file/media needs
    if (phase.name === 'Storage' && !hasFileNeeds) {
      return { ...phase, nodes: phase.nodes.filter(n => n.type !== 'storage') }
    }
    return phase
  }).filter(p => p.nodes.length > 0)
}

// ── Integration Credential Marking ───────────────────────────────────────────

/**
 * Check which integrations have credentials available.
 * Integration nodes without credentials are kept as 'blocked'.
 * Integration nodes WITH credentials are set to 'pending' so they execute.
 */
function markIntegrationsBlocked(
  phases: BuildPhase[],
  availableSecrets: string[],
): BuildPhase[] {
  const secretsUpper = availableSecrets.map(s => s.toUpperCase())

  return phases.map(phase => ({
    ...phase,
    nodes: phase.nodes.map(node => {
      if (node.type !== 'integration') return node
      if (node.status !== 'blocked') return node

      const requiredEnvVar = node.blockedReason?.requiredEnvVar
      if (requiredEnvVar && secretsUpper.includes(requiredEnvVar.toUpperCase())) {
        // Credential is available — unblock this node
        return { ...node, status: 'pending', blockedReason: undefined }
      }
      return node
    }),
  }))
}

// ── Original Prompt Injection ─────────────────────────────────────────────────

/**
 * Inject the user's original prompt into every schema node's executionParams.
 * This allows node-executor's LLM column generator to produce domain-appropriate
 * columns for tables that aren't in the static blueprint (e.g. generation_jobs,
 * video_projects, render_tasks for a "3D Video Generation SaaS").
 */
function injectOriginalPrompt(phases: BuildPhase[], prompt: string): BuildPhase[] {
  const truncatedPrompt = prompt.slice(0, 500) // keep it short for the LLM call
  return phases.map(phase => ({
    ...phase,
    nodes: phase.nodes.map(node => {
      if (node.type !== 'schema') return node
      return {
        ...node,
        executionParams: {
          ...node.executionParams,
          originalPrompt: truncatedPrompt,
        },
      }
    }),
  }))
}

// ── Semantic Enrichment Injection ────────────────────────────────────────────

/**
 * Inject semantic enrichment (state machines, business rules, workflows) into
 * every schema node's executionParams. The node-executor passes this to the LLM
 * when generating column schemas, API functions, and transitions.
 *
 * Also stamps each schema node with its detected table purpose so downstream
 * generators can pick purpose-appropriate column blueprints.
 */
function injectSemanticEnrichment(
  phases: BuildPhase[],
  enrichmentBlock: string,
  purposes: Record<string, import('../semantic-domain-analyzer').TablePurposeResult>,
): BuildPhase[] {
  return phases.map(phase => ({
    ...phase,
    nodes: phase.nodes.map(node => {
      if (node.type !== 'schema') return node
      const tableName = node.id.replace(/^schema\./, '')
      const purposeResult = purposes[tableName]
      return {
        ...node,
        executionParams: {
          ...node.executionParams,
          semanticEnrichment: enrichmentBlock,
          ...(purposeResult ? {
            tablePurpose:           purposeResult.purpose,
            stateMachine:           purposeResult.stateMachine,
            recommendedEndpoints:   purposeResult.recommendedEndpoints,
          } : {}),
        },
      }
    }),
  }))
}

// ── Goal Summary ──────────────────────────────────────────────────────────────

/**
 * Schema-based storage auto-detection (#72).
 *
 * Inspects all schema nodes for columns whose names suggest file storage
 * (fileUrl, avatarUrl, thumbnailUrl, videoUrl, imageUrl, logoUrl, etc.).
 * For each distinct bucket type detected, auto-provisions a storage bucket
 * node — only if that bucket doesn't already exist in any storage phase.
 *
 * Column → bucket mapping:
 *   avatarUrl / profilePicture / profilePhoto → avatars  (public_read)
 *   thumbnailUrl / coverImage / bannerUrl      → thumbnails (cdn_cacheable)
 *   videoUrl / recordingUrl                    → videos  (private)
 *   fileUrl / attachmentUrl / documentUrl      → documents (private)
 *   imageUrl / photoUrl / pictureUrl            → images  (public_read)
 *   logoUrl / brandLogoUrl                      → logos   (public_read)
 *   audioUrl                                    → audio   (private)
 */
function injectSchemaBasedStorageBuckets(
  phases: BuildPhase[],
  detailedSchema: Map<string, PromptEntitySchema>,
  schemaNodes: BuildNode[],
): BuildPhase[] {
  // Map column-name patterns to bucket config
  const COLUMN_BUCKET_MAP: Array<{
    pattern: RegExp
    bucket: string
    label: string
    accessPolicy: string
  }> = [
    { pattern: /^(avatar|profile_?pic|profile_?photo|profile_?image)_?url$/i, bucket: 'avatars',   label: 'User avatars bucket',    accessPolicy: 'public_read' },
    { pattern: /^(thumbnail|cover_?image|banner|hero_?image)_?url$/i,         bucket: 'thumbnails', label: 'Thumbnails bucket',       accessPolicy: 'cdn_cacheable' },
    { pattern: /^(video|recording|clip)_?url$/i,                               bucket: 'videos',     label: 'Videos bucket',          accessPolicy: 'private' },
    { pattern: /^(file|attachment|document|pdf)_?url$/i,                       bucket: 'documents',  label: 'Documents bucket',       accessPolicy: 'private' },
    { pattern: /^(image|photo|picture|img)_?url$/i,                            bucket: 'images',     label: 'Images bucket',          accessPolicy: 'public_read' },
    { pattern: /^(logo|brand_?logo)_?url$/i,                                   bucket: 'logos',      label: 'Logos bucket',           accessPolicy: 'public_read' },
    { pattern: /^(audio|sound|track|waveform)_?url$/i,                         bucket: 'audio',      label: 'Audio files bucket',     accessPolicy: 'private' },
  ]

  // Collect all column names across all schema nodes
  const allColumns: string[] = []
  for (const node of schemaNodes) {
    const tableName = node.id.replace(/^schema\./, '')
    const schema = detailedSchema.get(tableName)
    if (schema?.columns) {
      allColumns.push(...schema.columns.map((c) => c.name))
    }
    // Also check executionParams.columns (blueprint path)
    const bpCols = node.executionParams?.columns as Array<{ name: string }> | undefined
    if (Array.isArray(bpCols)) {
      allColumns.push(...bpCols.map((c) => c.name))
    }
  }

  // Determine which buckets already exist in storage phases
  const existingBuckets = new Set<string>()
  for (const phase of phases) {
    for (const node of phase.nodes) {
      if (node.type === 'storage') {
        existingBuckets.add(node.id.replace(/^storage\./, ''))
      }
    }
  }

  // Detect which buckets we need based on column names
  const detected: Array<{ bucket: string; label: string; accessPolicy: string }> = []
  const seenBuckets = new Set<string>()
  for (const col of allColumns) {
    for (const mapping of COLUMN_BUCKET_MAP) {
      if (mapping.pattern.test(col) && !existingBuckets.has(mapping.bucket) && !seenBuckets.has(mapping.bucket)) {
        detected.push(mapping)
        seenBuckets.add(mapping.bucket)
        console.log(`[DomainCompiler] Schema-based storage: column "${col}" → auto-provisioning "${mapping.bucket}" bucket (${mapping.accessPolicy})`)
      }
    }
  }

  if (detected.length === 0) return phases

  const phaseNum = Math.max(...phases.map((p) => p.number)) + 1
  const storageNodes: BuildNode[] = detected.map((d) => ({
    id:           `storage.${d.bucket}`,
    label:        d.label,
    type:         'storage',
    phase:        phaseNum,
    status:       'pending',
    optional:     true,
    dependencies: [],
    executionParams: { accessPolicy: d.accessPolicy },
  }))

  return [
    ...phases,
    {
      number:      phaseNum,
      name:        'Storage (schema-detected)',
      description: `Storage buckets auto-provisioned from file URL columns in schema: ${detected.map((d) => d.bucket).join(', ')}`,
      nodes:       storageNodes,
    },
  ]
}

function summarizeGoal(prompt: string, domain: Domain): string {
  const domainLabel: Record<Domain, string> = {
    ecommerce:   'ecommerce backend',
    saas:        'SaaS backend',
    marketplace: 'marketplace backend',
    social:      'social platform backend',
    'ai-saas':   'AI SaaS backend',
    fintech:     'fintech backend',
    media:       'media platform backend',
    messaging:   'messaging backend',
    gaming:      'gaming backend',
    generic:     'backend',
  }
  const truncated = prompt.length > 120 ? prompt.slice(0, 120) + '...' : prompt
  return `${domainLabel[domain] ?? 'backend'}: ${truncated}`
}

// ── Prompt Classifier ─────────────────────────────────────────────────────────

/**
 * Classify if a message is a "serious build request" that should go through
 * the new build runtime (vs. a simple modification handled by the old path).
 *
 * Returns true for:
 *  - Explicit domain requests: "build ecommerce backend", "create saas"
 *  - Multi-entity compound requests of substantial length
 *  - "Build me a production-ready ..."
 */
export function isSeriousBuildRequest(message: string): boolean {
  const lower = message.toLowerCase()
  const trimmed = message.trim()

  // ─── HARD QUESTION GUARD (placed FIRST — gates every keyword match below) ──
  // Without this guard, "does any other integration features needed for making
  // the social media backend production grade??" matches the "social media"
  // keyword on line 1729 and returns true — bypassing the mode classifier and
  // every other intent check, forcing the build runtime to run on a question.
  // The runtime then hallucinates entities ("products", "video/media bucket")
  // from the question's keywords.
  //
  // A message phrased as a question or needs-assessment is NEVER a serious
  // build request. The user can hit the explicit Build button if they want one.
  const endsWithQuestion = trimmed.endsWith('?')
  const startsWithQuestionWord =
    /^(is|are|do|does|did|will|would|can|could|should|what|how|which|where|why|have|has|had|any|am|were|may|might|tell|show|list|help|explain)\b/i.test(trimmed)
  const isConsultativePhrase =
    /\b(needed|required|necessary|missing|recommended|sufficient)\s+(for|to)\b/i.test(trimmed) ||
    /\b(production[- ]grade|production[- ]ready|prod[- ]ready)\??$/i.test(trimmed) ||
    /\b(is|are|does|do)\s+(it|this|that|there|any|anything|something|enough)?\s*(other\s+|more\s+|else\s+)?\w*\s*(needed|required|necessary|missing|recommended)\b/i.test(trimmed) ||
    /\b(what\s+(else|other|all|more)\s+(do|should|would|could)\s+(i|we)\s+(need|require|add|include))/i.test(trimmed) ||
    /\b(do|does)\s+(i|we|the (app|backend|platform|project))\s+(need|require)\b/i.test(trimmed)

  if (endsWithQuestion || startsWithQuestionWord || isConsultativePhrase) {
    return false
  }

  // Explicit domain keywords — domain name alone is enough to classify as serious.
  // NOTE: "production-ready" is NOT in this list because "Is this production-ready?"
  // is an evaluation question, not a build request. Use the build-verb checks below
  // to detect "build me a production-grade backend" variants.
  if (/\b(ecommerce|e-commerce|saas|marketplace|social\s+media|social\s+network|ai[\s-]saas|fintech|video\s+streaming|media\s+platform|gaming\s+platform|chat\s+app|messaging\s+app|full[\s-]?stack\s+backend|complete\s+backend|entire\s+backend)\b/.test(lower)) {
    return true
  }

  // Build verb + quality adjective (production-grade, production-ready, complete, etc.) + backend noun.
  // This is a permissive match: "build me a production-grade backend for a blog platform" ✓
  if (
    /\b(build|create|make|set[\s-]?up|generate|spin[\s-]?up)\b.{0,40}\b(production[-\s]?grade|production[-\s]?ready|complete|full|entire|robust|scalable|serious|real|proper)\b.{0,40}\b(backend|system|platform|app|application|api|service)\b/.test(lower) &&
    message.length > 40
  ) {
    return true
  }

  // Build verb immediately followed by (optional article/pronoun) + backend noun.
  // Covers: "build a backend", "create the platform", "make me an API" — simple but explicit.
  if (
    /\b(build|create|make|set[\s-]?up|generate|spin[\s-]?up) (a|an|me|us|the)?\s*(backend|system|platform|api|service)\b/.test(lower) &&
    message.length > 40
  ) {
    return true
  }

  // Multi-entity requests ("users, products, orders, ...") with backend context
  const commaCount = (message.match(/,/g) || []).length
  if (commaCount >= 2 && /\b(backend|api|database|table|schema)\b/.test(lower)) {
    return true
  }

  // Additive entity requests: "Add wishlist and cart support", "Add notifications feature"
  // These create new tables — they are incremental build requests, not schema modifications.
  // Excluded: "add column/field/attribute/index" which are schema modifications, not new tables.
  const ADDITIVE_ENTITY_NOUNS_RE =
    /\b(wishlist|cart|notification|review|comment|message|booking|subscription|invitation|coupon|badge|achievement|report|analytic|activity|feed|follower|tag|favorite|like|rating|referral|wallet|ticket|event|schedule|appointment|resource|thread|reply|reaction|mention|story|reel|playlist|album|order|product|store|vendor|payment|invoice|challenge|leaderboard|presence|channel)\b/i
  if (/\badd\b/.test(lower) && ADDITIVE_ENTITY_NOUNS_RE.test(lower) &&
      !/\b(column|field|attribute|index|constraint|row|record)\b/.test(lower)) {
    return true
  }

  return false
}
