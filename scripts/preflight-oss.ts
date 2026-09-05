/**
 * PHASE 5 — the gate that stands between this repository and being public.
 *
 * Open-sourcing is the one action in this whole system that cannot be undone.
 * A bad deploy is reverted; a bad migration is rolled back. A secret pushed to
 * a public repository is cloned, indexed, and scraped by credential harvesters
 * within minutes, and deleting the commit afterwards changes nothing — GitHub
 * serves orphaned objects, forks keep their copy, and the mirrors already have
 * it. The only real remedy is rotating every exposed credential.
 *
 * So this refuses loudly rather than warning politely, and it checks HISTORY as
 * well as the working tree. A secret removed in a later commit is still fully
 * readable to anyone who clones the repository, which is what makes "we deleted
 * it" the most common wrong answer to this problem.
 *
 *   npx tsx scripts/preflight-oss.ts           # working tree + history
 *   npx tsx scripts/preflight-oss.ts --tree    # working tree only (faster)
 *   npx tsx scripts/preflight-oss.ts --credentials-only
 *                                             # credential rules only, no OSS
 *                                             # release-artifact checks. Used by
 *                                             # backenly-cloud CI on its own tree.
 *
 * Exit 0 = safe to publish. Nonzero = do not publish.
 */

import { execSync } from 'child_process'

interface Rule {
  id: string
  description: string
  /** Matches the SHAPE of a live credential, not the word for one. */
  pattern: RegExp
  /** Why this specific thing is dangerous, in terms of what an attacker gets. */
  impact: string
  /**
   * Working-tree only. `git log -S` takes a literal string, so a rule whose
   * matches have no fixed substring (a bare hex secret) cannot drive a history
   * search. Such rules are SKIPPED in history mode and reported as skipped —
   * see the note in scanHistory. Letting them fall through to a literal that
   * matches nothing would be a silent no-op, which is the failure mode this
   * whole file exists to avoid.
   */
  treeOnly?: boolean
}

/**
 * Patterns are deliberately shape-based and narrow.
 *
 * A scanner that flags every line containing "password" trains its users to
 * ignore it, and a gate people ignore is worse than no gate — it converts a
 * hard stop into a formality. Every rule here should fire on real credentials
 * and essentially never on documentation.
 */
const RULES: Rule[] = [
  {
    id: 'openai-key',
    description: 'OpenAI API key',
    pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g,
    impact: 'Billable API access on the owner\'s account.',
  },
  {
    id: 'anthropic-key',
    description: 'Anthropic API key',
    pattern: /sk-ant-(?:api\d\d-)?[A-Za-z0-9_-]{32,}/g,
    impact: 'Billable API access on the owner\'s account.',
  },
  {
    id: 'github-pat',
    description: 'GitHub personal access token',
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g,
    impact: 'Repository read/write, including private repositories.',
  },
  {
    id: 'npm-token',
    description: 'npm access token',
    pattern: /npm_[A-Za-z0-9]{36,}/g,
    impact: 'Publish rights — an attacker can ship a malicious package version.',
  },
  {
    id: 'backenly-live-key',
    description: 'Backenly live API/MCP key',
    pattern: /(?:mcp|bkn)_live_[A-Za-z0-9]{16,}/g,
    impact: 'Direct access to a live project\'s backend.',
  },
  {
    id: 'aws-access-key',
    description: 'AWS access key id',
    pattern: /AKIA[0-9A-Z]{16}/g,
    impact: 'Cloud account access, scoped to whatever that key can reach.',
  },
  {
    id: 'private-key-block',
    description: 'PEM private key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    impact: 'Server or signing identity.',
  },
  {
    id: 'postgres-url-with-password',
    description: 'PostgreSQL URL containing a password',
    pattern: /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]{6,}@[^\s/]+/g,
    impact: 'Direct database access — every tenant\'s data at once.',
  },
  {
    id: 'production-db-password',
    description: 'Known operator password',
    // Was /Adarsh@\d{4}/ and therefore missed the 3-digit variant, which sat in a
    // TRACKED .claude/settings.local.json while this gate reported the tree
    // clean. A rule narrow enough to be quiet is also narrow enough to be
    // wrong, and the failure is silent in the worst direction: it says "safe
    // to publish".
    pattern: /Adarsh@\w+/g,
    impact: 'Operator account and/or production database access.',
  },
  {
    id: 'named-secret-assignment',
    description: 'Signing/encryption secret assigned a literal value',
    // The .env-shaped case: NAME=<hex> or "NAME": "<hex>". Anchored on the
    // variable name, so any length from 32 up is worth reporting.
    pattern: /(?:JWT_SECRET|SESSION_SECRET|MASTER_ENCRYPTION_KEY|INTERNAL_API_TOKEN|AI_EXECUTION_TOKEN|CRON_SECRET|NEXTAUTH_SECRET)["']?\s*[:=]\s*["']?[0-9a-f]{32,}/gi,
    impact: 'Forge any session token, or decrypt every tenant\'s project secret.',
    treeOnly: true,
  },
  {
    id: 'bare-hex-secret',
    description: 'Bare high-entropy hex literal in source',
    // The case the name-anchored rule above CANNOT see, and the one that was
    // actually present here: the secret passed straight into jwt.sign() as a
    // positional argument, with no variable name anywhere near it. Every other
    // rule in this file is prefix-shaped (sk-, ghp_, npg_, AKIA), so a bare hex
    // string matched nothing and the gate reported "safe to publish" while a
    // live JWT_SECRET sat in two tracked files.
    //
    // Threshold is measured, not guessed. Across this repo:
    //   >=32 -> 1 match   (a real Amplitude key, client-side and public by design)
    //   >=40 -> 0 matches (but 40 is exactly a git SHA, so it invites future noise)
    //   >=48 -> 0 matches
    // Every real server-side secret in this project is 63-74 chars. 48 sits
    // above git SHAs (40) and MD5 (32) and below every real secret, which is
    // why it is the threshold that catches them all and cries wolf never.
    pattern: /["'][0-9a-f]{48,}["']/g,
    impact: 'Whatever that key signs, encrypts, or authorizes.',
    treeOnly: true,
  },
  {
    id: 'inline-password-flag',
    description: 'Password passed inline on a command line or in config',
    // Catches the shape rather than one known value: --password "x",
    // PGPASSWORD=x, "password": "x". Excludes obvious placeholders below.
    pattern: /(?:--password[= ]|PGPASSWORD=|"password"\s*:\s*)"?([^\s"',]{6,})"?/g,
    impact: 'Whatever that account can reach.',
  },
  {
    id: 'session-jwt',
    description: 'Signed JWT / session cookie committed to source',
    // The gap that mattered most. Five scripts carried live platform session
    // cookies (`auth-token=eyJ…`) and this gate reported the tree CLEAN, because
    // every other rule is prefix-shaped for a provider key and a JWT is none of
    // them. A committed HS256 token is worse than the session it represents:
    // the signature is an offline oracle, so an attacker can brute-force the
    // signing secret at their leisure and then mint tokens for ANY user.
    // Expiry does not help — the signature stays verifiable forever.
    //
    // Three base64url segments with real length. Documentation truncates
    // ("eyJhbGciOi..."), so requiring 20+ chars in the payload AND a signature
    // separates real tokens from illustrations.
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
    impact: 'Impersonation of that user, and an offline oracle for the signing secret.',
  },
  {
    id: 'public-ip-literal',
    description: 'Public IP address hardcoded in source',
    // Deliberately shape-based, never the literal address: this file is itself
    // published, so a rule written as `/5\.223\.73\.60/` would disclose the very
    // thing it exists to suppress. The gate must not become the leak.
    //
    // Excludes the private and reserved ranges, which are meaningless to a
    // remote attacker: 10/8, 127/8, 192.168/16, 172.16-31/12, 169.254/16,
    // 0.x, 224+/4 multicast+reserved, and 255.x.
    //
    // Also excludes `N.0.0.0`, and that trailing exclusion is load-bearing
    // rather than tidy. A dotted quad whose last three octets are all zero is a
    // NETWORK address, never a reachable host — no production server is ever
    // named that way, so nothing this rule exists to catch can hide there.
    //
    // What DOES live in that shape is Chrome's reduced User-Agent, which since
    // 2023 always reports `Chrome/<major>.0.0.0`. One such string in a test
    // fixture (tests/unit/service-role-exposure.spec.ts) failed this gate on
    // every push for weeks, and a gate that cries wolf on every commit is a gate
    // people learn to ignore — which costs more than the false positive did.
    //
    // The RFC 5737 documentation ranges are excluded for that same reason, and
    // it is not a hypothetical: 203.0.113.x in
    // __tests__/observability/pgrst-clock-diagnostic.test.ts (a sample EXTERNAL
    // address, testing that classifySource distinguishes it from loopback) made
    // this gate the only red job on main, reported as "Names the production
    // host". It named nothing. 192.0.2.0/24, 198.51.100.0/24 and 203.0.113.0/24
    // exist precisely so examples and fixtures can show a routable-looking
    // address without naming a real one, so a test using them is doing the
    // correct thing and must not be punished for it. This gate guards the
    // repository's single largest risk; its credibility is the asset, and every
    // false positive spends some.
    pattern: /\b(?!0\.)(?!10\.)(?!127\.)(?!169\.254\.)(?!192\.168\.)(?!192\.0\.2\.)(?!198\.51\.100\.)(?!203\.0\.113\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)(?!22[4-9]\.)(?!2[3-5]\d\.)(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b(?<!\.0\.0\.0)/g,
    impact: 'Names the production host — the first step of any real attack is finding it.',
    treeOnly: true,
  },
  {
    id: 'personal-mailbox',
    description: 'Personal email address hardcoded in source',
    // Shape, not the specific address, for the same reason as above. A project
    // mailbox (security@, support@) is meant to be published; a maintainer's
    // personal inbox on a consumer provider is a spam and phishing target, and
    // in test fixtures it is simply leftover local state.
    pattern: /[A-Za-z0-9._%+-]+@(?:gmail|googlemail|outlook|hotmail|live|yahoo|proton|protonmail|icloud|aol)\.[A-Za-z.]{2,}/g,
    impact: 'Doxxes the maintainer and seeds phishing against the account that owns the infrastructure.',
    treeOnly: true,
  },
]

/**
 * Placeholder markers — documentation showing the SHAPE of a key, not a key.
 *
 * Anchoring matters more than it looks. The previous version read
 * `…|here\b|\.\.\./i`, and both of those unanchored fragments silently disabled
 * the ENTIRE scanner across a large fraction of the codebase:
 *
 *   - `here\b` matches inside the word **where**. Every Prisma query in this
 *     repo contains `where:`, so any secret sharing a line with one was
 *     exempted from every rule — which is how a live personal address survived
 *     a run of this gate that printed "clean".
 *   - `\.\.\.` matches the JavaScript spread operator, so `{ ...config }` and
 *     `(...args)` exempted their lines too.
 *
 * `EXAMPLE`, `PLACEHOLDER` and `DUMMY` stay deliberately unanchored: they are
 * not substrings of ordinary code words, and canonical dummy credentials embed
 * them mid-token — AWS's own documented key is `AKIAIOSFODNN7EXAMPLE`, which a
 * leading `\b` would fail to recognise.
 *
 * A placeholder filter is the one part of a secret scanner that can only ever
 * cause false NEGATIVES. It should therefore be the most conservative thing in
 * the file, and every widening of it deserves the same scrutiny as a new rule.
 */
const PLACEHOLDER =
  /\bYOUR|EXAMPLE|PLACEHOLDER|DUMMY|xxxx+|<[^>]+>|\bhere\b|[A-Za-z0-9_-]{2,}\.\.\./i

/**
 * Connection strings that are not secrets: loopback targets and template
 * passwords like `user:password@`.
 *
 * This exemption is load-bearing for the gate's usefulness, not a convenience.
 * Documentation and CI configs are full of example DSNs, and a gate that flags
 * nineteen of those alongside one real credential has effectively hidden the
 * real one. The tuning target is a report short enough that every line gets
 * read.
 */
const BENIGN_DSN_HOST = /@(?:localhost|127\.0\.0\.1|0\.0\.0\.0|db|postgres|host\.docker\.internal)[:/\s]/i
const BENIGN_DSN_PASSWORD = /:\/\/[^:@\s]+:(?:password|pass|secret|changeme|postgres|user|ci|test|dev)@/i

/**
 * A DSN assembled from variables at runtime holds no secret — the secret is
 * whatever fills the placeholders, and that lives in the environment.
 */
const TEMPLATE_INTERPOLATION = /\$\{|\{\{|%s|\$[A-Z_]{3,}/

/**
 * Passwords that are obviously illustrative.
 *
 * Needed because the inline-password rule fires on documentation showing a
 * request body. Left unfiltered it reported five doc examples alongside the one
 * real credential — the exact dilution that made the previous version of this
 * gate useless. Matched on the VALUE, so a real password is never exempted by
 * the wording around it.
 */
const BENIGN_PASSWORD = /^(?:secure)?(?:password|passwd|pass|secret|changeme|hunter2|letmein|test|demo)[0-9!@#]*$/i
const ILLUSTRATIVE_MARKER = /demo|example|sample|dummy|placeholder|test/i

function isBenignPassword(match: string): boolean {
  const value = match.replace(/^(?:--password[= ]|PGPASSWORD=|"password"\s*:\s*)/, '').replace(/^"|"$/g, '')
  return BENIGN_PASSWORD.test(value) || ILLUSTRATIVE_MARKER.test(value)
}

/**
 * Dotted-quad shapes that are not addresses.
 *
 * Spec citations look exactly like IPv4: "RFC 6749 Section 4.1.2.1" matched the
 * public-IP rule on first run. Left in, that is one false positive sitting next
 * to real findings, and the tuning target for this whole file is a report short
 * enough that every line gets read.
 */
const SPEC_CITATION = /\b(?:RFC|Section|§|v(?:ersion)?)\s*[\d.]|\bSection\b/i

/**
 * Synthetic mailboxes in test fixtures.
 *
 * The personal-mailbox rule exists to catch the MAINTAINER's inbox, which is a
 * phishing target and links the operator identity to the infrastructure. A
 * fixture list of generic local-parts at consumer providers, in a test
 * asserting which email domains may register, is not that — and shape alone
 * cannot tell the two apart. (Written without an example on purpose: a scanner
 * that embeds the pattern it searches for reports itself, which is exactly what
 * the first draft of this comment did.)
 *
 * So this exemption is scoped to test paths and to THIS rule only. Every
 * credential rule still fires inside tests — a real key in a test file is a
 * real key, and that is where several of this repo's worst findings lived.
 */
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|__fixtures__|e2e)\/|\.(?:test|spec)\.[jt]sx?$/

function isBenignDsn(match: string): boolean {
  return (
    BENIGN_DSN_HOST.test(match) ||
    BENIGN_DSN_PASSWORD.test(match) ||
    TEMPLATE_INTERPOLATION.test(match)
  )
}

interface Finding {
  rule: Rule
  location: string
  sample: string
}

function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/**
 * Read a tracked file as text, whatever encoding it was committed in.
 *
 * This is not a nicety. PowerShell's redirection operators write UTF-16LE by
 * default, so console output captured on Windows lands in the repo NUL-
 * interleaved. Decoded as UTF-8 that becomes `p\0o\0s\0t\0g\0r\0e\0s\0`, which
 * matches no rule in this file — and the gate reports the file clean.
 *
 * That happened: twenty captured `.txt` dumps were committed as UTF-16, one of
 * them naming a production database host, and every scan of this repository
 * said "working tree clean". A scanner that cannot read a file must not treat
 * it as empty.
 */
function readTracked(file: string): string {
  let buf: Buffer
  try {
    buf = execSync(`git show HEAD:"${file}"`, {
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
    // UTF-16BE has no Node decoder; swap to LE and reuse it.
    if (buf[0] === 0xfe && buf[1] === 0xff) return buf.subarray(2).swap16().toString('utf16le')
  }
  return buf.toString('utf8')
}

/** Redact so the report itself never becomes a second copy of the secret. */
function redact(s: string): string {
  const t = s.trim()
  if (t.length <= 12) return `${t.slice(0, 3)}***`
  return `${t.slice(0, 6)}…${t.slice(-4)} (${t.length} chars)`
}

function scanTree(): Finding[] {
  const findings: Finding[] = []
  const files = sh('git ls-files').split('\n').filter(Boolean)

  for (const file of files) {
    // Lockfiles carry integrity hashes that resemble tokens and contain no
    // secrets; scanning them produces noise that hides real findings.
    if (/package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$/.test(file)) continue

    const content = readTracked(file)
    if (!content) continue

    for (const rule of RULES) {
      rule.pattern.lastIndex = 0
      const matches = content.match(rule.pattern)
      if (!matches) continue
      for (const m of matches) {
        // Check the LINE, not the match: a real key rarely sits on a line that
        // also says "YOUR_KEY_HERE", and a placeholder almost always does.
        const line = content.split('\n').find(l => l.includes(m)) ?? m
        if (PLACEHOLDER.test(line)) continue
        if (rule.id === 'postgres-url-with-password' && isBenignDsn(m)) continue
        if (rule.id === 'inline-password-flag' && isBenignPassword(m)) continue
        if (rule.id === 'public-ip-literal' && SPEC_CITATION.test(line)) continue
        if (rule.id === 'personal-mailbox' && TEST_PATH.test(file)) continue
        // One finding per rule per file: three identical CI placeholders are
        // one problem, and listing them three times pushes the real finding
        // off the part of the report anyone reads.
        if (findings.some(f => f.rule.id === rule.id && f.location === file)) continue
        findings.push({ rule, location: file, sample: redact(m) })
      }
    }
  }
  return findings
}

/**
 * Scan history, and VERIFY each hit rather than counting string occurrences.
 *
 * `git log -S` searches for a literal, so `-S"AKIA"` matches the validation
 * regex that merely describes an AWS key as readily as a real one. An unverified
 * count reported "AWS access key in 10 commits" for this repository, and acting
 * on that means rotating credentials that were never exposed — or, worse,
 * learning to disbelieve the report.
 *
 * So candidate commits are opened and matched against the full pattern with the
 * same placeholder and benign-DSN filters the tree scan uses. Bounded per rule:
 * the question is "is this present at all", and the first genuine hit answers it.
 */
function scanHistory(): { findings: Finding[]; skipped: Rule[] } {
  const findings: Finding[] = []
  const skipped: Rule[] = []
  const MAX_COMMITS_PER_RULE = 40

  for (const rule of RULES) {
    // Reported, never silent. `git log -S` needs a fixed substring and these
    // rules have none; pretending to check them would be worse than admitting
    // the gap, because the whole point of this gate is that its green output
    // can be trusted.
    if (rule.treeOnly) {
      skipped.push(rule)
      continue
    }
    const literal = rule.id === 'production-db-password' ? 'Adarsh@' : sampleFor(rule)
    // -S finds commits where the occurrence COUNT changed, catching both the
    // commit that added a secret and the one that removed it. The removal
    // matters: the secret remains readable in history either way.
    const commits = sh(`git log --all --format=%H -S"${literal}"`)
      .split('\n')
      .filter(Boolean)
    if (commits.length === 0) continue

    let confirmed = 0
    let earliest: string | undefined
    let sample: string | undefined

    for (const commit of commits.slice(0, MAX_COMMITS_PER_RULE)) {
      const diff = sh(`git show --unified=0 --format= ${commit}`)
      if (!diff) continue
      rule.pattern.lastIndex = 0
      const matches = diff.match(rule.pattern)
      if (!matches) continue

      const real = matches.filter(m => {
        const line = diff.split('\n').find(l => l.includes(m)) ?? m
        if (PLACEHOLDER.test(line)) return false
        if (rule.id === 'postgres-url-with-password' && isBenignDsn(m)) return false
        return true
      })
      if (real.length === 0) continue

      confirmed++
      earliest = commit
      sample ??= redact(real[0])
    }

    if (confirmed === 0) continue
    findings.push({
      rule,
      location: `git history — ${confirmed} commit(s) confirmed, earliest ${earliest?.slice(0, 8)}`,
      sample: sample ?? '(present in history)',
    })
  }
  return { findings, skipped }
}

/** A literal fragment usable with `git log -S`, which takes a string not a regex. */
function sampleFor(rule: Rule): string {
  switch (rule.id) {
    case 'openai-key': return 'sk-proj-'
    case 'anthropic-key': return 'sk-ant-api'
    case 'github-pat': return 'ghp_'
    case 'npm-token': return 'npm_'
    case 'backenly-live-key': return 'mcp_live_'
    case 'aws-access-key': return 'AKIA'
    case 'private-key-block': return 'BEGIN RSA PRIVATE KEY'
    case 'postgres-url-with-password': return 'postgresql://'
    // Every JWT starts with the same base64 of {"alg":"HS256","typ":"JWT"}.
    case 'session-jwt': return 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
    default: return rule.id
  }
}

/**
 * Artifacts a public repository needs to be usable and lawful to depend on.
 *
 * Checked by the same gate as the secret scan because both are conditions of
 * publishing, and a second checklist maintained separately is a checklist that
 * drifts. Missing files are reported, never created — publishing without a
 * licence is a decision, and silently inventing one on the author's behalf
 * would be making that decision for them.
 */
function checkReleaseArtifacts(): string[] {
  const problems: string[] = []
  const tracked = new Set(sh('git ls-files').split('\n').filter(Boolean))

  const licence = sh('git show HEAD:LICENSE')
  if (!tracked.has('LICENSE')) {
    problems.push(
      'LICENSE is missing. Without one the default is exclusive copyright: ' +
      'nobody may legally use, modify, or redistribute the code, which is the ' +
      'opposite of the intent of publishing it.',
    )
  } else if (!/Apache License/i.test(licence) || !/Version 2\.0/.test(licence)) {
    problems.push('LICENSE does not contain the Apache-2.0 text the project declares.')
  }

  // Apache-2.0 section 4(d) makes redistributors carry a NOTICE forward if one
  // is distributed. Shipping the licence without it is the usual half-migration.
  if (!tracked.has('NOTICE')) {
    problems.push('NOTICE is missing — Apache-2.0 section 4(d) expects one alongside the LICENSE.')
  }

  // A package that DECLARES a licence in package.json must also ship the text.
  // npm renders the field; anyone doing real diligence reads the file.
  for (const pkgPath of sh('git ls-files packages/*/package.json').split('\n').filter(Boolean)) {
    const dir = pkgPath.replace(/\/package\.json$/, '')
    if (!tracked.has(`${dir}/LICENSE`)) {
      problems.push(`${dir} declares a licence in package.json but ships no LICENSE file.`)
    }
  }

  const pkg = sh('git show HEAD:package.json')
  if (pkg && !/"license"\s*:/.test(pkg)) {
    problems.push(
      'package.json has no "license" field. Dependency scanners and registries ' +
      'read that field, not the LICENSE file.',
    )
  }

  if (!tracked.has('SECURITY.md')) {
    problems.push('SECURITY.md is missing — no way to report a vulnerability privately.')
  } else if (!/report|disclos/i.test(sh('git show HEAD:SECURITY.md'))) {
    problems.push(
      'SECURITY.md exists but describes no reporting route. Without one, the ' +
      'default channel is a public issue, which publishes the exploit.',
    )
  }

  if (!tracked.has('CONTRIBUTING.md')) {
    problems.push('CONTRIBUTING.md is missing.')
  }

  // A public repo that only builds against the author's server is not usable by
  // anyone else, and the first contributor discovers that after cloning it.
  if (!tracked.has('docker-compose.dev.yml') && !tracked.has('docker-compose.yml')) {
    problems.push(
      'No docker-compose file — contributors have no reproducible way to run ' +
      'the stack without access to production infrastructure.',
    )
  }

  return problems
}

function main() {
  const treeOnly = process.argv.includes('--tree')
  // Credential rules only, no OSS release-artifact expectations. This is what
  // backenly-cloud's CI runs over its own tree: private is not a secret store,
  // but it owes nobody a LICENSE.
  const credentialsOnly = process.argv.includes('--credentials-only')

  console.log('\n  Open-source preflight')
  // Stated up front because it is otherwise baffling: a file edited and not yet
  // committed still shows as a finding, and the natural conclusion is that the
  // scanner is broken. Committed content is what gets published, so committed
  // content is what is checked.
  console.log('  (scans COMMITTED content — uncommitted edits are not yet counted)\n')

  const treeFindings = scanTree()
  console.log(`  working tree   ${treeFindings.length === 0 ? 'clean' : `${treeFindings.length} finding(s)`}`)

  let historyFindings: Finding[] = []
  let historySkipped: Rule[] = []
  if (!treeOnly) {
    const history = scanHistory()
    historyFindings = history.findings
    historySkipped = history.skipped
    console.log(`  git history    ${historyFindings.length === 0 ? 'clean' : `${historyFindings.length} pattern(s) present`}`)
    if (historySkipped.length > 0) {
      console.log(
        `                 (${historySkipped.length} rule(s) are working-tree only: ` +
        `${historySkipped.map(r => r.id).join(', ')} — no fixed substring to search history with)`,
      )
    }
  }

  if (treeFindings.length > 0) {
    console.log('\n  WORKING TREE — these ship the moment the repo is public:\n')
    for (const f of treeFindings) {
      console.log(`    ${f.rule.description}`)
      console.log(`      ${f.location}`)
      console.log(`      ${f.sample}`)
      console.log(`      impact: ${f.rule.impact}\n`)
    }
  }

  if (historyFindings.length > 0) {
    console.log('\n  GIT HISTORY — readable to anyone who clones, even if deleted since:\n')
    for (const f of historyFindings) {
      console.log(`    ${f.rule.description}`)
      console.log(`      ${f.location}`)
      console.log(`      impact: ${f.rule.impact}\n`)
    }
  }

  // LICENSE, NOTICE, SECURITY.md and a compose file are what an OSS RELEASE
  // owes its readers. backenly-cloud is private and publishes nothing, so
  // holding it to them would fail its CI for missing artifacts it should not
  // have — while the part that matters there, "no credential was committed",
  // applies to both repositories and applies harder to the private one, which
  // gets cloned onto every build host and CI runner.
  //
  // So the credential rules are reusable on their own. One set of patterns,
  // two repositories, no second scanner to drift.
  const artifactProblems = credentialsOnly ? [] : checkReleaseArtifacts()
  if (credentialsOnly) {
    console.log('  release files  not checked (--credentials-only)')
  } else {
    console.log(
      `  release files  ${artifactProblems.length === 0 ? 'complete' : `${artifactProblems.length} missing/incomplete`}`,
    )
  }
  if (artifactProblems.length > 0) {
    console.log('\n  RELEASE ARTIFACTS:\n')
    for (const p of artifactProblems) console.log(`    - ${p}\n`)
  }

  const total = treeFindings.length + historyFindings.length + artifactProblems.length
  if (total === 0) {
    console.log(
      credentialsOnly
        ? '\n  No credential patterns found.\n'
        : '\n  No credential patterns found; release files complete. Safe to publish.\n',
    )
    process.exit(0)
  }

  console.log('  ─────────────────────────────────────────────────────────────')
  console.log('  DO NOT PUBLISH.\n')
  if (historyFindings.length > 0) {
    console.log('  History findings cannot be fixed by editing files. Once public,')
    console.log('  every commit is readable — rewriting later does not help, because')
    console.log('  GitHub serves orphaned objects and forks keep their own copy.')
    console.log('')
    console.log('  Publish from a fresh repository with no prior history:')
    console.log('    1. rotate every credential above — assume they are already known')
    console.log('    2. create a new repo, copy the working tree in, single commit')
    console.log('    3. re-run this gate against that repo before pushing\n')
  }
  process.exit(1)
}

main()
