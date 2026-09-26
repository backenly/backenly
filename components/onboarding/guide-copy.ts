/**
 * Words for the Getting Started guide, one entry per step.
 *
 * Every sentence here is a claim about the product, so each is held to what the
 * code does, not what would be nice:
 *   - MCP keys are scoped to one project, shown once, revocable
 *     (app/api/projects/[id]/mcp/keys).
 *   - "Connected" means Backenly recorded a call from the agent
 *     (lib/onboarding/guide.ts), so the copy never asks the user to confirm it.
 *   - An agent can ask to publish; the deploy domain tool parks the call for a
 *     human (lib/mcp/domains.ts), so "waits for your approval" is literal.
 *   - A failed publish leaves production unchanged (lib/deployment/go-live.ts).
 */

import type { LucideIcon } from 'lucide-react'
import { UserRound, FolderPlus, KeyRound, Cable, Database, Rocket, ShieldCheck } from 'lucide-react'
import type { StepId, StepStatus } from '@/lib/onboarding/guide'

export interface StepCopy {
  title: string
  /** Checklist line once the step is done. */
  doneTitle: string
  icon: LucideIcon
  /** One or two sentences: what this step is and why it exists. */
  body: string
  /** Finer readings of an unfinished step. */
  status?: Partial<Record<StepStatus, string>>
}

export const STEP_COPY: Record<StepId, StepCopy> = {
  account: {
    title: 'Create your account',
    doneTitle: 'Account created',
    icon: UserRound,
    body: 'You are signed in to Backenly.',
  },
  project: {
    title: 'Create a project',
    doneTitle: 'Project created',
    icon: FolderPlus,
    body: 'A project holds one backend: its Postgres database, auth, storage and APIs. Your MCP key is issued for a project, so this comes first.',
  },
  mcp_key: {
    title: 'Generate an MCP key',
    doneTitle: 'MCP key generated',
    icon: KeyRound,
    body: 'The key lets your coding agent use Backenly’s tools on this project. It is shown once, and you can revoke it from Connect at any time.',
  },
  agent: {
    title: 'Connect your coding agent',
    doneTitle: 'Coding agent connected',
    icon: Cable,
    body: 'Paste the setup prompt from Connect into Claude Code, Cursor, Codex or Cline. This completes when Backenly records your agent’s first call.',
    status: {
      waiting: 'Waiting for your agent’s first call',
      failed: 'Your agent reached Backenly, but its calls are failing',
    },
  },
  backend: {
    title: 'Build your first backend',
    doneTitle: 'First backend built',
    icon: Database,
    body: 'Describe what you want to your agent, not to this dashboard. It creates the tables, auth and access rules through Backenly.',
  },
  publish: {
    title: 'Publish your backend',
    doneTitle: 'Backend published',
    icon: Rocket,
    body: 'Publishing gives your app a stable, versioned endpoint. Your agent can ask to publish too; that request waits for your approval.',
    status: {
      in_progress: 'Publishing',
      failed: 'The last publish failed',
    },
  },
  watching: {
    title: 'See Backenly watching',
    doneTitle: 'Backenly is watching',
    icon: ShieldCheck,
    body: 'Backenly checks your backend on a schedule and repairs what it safely can, within the limits you set on the Autonomy page.',
    status: {
      waiting: 'Waiting for the first check',
    },
  },
}

/**
 * The prompt a new user pastes into their agent after connecting. It exercises
 * the tools a first backend actually needs — read_backend_state, auth
 * (enable), apply_migration, set_rls — and asks the agent to report back, so
 * the user sees the result in their agent before they see it here. REST needs
 * no step: every table is served from the catalog as soon as it exists.
 */
export const STARTER_PROMPT = `Build the backend for a small notes app on Backenly.

- Email and password sign-up for my app's users.
- A notes table: title (required), body, pinned (default false), and the id of the user who owns it.
- Row-level security, so each user can only read and change their own notes.

Start with \`read_backend_state\`, make every change through Backenly's tools, then show me the tables, the auth setup and the REST endpoint for notes.`

/**
 * What Backenly does once a backend exists, stage by stage. The names are the
 * Overview's self-healing loop (components/workspace/WorkspaceHome.tsx), so the
 * guide teaches the words the console already uses.
 */
export const AUTONOMY_STAGES: { name: string; body: string }[] = [
  { name: 'Observe', body: 'Checks schema, row-level security, APIs, webhooks and auth health on a schedule.' },
  { name: 'Detect', body: 'Records each broken guarantee as a finding you can see.' },
  { name: 'Propose', body: 'Plans a fix, and decides whether it is safe to apply alone or needs you.' },
  { name: 'Apply', body: 'Applies safe, reversible fixes within your autonomy level. Auth, credentials and anything destructive wait for your approval.' },
  { name: 'Verify', body: 'Re-checks after each fix. A fix that breaks something goes to your review queue.' },
]

export const AUTONOMY_GUARANTEES: { name: string; body: string }[] = [
  { name: 'Governed', body: 'Your autonomy level decides what it may do alone.' },
  { name: 'Verified', body: 'Every fix is re-checked.' },
  { name: 'Auditable', body: 'Actions are logged and shown on the Autonomy page.' },
  { name: 'Reversible', body: 'Restore points let you roll back.' },
]
