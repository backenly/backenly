/**
 * PROPOSAL TYPES
 * ==============
 * A Proposal is a structured artifact representing a set of recommendations
 * the agent emitted in a previous turn ("here are 6 production-readiness
 * updates you should make"). Each item carries enough metadata that the
 * agent can decide — without re-reading free text — whether it can execute
 * the item itself, what action to dispatch, and what the user should hear
 * when an item can't be done from inside Backenly.
 *
 * Why this exists:
 *   The previous system stored AI suggestions as `string[]` and re-parsed
 *   them on every follow-up turn. That made the agent rely on regex to
 *   recover its own intent, which is the wrong direction for an agentic
 *   product. With a typed Proposal the LLM doesn't have to re-read its
 *   own text — it just calls `applyProposal(id, scope)` and the executor
 *   dispatches each item through the existing AIAction surface.
 */

/** Concrete action a proposal item can dispatch through `executeAction`. */
export type ProposalActionKind =
  // Database
  | 'create_table'
  | 'alter_table'
  | 'add_column'
  | 'add_index'
  | 'add_constraint'
  | 'rename_column'
  // APIs
  | 'generate_api'
  // Auth
  | 'enable_auth'
  | 'add_provider'
  // Storage
  | 'create_bucket'
  | 'delete_bucket'
  // RLS / permissions
  | 'add_rls'
  | 'set_permission'
  // Triggers / realtime
  | 'create_trigger'
  | 'enable_realtime'
  // Fix verbs
  | 'fix_auth'
  | 'fix_api'
  | 'fix_table'
  | 'fix_integration'
  | 'fix_workflow'
  // Functions / cron
  | 'generate_function'
  | 'create_cron_job'
  // Integrations
  | 'enable_integration'
  // Non-executable
  | 'informational'   // E.g., "use strong password hashing" — already handled internally
  | 'manual'          // Requires user action (e.g., paste an API key)
  | 'infra'           // Outside Backenly (e.g., CDN, DNS, backups infra)

/** Why an item can't be auto-applied right now. */
export type ProposalBlocker =
  | 'needs_credential'    // Missing API key / OAuth secret
  | 'needs_user_input'    // E.g., column type ambiguous, needs naming
  | 'infra_only'          // Belongs to ops / infra, not Backenly
  | 'already_handled'     // Backenly handles this internally (no-op)
  | 'unsupported'         // Backenly doesn't have this primitive yet

export type ProposalItemStatus =
  | 'pending'      // Default — has not been applied yet
  | 'in_progress'  // Mid-execution
  | 'done'         // Successfully applied + verified
  | 'failed'       // Execution failed
  | 'skipped'      // User or agent chose to skip

export interface ProposalItem {
  /** Stable id within the proposal. */
  id: string
  /** Short title — appears in the user-facing affordance ("Apply 6 of these"). */
  title: string
  /** Optional longer description from the original AI list. */
  description?: string
  /** Concrete action kind. Drives `params` shape. */
  actionKind: ProposalActionKind
  /** True iff Backenly can execute this item now without further input. */
  executable: boolean
  /** Populated when executable=false. */
  blocker?: ProposalBlocker
  /** Free-form user-facing reason for the blocker — shown verbatim. */
  blockerReason?: string
  /** Action parameters — passed through to `executeAction`. Shape depends on `actionKind`. */
  params?: Record<string, unknown>
  /** Current execution status. */
  status: ProposalItemStatus
  /** Populated when status=failed. */
  error?: string
  /** Populated when status=done — proof of the change (e.g., table name, row count). */
  proof?: string
}

export type ProposalStatus = 'open' | 'partial' | 'applied' | 'closed' | 'expired'

export interface Proposal {
  /** Stable id for this proposal. */
  id: string
  projectId: string
  /** Short title — e.g., "Production-readiness recommendations". */
  title: string
  /** One-sentence summary (optional) — shown above items. */
  summary?: string
  items: ProposalItem[]
  /** Status rolls up from item statuses. */
  status: ProposalStatus
  createdAt: string  // ISO timestamp
  /** Auto-expires after this — stale proposals should not silently re-trigger. */
  expiresAt: string  // ISO timestamp
  /** The user message that prompted this proposal — useful for telemetry. */
  sourceUserMessage?: string
  /** Number of items the agent could apply when the proposal was generated.
   *  Cached for fast affordance rendering — recomputed on apply. */
  executableCount: number
}

/** Result returned by `applyProposal`. */
export interface ApplyProposalReport {
  proposalId: string
  attempted: number
  succeeded: number
  failed: number
  skipped: number
  /** Itemised results — same order as `proposal.items`. */
  items: Array<{
    id: string
    title: string
    status: ProposalItemStatus
    proof?: string
    error?: string
  }>
  /** Human-readable summary suitable for chat output. */
  markdown: string
}

/** Apply scope — controls which items get dispatched. */
export type ApplyScope =
  | 'executable_only'  // Default — only items with executable=true
  | 'all'              // Try everything, including items with blockers
  | { itemIds: string[] }  // Caller-specified subset
