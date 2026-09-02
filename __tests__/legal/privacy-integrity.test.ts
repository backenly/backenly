/**
 * Privacy policy structure.
 *
 * These assert the same structural facts scripts/verify-content-integrity.ts
 * enforces in the build, and they exist for the reason the build gate cannot
 * serve: the gate reports the first set of failures and exits, while a suite
 * names each broken invariant separately when someone is editing the policy.
 *
 * WHAT THESE DELIBERATELY DO NOT DO
 *
 * They do not check whether any statement is legally correct, lawful, or true
 * of the deployed system. No test can. A suite that appeared to would be worse
 * than none, because the next person would read a green run as verification
 * that the policy is accurate. Accuracy against production is a human review
 * step tied to what is actually deployed.
 *
 * One test does compare the policy against the codebase — the retention
 * numbers against lib/queue/worker.ts — because that specific claim was
 * measurably false before this rewrite ("up to 90 days" against a 30-day job)
 * and it is the kind of drift a reader has no way to detect.
 */

import fs from 'fs'
import path from 'path'
import {
  EFFECTIVE_DATE,
  PRIVACY_EMAIL,
  PRIVACY_SECTIONS,
  PRIVACY_SUMMARY,
  PROVIDERS,
} from '@/app/privacy/data'

const REQUIRED_SECTIONS = [
  'who-we-are',
  'information-we-collect',
  'how-we-use-it',
  'providers',
  'international',
  'retention',
  'deletion',
  'security',
  'your-rights',
  'changes',
]

describe('privacy policy structure', () => {
  it('contains every required section', () => {
    const ids = PRIVACY_SECTIONS.map((s) => s.id)
    for (const required of REQUIRED_SECTIONS) {
      expect(ids).toContain(required)
    }
  })

  it('has unique section anchors', () => {
    const ids = PRIVACY_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('uses slug anchors rather than ordinals', () => {
    // Two assertions, not one. A shape test alone passes `section-2`, which is
    // a well-formed slug and also precisely the pattern being retired:
    // #section-3 derives from array position, so reordering silently repoints
    // every external link into the policy.
    for (const section of PRIVACY_SECTIONS) {
      expect(section.id).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(section.id).not.toMatch(/^(section-?)?\d+$/)
    }
  })

  it('gives every section a title and body', () => {
    for (const section of PRIVACY_SECTIONS) {
      expect(section.title.trim().length).toBeGreaterThan(0)
      expect(section.content.trim().length).toBeGreaterThan(0)
    }
  })

  it('has no duplicate list or subsection items', () => {
    for (const section of PRIVACY_SECTIONS) {
      if (section.list) {
        expect(new Set(section.list).size).toBe(section.list.length)
      }
      for (const sub of section.subsections ?? []) {
        expect(sub.items.length).toBeGreaterThan(0)
        expect(new Set(sub.items).size).toBe(sub.items.length)
      }
    }
  })

  it('has a parseable effective date', () => {
    expect(Number.isNaN(new Date(EFFECTIVE_DATE).getTime())).toBe(false)
  })

  it('has a valid contact address that matches the one the site uses', () => {
    expect(PRIVACY_EMAIL).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)
    const shell = fs.readFileSync(
      path.join(process.cwd(), 'components/site/SiteShell.tsx'),
      'utf8',
    )
    expect(shell).toContain(PRIVACY_EMAIL)
  })

  it('has a non-empty summary with unique lines', () => {
    expect(PRIVACY_SUMMARY.length).toBeGreaterThan(0)
    expect(new Set(PRIVACY_SUMMARY).size).toBe(PRIVACY_SUMMARY.length)
  })
})

describe('provider disclosure', () => {
  it('renders the provider table in exactly one section', () => {
    expect(PRIVACY_SECTIONS.filter((s) => s.providers)).toHaveLength(1)
  })

  it('lists providers with no duplicates', () => {
    expect(PROVIDERS.length).toBeGreaterThan(0)
    const names = PROVIDERS.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every provider a purpose, a data category and an https link', () => {
    // The failure this catches is the one that produced the policy this
    // replaced: a provider added to the list with the explanatory half of the
    // row left blank, so the disclosure is present but says nothing.
    for (const provider of PROVIDERS) {
      expect(provider.name.trim().length).toBeGreaterThan(0)
      expect(provider.purpose.trim().length).toBeGreaterThan(0)
      expect(provider.data.trim().length).toBeGreaterThan(0)
      expect(provider.href).toMatch(/^https:\/\//)
    }
  })

  it('discloses every third party the platform is currently wired to', () => {
    // Not a style check. Each of these is a live outbound path in this
    // repository, and the previous policy named three of them.
    for (const name of [
      'Hetzner',
      'Backblaze B2',
      'Resend',
      'OpenAI',
      'Amplitude',
      'Sentry',
      'Paddle',
      'Cloudflare',
      'Google',
      'GitHub',
    ]) {
      expect(PROVIDERS.map((p) => p.name)).toContain(name)
    }
  })
})

describe('claims that were false before this rewrite', () => {
  const corpus = JSON.stringify(PRIVACY_SECTIONS) + JSON.stringify(PRIVACY_SUMMARY)

  it('does not claim API keys are hashed before storage', () => {
    // app/api/api-keys/route.ts writes the full plaintext key alongside the
    // hash, with no environment gate. Until that changes, the claim is false.
    expect(corpus).not.toMatch(/keys?\s+hashed\s+before\s+storage/i)
  })

  it('does not claim data is never stored in the United States', () => {
    expect(corpus).not.toMatch(/do not store data in the United States/i)
  })

  it('does not claim a 30-day deletion window after cancellation', () => {
    // Cancellation downgrades a subscription to FREE (lib/billing/grace.ts).
    // Nothing deletes a cancelled account, at any interval.
    expect(corpus).not.toMatch(/retained for 30 days before deletion/i)
  })

  it('does not claim seven-year billing retention', () => {
    // No mechanism implements it, and the schema cascades billing rows away
    // with the User, which is the opposite.
    expect(corpus).not.toMatch(/seven years|7 years/i)
  })

  it('states only retention windows that a job actually enforces', () => {
    const worker = fs.readFileSync(path.join(process.cwd(), 'lib/queue/worker.ts'), 'utf8')
    // The cleanup job's cutoff is 30 days. The policy said 90.
    expect(worker).toMatch(/30 \* 24 \* 60 \* 60 \* 1000/)

    const retention = PRIVACY_SECTIONS.find((s) => s.id === 'retention')
    expect(retention).toBeDefined()
    const text = JSON.stringify(retention)
    expect(text).toMatch(/30 days/)
    expect(text).not.toMatch(/90 days/)
  })
})

describe('disclosures that must be present while the behaviour is live', () => {
  it('discloses session replay in the present tense', () => {
    // The running release still calls initAll() with sessionReplay sampleRate 1
    // from the root layout. Removing this disclosure requires the behaviour to
    // be gone from production, not merely fixed on main.
    const analytics = PRIVACY_SECTIONS.find((s) => s.id === 'analytics')
    expect(analytics).toBeDefined()
    expect(JSON.stringify(analytics)).toMatch(/currently uses Amplitude Session Replay/i)
  })

  it('says session replay reaches authenticated dashboard pages', () => {
    // The component is mounted in the ROOT layout and there is no marketing
    // route group, so /app/* is covered. A disclosure that implied marketing
    // pages only would understate it.
    expect(JSON.stringify(PRIVACY_SECTIONS)).toMatch(/authenticated dashboard pages/i)
  })

  it('does not promise when session replay will be removed', () => {
    expect(JSON.stringify(PRIVACY_SECTIONS)).not.toMatch(/we are removing this/i)
  })

  it('separates subscription cancellation from account deletion', () => {
    const deletion = PRIVACY_SECTIONS.find((s) => s.id === 'deletion')
    expect(JSON.stringify(deletion)).toMatch(/Cancelling a paid subscription does not delete/i)
  })

  it('does not claim deletion completes immediately', () => {
    // Production predates the deletion fix, so removal is delayed. The wording
    // has to hold before and after that deploys.
    const deletion = JSON.stringify(PRIVACY_SECTIONS.find((s) => s.id === 'deletion'))
    expect(deletion).toMatch(/delayed basis/i)
  })

  it('keeps project-level export and does not claim an account-wide export', () => {
    const exportSection = JSON.stringify(PRIVACY_SECTIONS.find((s) => s.id === 'export'))
    expect(exportSection).toMatch(/PostgreSQL dump/i)
    expect(exportSection).toMatch(/does not currently provide a single account-level export/i)
  })

  it('states the hosting location without an absolute geographic negative', () => {
    const intl = JSON.stringify(PRIVACY_SECTIONS.find((s) => s.id === 'international'))
    expect(intl).toMatch(/Singapore/)
    expect(intl).toMatch(/may process information in other countries/i)
  })

  it('names the operating entity', () => {
    const who = JSON.stringify(PRIVACY_SECTIONS.find((s) => s.id === 'who-we-are'))
    expect(who).toMatch(/Backenly, Inc\./)
    expect(who).toMatch(/Delaware corporation/)
  })

  it('carries no provisional "work in progress" language', () => {
    // A privacy policy that announces pending legal work tells the reader
    // nothing actionable, dates itself on publication, and reads as an
    // admission. Every open question is stated neutrally in the present tense
    // instead. This stops the earlier phrasing from creeping back.
    const corpus = JSON.stringify(PRIVACY_SECTIONS)
    expect(corpus).not.toMatch(/under review/i)
    expect(corpus).not.toMatch(/will be (set out|described|stated|published) here/i)
    expect(corpus).not.toMatch(/being confirmed|finalising|finalizing/i)
  })
})
