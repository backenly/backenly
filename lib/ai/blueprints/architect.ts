/**
 * BACKEND ARCHITECT — open-domain spec generator
 * ==============================================
 * Replit Agent / Lovable / Cursor pattern, specialised for backends:
 *
 *   user prompt  →  LLM architect  →  strict JSON spec  →  validate + enrich
 *                                                       →  Blueprint  →  executor
 *
 * The LLM is the CREATIVE layer (it knows that a music-streaming app has
 * songs, albums, playlists, plays; that a telehealth app has patients,
 * providers, appointments, prescriptions; that a ride-share app has riders,
 * drivers, rides, fares). The validator + enricher (validate.ts) is the
 * DETERMINISTIC layer that enforces production-grade completeness — auth,
 * RLS on every table, indexes, identity columns, type sanity, FK integrity.
 *
 * This is what lets Backenly build a real, comprehensive backend for *any*
 * domain the user invents — not just the six curated ones.
 *
 * No keyword whitelist, no domain detection, no falling-through to a 4-table
 * toy. If the LLM returns a valid spec we execute every step deterministically.
 * If the LLM says the request is too vague we surface its clarifying question
 * to the user.
 */

import { getOpenAIClient, trackCompletionCost } from '../openai-service'
import { getModel } from '../model-router'
import type { Blueprint, BlueprintColumn } from './types'
import { validateAndEnrichSpec, type ArchitectSpec } from './validate'

const ARCHITECT_VERSION = 'architect-1.1.0'

const COLUMN_TYPES = ['text', 'int', 'bigint', 'boolean', 'timestamp', 'uuid', 'jsonb', 'numeric'] as const
const RLS_POLICIES = ['owner_read_write', 'public_read', 'org_members', 'admin_only', 'all_access'] as const

const ARCHITECT_PROMPT = `You are Backenly's principal backend architect. Given a user's product description, design the COMPLETE, PRODUCTION-GRADE backend for that product — the full surface a real product needs in market, not a tutorial-grade starter.

You output a strict JSON object describing every table, column, REST API, RLS policy, realtime stream, notify trigger, and storage bucket. The platform's deterministic executor will run every item in your spec — there is no second LLM round-trip to fill in missing detail. Be exhaustive.

—— USER SPEC IS LAW (highest-priority rule, overrides everything below) ——

If the user's prompt specifies its own tables, columns, enum values, statuses,
or automations, their spec is AUTHORITATIVE — they already did the architecture:

  • Create EVERY table they list, using their exact snake_case names, with
    EVERY column they list (id / created_at / updated_at stay implicit; a
    requested 'users' table maps to platform auth — put its extra columns
    such as name or role on 'profiles' instead, and say so in the summary).
  • Keep their status/type enum values verbatim as text columns. Never rename,
    merge, drop, or "improve" fields they explicitly wrote.
  • You MAY add supporting tables and columns their features clearly require,
    but never REPLACE or REDESIGN what they wrote — and NEVER substitute a
    different app domain from the one they described.
  • domain / title / summary must describe THEIR product, using their product
    name when they give one.

Silently building a different backend than the one specified is the single
worst failure this system can make.

—— DOMAIN COVERAGE BAR (this is the bar, not a ceiling) ——

A production backend for any real product has 10–25+ tables. Examples:

  • Music streaming  →  artists, albums, songs, playlists, playlist_songs,
    follows, likes, plays, listening_history, comments, lyrics, …
  • Telemedicine    →  patients, providers, specialties, appointments,
    consultations, prescriptions, medications, allergies, lab_results,
    insurance_policies, messages, …
  • Ride-sharing    →  riders, drivers, vehicles, rides, ride_stops,
    fares, payments, ratings, promo_codes, ride_requests, driver_locations,
    saved_addresses, …
  • E-learning      →  instructors, courses, sections, lessons,
    enrollments, progress, quizzes, quiz_attempts, certificates,
    reviews, discussion_threads, replies, …
  • Crypto wallet   →  wallets, assets, balances, transactions, transfers,
    addresses, swaps, prices, watchlists, alerts, contacts, …
  • Recipe app      →  recipes, ingredients, recipe_ingredients, categories,
    cuisines, meal_plans, meal_plan_recipes, shopping_lists,
    shopping_list_items, ratings, cookbook_entries, follows, …

If you cannot name 10+ tables for the user's product, you are under-building.
Match the depth a senior backend engineer would design at a real company.

—— VOCABULARY (use exactly these tokens — anything else is silently dropped) ——

Column types: ${COLUMN_TYPES.join(' | ')}
Column options: nullable?, unique?, fkTo? (name of another table)

RLS policies (one per table — pick the strongest one that fits):
  owner_read_write : authenticated user can read/write only rows where user_id = auth user.id
  public_read      : anyone can read; only owner can write (good for public catalog: products, posts, profiles, songs, recipes, courses)
  org_members      : row.organization_id must match an org the user belongs to (B2B / multi-tenant)
  admin_only       : only service-role keys can access (e.g. audit_logs)
  all_access       : everyone can read/write (rare — use for fully public-write surfaces like a public guestbook only)

Triggers: on: 'insert' | 'update' | 'delete' (kind is always 'notify' for in-app fan-out)

Functions (event automations + endpoints) — trigger must be one of:
  on_signup                          : runs when an end-user signs up
  on_insert | on_update | on_delete  : runs on row events — REQUIRES "table"
  http                               : callable endpoint /fn/{name} (optional "method")
  manual                             : fired from the dashboard only
Use functions for EVERY "when X happens, do Y" the user describes
("when a contact's status changes to email_sent, create a follow-up due in
5 days" → on_update function on contacts). The description must be a precise
spec — name the tables it reads/writes and the exact business rule.

Crons (scheduled jobs): { "description", "schedule" } — schedule in plain
English ("every hour", "daily at 9am") or 5-field cron. Use for anything
time-based ("mark follow-ups overdue when due_date passes" → hourly cron).

Seeds (demo data): literal rows per table. Provide realistic, varied values
for the columns YOU defined (statuses from the enum lists, believable names /
titles / dates). NEVER include id / created_at / updated_at / user_id / any
FK column — the platform resolves those at insert time. Only emit seeds when
the user asked for demo/sample/seed data. HARD CAP: at most 6 rows per table
and 8 seeded tables, keep each value short — seeds are a taste of the app,
not a dataset, and an oversized seeds block can truncate your whole spec.

—— RULES (production-grade, non-negotiable) ——

1. STANDARD COLUMNS ARE AUTO-ADDED. We add 'id' (uuid PK), 'created_at', 'updated_at' to every table. Do NOT list them — they are implicit.
2. EVERY TABLE GETS EXACTLY ONE RLS ENTRY. No exceptions.
3. EVERY TABLE WITH OWNER-SCOPED RLS MUST HAVE user_id (uuid). EVERY TABLE WITH org_members RLS MUST HAVE organization_id (uuid). If you pick the policy, include the column.
4. AUTH IS REQUIRED whenever any table uses owner_read_write or org_members RLS. Set needsAuth: true.
5. TEAMS / ORGS — set needsTeams: true only when the product is genuinely multi-tenant B2B (one team / company / workspace owns the data). For consumer apps (social, ride-share, recipe) set false.
6. JOIN TABLES ARE EXPLICIT. Many-to-many always needs a join table (playlist_songs, post_tags, post_hashtags, recipe_ingredients, organization_members).
7. REALTIME goes on LIVE-DATA tables only — messages, presence, notifications, ride_locations, orders, payments, plays, comments, replies, typing indicators. Do NOT enable on static catalog tables (songs, products, courses) or audit tables (audit_logs).
8. NOTIFY TRIGGERS on user-facing write paths — new message, new like, new follow, new comment, new order, task assigned, ride accepted, etc. Triggers fan out notifications.
9. STORAGE BUCKETS for any user-generated media. Public-read for avatars / public photos / album covers; private (isPublic:false) for confidential files (medical records, contracts).
10. AGGREGATE ENDPOINT — set aggregateApi to a short slug like "summary" so the platform generates a /stats/summary dashboard endpoint.
11. NAMING — snake_case table + column names. tableName plural ('orders' not 'order'). Boolean columns use 'is_*' or '*_at' (timestamp) where natural.
12. NEVER OUTPUT 'users' AS A TABLE — auth.users is platform-managed. Use a 'profiles' or 'user_profiles' table to extend identity if needed.

—— TOO-VAGUE ESCAPE HATCH ——

If the user's prompt is so vague you genuinely cannot design the backend
(e.g. "build something cool", "make a backend", "an app"), output:

  { "error": "VAGUE", "askUser": "<one short clarifying question — name a concrete product, what kind of app it is>" }

If the prompt names a product class, build it. "social media app" / "music
streaming app" / "telehealth platform" / "ride share app" are NOT vague —
build them comprehensively.

—— OUTPUT (strict JSON, no markdown, no prose) ——

{
  "domain": "music-streaming",
  "title": "Music Streaming Backend",
  "summary": "One-paragraph plain-English overview.",
  "needsAuth": true,
  "needsTeams": false,
  "tables": [
    {
      "name": "artists",
      "purpose": "Artist profiles on the platform.",
      "columns": [
        { "name": "user_id", "type": "uuid", "unique": true },
        { "name": "stage_name", "type": "text" },
        { "name": "bio", "type": "text", "nullable": true },
        { "name": "avatar_url", "type": "text", "nullable": true },
        { "name": "follower_count", "type": "int", "nullable": true },
        { "name": "verified", "type": "boolean", "nullable": true }
      ]
    }
  ],
  "rls": [
    { "tableName": "artists", "policy": "public_read" }
  ],
  "realtimeTables": ["plays", "comments"],
  "triggers": [
    { "tableName": "follows", "on": "insert" }
  ],
  "buckets": [
    { "name": "audio", "isPublic": true },
    { "name": "covers", "isPublic": true }
  ],
  "aggregateApi": "summary",
  "functions": [
    {
      "name": "on_play_update_counts",
      "description": "When a row is inserted into plays, increment play_count on the song and append a listening_history row for the user.",
      "trigger": "on_insert",
      "table": "plays"
    }
  ],
  "crons": [
    {
      "description": "Recompute trending_score on songs from the last 24h of plays.",
      "schedule": "every hour"
    }
  ],
  "seeds": [
    {
      "tableName": "artists",
      "rows": [
        { "stage_name": "Nova Reyes", "bio": "Synthwave producer from Lisbon.", "verified": true }
      ]
    }
  ]
}

Omit "functions" / "crons" / "seeds" when the user's product genuinely needs none — but if the user described automations, reminders, or demo data, leaving these out means the build silently ignores their request. Cover every one.

Now design the backend for the user's product. Be exhaustive. ${ARCHITECT_VERSION}.`

export interface ArchitectResult {
  blueprint: Blueprint
  rawSpec: ArchitectSpec
  tokensUsed: number
}

export interface ArchitectVague {
  vague: true
  askUser: string
}

/**
 * Drive the LLM architect against a user prompt and return either an
 * executable Blueprint, a clarifying question for a vague prompt, or null if
 * BOTH attempts failed. On null, callers fall back to the standard agent loop
 * — the ungoverned path — so this function fights hard to succeed:
 *
 *   Attempt 1: full spec (tables + automations + seeds), 180s timeout.
 *   Attempt 2 (on timeout / truncation / parse / validation failure): the
 *   same request WITHOUT seeds — the single biggest output-token driver.
 *   A build with honest "seeds: missing" coverage beats no governed build.
 *
 * The 2026-07-03 Founder Outreach incident is why this shape exists: the
 * shared client's 30s timeout killed the architect mid-generation and the
 * whole request fell into the agent loop, losing the users→profiles rule,
 * requested-vs-applied coverage, and post-build verification.
 */
export async function architectBackend(
  userPrompt: string,
  projectId: string,
): Promise<ArchitectResult | ArchitectVague | null> {
  let totalTokens = 0
  for (const omitSeeds of [false, true]) {
    const attempt = await architectOnce(userPrompt, projectId, omitSeeds)
    totalTokens += attempt.tokensUsed
    if (attempt.kind === 'ok') {
      return { blueprint: attempt.blueprint, rawSpec: attempt.rawSpec, tokensUsed: totalTokens }
    }
    if (attempt.kind === 'vague') {
      return { vague: true, askUser: attempt.askUser }
    }
    console.warn(
      `[Architect] attempt ${omitSeeds ? 2 : 1} failed (${attempt.reason})` +
      (omitSeeds ? ' — giving up, caller falls back to agent loop' : ' — retrying without seeds'),
    )
  }
  return null
}

type ArchitectAttempt =
  | { kind: 'ok'; blueprint: Blueprint; rawSpec: ArchitectSpec; tokensUsed: number }
  | { kind: 'vague'; askUser: string; tokensUsed: number }
  | { kind: 'failed'; reason: string; tokensUsed: number }

async function architectOnce(
  userPrompt: string,
  projectId: string,
  omitSeeds: boolean,
): Promise<ArchitectAttempt> {
  const openai = getOpenAIClient()
  let raw: string
  let tokensUsed = 0
  let finishReason = ''
  const startedAt = Date.now()
  try {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      { role: 'system', content: ARCHITECT_PROMPT },
      // 12k chars ≈ 3k tokens — detailed specs (10+ tables with full column
      // lists) run 3–6k chars, and truncating one mid-schema silently drops
      // the user's tables. Cheap to keep; catastrophic to cut.
      { role: 'user', content: userPrompt.slice(0, 12000) },
    ]
    if (omitSeeds) {
      messages.push({
        role: 'system',
        content:
          'RETRY MODE: your previous spec was too large or failed to complete. ' +
          'Output the same design but OMIT the "seeds" field entirely and keep every description under 200 characters. ' +
          'Do not drop tables, functions, or crons — only seeds.',
      })
    }
    const completion = await openai.chat.completions.create(
      {
        model: getModel('plan'),
        messages,
        response_format: { type: 'json_object' },
        temperature: 0.2,
        // A 15–25 table spec with per-table columns + RLS + realtime +
        // triggers + functions can exceed 4.5k output tokens; a truncated
        // JSON body fails the parse and the attempt is wasted.
        max_tokens: 8000,
      },
      // The shared client is tuned for small classify calls (30s). Generating
      // a full backend spec is the heaviest single LLM call in the product —
      // give it a real budget and disable SDK-level retries (our two-attempt
      // loop owns the retry policy; stacking both would triple latency).
      { timeout: 180_000, maxRetries: 0 },
    )
    if (projectId) trackCompletionCost(completion, projectId, 'architect')
    tokensUsed = completion.usage?.total_tokens ?? 0
    finishReason = completion.choices[0]?.finish_reason ?? ''
    raw = completion.choices[0]?.message?.content?.trim() ?? ''
  } catch (err) {
    const e = err as { message?: string }
    return {
      kind: 'failed',
      reason: `LLM call failed after ${Math.round((Date.now() - startedAt) / 1000)}s: ${e?.message?.slice(0, 120) ?? 'unknown'}`,
      tokensUsed,
    }
  }

  if (finishReason === 'length') {
    // Truncated mid-JSON — parsing is hopeless; report precisely so the
    // retry (or an operator reading logs) knows this was size, not flakiness.
    return { kind: 'failed', reason: `output truncated at max_tokens (finish_reason=length, ${tokensUsed} tokens)`, tokensUsed }
  }

  // Vague handler — surface the LLM's clarifying question to the user.
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Sometimes the model wraps in fences despite the system instruction.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      return { kind: 'failed', reason: `non-JSON response, head: ${raw.slice(0, 120)}`, tokensUsed }
    }
  }
  if (parsed?.error === 'VAGUE' && typeof parsed.askUser === 'string') {
    return { kind: 'vague', askUser: parsed.askUser, tokensUsed }
  }

  // Validate + enrich into an executable Blueprint.
  const result = validateAndEnrichSpec(parsed)
  if (result.ok !== true) {
    return { kind: 'failed', reason: `spec validation failed: ${result.errors.join('; ').slice(0, 200)}`, tokensUsed }
  }
  console.log(
    `[Architect] domain=${result.blueprint.domain} tables=${parsed.tables?.length ?? 0} ` +
    `steps=${result.blueprint.steps.length} tokens=${tokensUsed} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s` +
    (omitSeeds ? ' (seeds omitted on retry)' : ''),
  )
  return { kind: 'ok', blueprint: result.blueprint, rawSpec: parsed as ArchitectSpec, tokensUsed }
}
