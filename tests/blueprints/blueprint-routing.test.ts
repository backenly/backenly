/**
 * BLUEPRINT ROUTING REGRESSION SUITE
 * ==================================
 * Locks in the routing contract for the blueprint planner:
 *
 *   1. A prompt carrying its own schema NEVER matches a curated template —
 *      it must reach the LLM architect (user spec is law).
 *   2. Curated templates only fire for short prompts that NAME a known app
 *      class. Circumstantial vocabulary ("timeline", "follow-ups", "posts")
 *      can never select a template on its own.
 *
 * Regression origin: a "Founder Outreach OS" CRM prompt with a full 10-table
 * spec was built as a 15-table SOCIAL MEDIA backend because "follow-up"
 * matched \bfollow\b and "activity timeline" matched \btimeline\b.
 * These tests are pure (no DB, no network).
 */

import { detectDomain, isExplicitSpec, shouldUseCuratedBlueprint } from '../../lib/ai/blueprints'

const FOUNDER_OUTREACH_PROMPT = `Build the backend for a SaaS app called Founder Outreach OS.

The app helps startup founders manage investor, accelerator, recruiter, and internship outreach.

Create a complete backend with authentication, database tables, APIs, permissions, storage, realtime updates, backend functions, scheduled follow-up reminders, and operational memory logging.

Core user flow:
A user signs up, creates contacts, tracks outreach status, attaches documents, writes notes, schedules follow-ups, and sees a backend activity timeline showing every important change.

Create these tables:

1. users
- id
- name
- email
- role
- created_at
- updated_at

2. companies
- id
- user_id
- name
- website
- type: vc_firm, startup, accelerator, university, other
- country
- notes
- created_at
- updated_at

3. contacts
- id
- user_id
- company_id
- name
- title
- email
- linkedin_url
- contact_type: investor, recruiter, accelerator, founder, mentor, other
- priority: low, medium, high
- status: not_contacted, email_drafted, email_sent, followup_needed, replied, meeting_booked, accepted, rejected
- last_contacted_at
- next_followup_at
- notes
- created_at
- updated_at

4. opportunities
- id
- user_id
- company_id
- title
- opportunity_type: investor, accelerator, internship, job, grant, competition, other
- application_url
- deadline
- status: researching, applying, submitted, interview, accepted, rejected, closed
- priority: low, medium, high
- notes
- created_at
- updated_at`

describe('detectDomain — identity-signal rule', () => {
  it('does NOT classify the Founder Outreach CRM prompt as social-media (regression)', () => {
    const match = detectDomain(FOUNDER_OUTREACH_PROMPT)
    expect(match?.domain).not.toBe('social-media')
  })

  it('does not fire social-media on "follow-up" + "activity timeline" vocabulary alone', () => {
    const match = detectDomain(
      'An outreach tracker where I schedule follow-ups, see an activity timeline, and log posts about my likes.',
    )
    expect(match).toBeNull()
  })

  it('still detects a named social media app', () => {
    const match = detectDomain('Build me a social media app like instagram with posts, likes and followers')
    expect(match?.domain).toBe('social-media')
  })

  it('still detects a named marketplace', () => {
    const match = detectDomain('A marketplace with products, orders, sellers and checkout')
    expect(match?.domain).toBe('marketplace')
  })

  it('still detects a named project management tool', () => {
    const match = detectDomain('An issue tracker like linear with kanban boards and sprints')
    expect(match?.domain).toBe('project-mgmt')
  })

  it('returns null when only circumstantial signals match', () => {
    // "tasks" + "assignee" without naming a PM tool/class must not template.
    const match = detectDomain('I want to store tasks with an assignee field for my robot fleet')
    expect(match).toBeNull()
  })
})

describe('isExplicitSpec — user schema detection', () => {
  it('recognises the Founder Outreach prompt as an explicit spec', () => {
    expect(isExplicitSpec(FOUNDER_OUTREACH_PROMPT)).toBe(true)
  })

  it('recognises "create these tables" + bullet columns as explicit', () => {
    expect(
      isExplicitSpec(`Create these tables:
1. invoices
- user_id
- amount
- status: draft, sent, paid
- created_at
2. clients
- user_id
- name
- email
- created_at`),
    ).toBe(true)
  })

  it('does not flag a plain product description', () => {
    expect(isExplicitSpec('Build me an instagram clone')).toBe(false)
    expect(isExplicitSpec('A marketplace with products and orders and payments')).toBe(false)
    expect(
      isExplicitSpec(
        'I want a backend for a fitness app where users track workouts, follow programs, and message coaches.',
      ),
    ).toBe(false)
  })
})

describe('shouldUseCuratedBlueprint — fast-path eligibility', () => {
  it('rejects the Founder Outreach prompt (explicit spec + long)', () => {
    expect(shouldUseCuratedBlueprint(FOUNDER_OUTREACH_PROMPT)).toBe(false)
  })

  it('rejects any prompt over the length gate, even a clean domain match', () => {
    const long = 'Build me a social media app like instagram. ' + 'It should be great. '.repeat(40)
    expect(long.length).toBeGreaterThan(500)
    expect(shouldUseCuratedBlueprint(long)).toBe(false)
  })

  it('accepts short template-shaped asks', () => {
    expect(shouldUseCuratedBlueprint('Build me an instagram clone')).toBe(true)
    expect(shouldUseCuratedBlueprint('marketplace with products and orders')).toBe(true)
  })

  it('rejects short prompts that still carry an explicit schema', () => {
    expect(
      shouldUseCuratedBlueprint(`Create these tables:
1. habits
- user_id
- name
- streak
2. checkins
- user_id
- habit_id
- created_at`),
    ).toBe(false)
  })
})
