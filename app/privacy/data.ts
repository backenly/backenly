/**
 * PRIVACY POLICY CONTENT
 * ======================
 *
 * Separated from page.tsx for the same reason app/comparisons/data.ts and
 * app/use-cases/data.ts are: the integrity gate imports this, and a Next.js
 * page module may only export a default component plus route segment config.
 *
 * WHAT THIS REWRITE FIXED
 *
 * The previous policy made five claims the codebase contradicts, and named
 * three third parties when ten can receive data:
 *
 *   • "API keys hashed before storage" — the general key-creation path writes
 *     the full plaintext key alongside the hash (app/api/api-keys/route.ts),
 *     with no environment gate. The claim is gone rather than reworded; it can
 *     return when the code earns it.
 *   • "We do not store data in the United States" — an absolute negative that
 *     rested on six unresolved facts. Primary hosting is stated instead.
 *   • "Cancelled account data is retained for 30 days before deletion" — no
 *     such mechanism exists. Cancellation downgrades a subscription to FREE
 *     (lib/billing/grace.ts) and deletes nothing.
 *   • "Billing records are retained for seven years" — no mechanism, and the
 *     schema does the opposite: Subscription, PaddleSubscription,
 *     CreditLedgerEntry and UserAiUsage all cascade-delete with the User.
 *   • "Logs and diagnostics are retained for up to 90 days" — the enforced
 *     window is 30 days across three tables (lib/queue/worker.ts); most log
 *     tables have no limit at all.
 *   • Amplitude, Sentry, Resend, Cloudflare, Backblaze, Google and GitHub were
 *     undisclosed.
 *
 * THE RULE THIS FILE FOLLOWS
 *
 * Every statement is verifiable from this repository or from a provider's own
 * published documentation. Describing intended behaviour as current is how the
 * previous version drifted this far from the code.
 *
 * Where a question is genuinely open — how the roles are characterised in law,
 * which transfer safeguard applies, retention limits no job enforces yet — the
 * text states the current position neutrally and stops. It does not announce
 * pending legal work: "under review" tells a reader nothing they can use, dates
 * the page the moment it is published, and reads as an admission rather than a
 * disclosure. Retention is the one place a limit IS named as absent, because a
 * reader asking "how long do you keep this" is owed the real answer.
 *
 * WHY SESSION REPLAY IS DISCLOSED IN THE PRESENT TENSE
 *
 * components/app/AmplitudeAnalytics.tsx on main no longer loads the replay
 * plugin at all. That commit is NOT deployed: the running release still calls
 * initAll() with sessionReplay sampleRate 1 from the root layout, so replay
 * covers the authenticated dashboard. Saying "we do not record sessions"
 * because the fix exists in git would describe a future state as current. The
 * disclosure comes out when the behaviour does, not before.
 *
 * ANCHORS ARE SLUGS, NOT ORDINALS
 *
 * These were #section-1 … #section-12, derived from array position, so any
 * renumbering silently broke every external link into the policy. Slugs survive
 * reordering; verify-content-integrity.ts enforces their uniqueness and shape.
 */

export const EFFECTIVE_DATE = 'September 3, 2026'
export const PRIVACY_EMAIL = 'support@backenly.com'

export type Provider = {
  name: string
  purpose: string
  /** What this provider can receive. Plain language, not schema field names. */
  data: string
  /** The provider's own privacy documentation. */
  href: string
}

/**
 * Third parties that can receive personal or customer data.
 *
 * Deliberately NOT a location column. Only one location is verified (Hetzner,
 * Singapore) and it is stated in the "Where information is processed" section.
 * A column of "unknown" cells looks like diligence and is the opposite; the
 * prose there says the honest thing instead.
 *
 * Two entries are absent on purpose. Google Fonts and Supademo sit in the CSP
 * allowlist in next.config.js with zero usage anywhere in the tree — fonts are
 * self-hosted through next/font, and nothing renders a Supademo embed. Listing
 * them would invent subprocessors that receive nothing.
 *
 * MongoDB is also absent. The code can reach MongoDB when MONGODB_URI is set,
 * through one gated route (app/api/database/rows), but production
 * configuration is unverified. Absence here means "not established", not
 * "confirmed inactive".
 */
export const PROVIDERS: Provider[] = [
  {
    name: 'Hetzner',
    purpose: 'Hosts the Backenly platform and your project databases',
    data: 'All platform and project data',
    href: 'https://www.hetzner.com/legal/privacy-policy/',
  },
  {
    name: 'Backblaze B2',
    purpose: 'Stores files uploaded to your projects',
    data: 'Files your application uploads',
    href: 'https://www.backblaze.com/company/privacy.html',
  },
  {
    name: 'Resend',
    purpose: 'Sends transactional email',
    data: 'Recipient email address and message contents',
    href: 'https://resend.com/legal/privacy-policy',
  },
  {
    name: 'OpenAI',
    purpose: 'Powers the AI assistant and backend generation',
    data: 'Your assistant messages, conversation history, project and table names',
    href: 'https://openai.com/policies/privacy-policy/',
  },
  {
    name: 'Amplitude',
    purpose: 'Product analytics and session replay',
    data: 'Page views, sessions, browser identifiers, and recordings of how the web app is used',
    href: 'https://amplitude.com/privacy',
  },
  {
    name: 'Sentry',
    purpose: 'Error and performance monitoring',
    data: 'Error messages, stack traces and request context',
    href: 'https://sentry.io/privacy/',
  },
  {
    name: 'Paddle',
    purpose: 'Sells and bills subscriptions as merchant of record',
    data: 'Your email address and chosen plan. Paddle collects payment details directly',
    href: 'https://www.paddle.com/legal/privacy',
  },
  {
    name: 'Cloudflare',
    purpose: 'Bot protection on the signup form',
    data: 'IP address and browser signals',
    href: 'https://www.cloudflare.com/privacypolicy/',
  },
  {
    name: 'Google',
    purpose: 'Sign-in, if you choose it',
    data: 'Your email address, name and account identifier',
    href: 'https://policies.google.com/privacy',
  },
  {
    name: 'GitHub',
    purpose: 'Sign-in, if you choose it',
    data: 'Your email address, name and account identifier',
    href: 'https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement',
  },
]

export type PrivacySection = {
  /** Slug anchor. Stable across reordering; must be unique. */
  id: string
  title: string
  content: string
  list?: string[]
  extra?: string
  subsections?: { label: string; items: string[] }[]
  /** Renders the PROVIDERS table under this section's body. */
  providers?: boolean
}

/**
 * The short version. Every line is a claim made in full below, including the
 * uncomfortable one about session recording — a summary carrying only the
 * reassuring half is worse than no summary at all.
 */
export const PRIVACY_SUMMARY = [
  'We do not run advertising and do not share your data with advertisers or data brokers',
  'Each project database runs in its own PostgreSQL schema',
  'We currently record sessions on the web app, including dashboard pages',
  'Paddle is the seller on your subscription. We never see your card details',
  'The platform runs on Hetzner infrastructure in Singapore',
  'You can export your project database at any time',
  'Deleting a project starts deletion. It is not a recovery window',
]

export const PRIVACY_SECTIONS: PrivacySection[] = [
  {
    id: 'who-we-are',
    title: 'Who we are and how to reach us',
    content:
      'Backenly operates the backenly.com platform: hosted PostgreSQL databases, APIs, authentication, storage and related backend services for developers and the applications they build. This policy explains what we collect when you use Backenly, why we process it, who else receives it, how long we keep it, and what happens when you ask us to delete it.',
    // The operating entity, stated as a fact the founder confirmed. No address:
    // a registered address is published once it is deliberately chosen, not
    // inferred, and nothing here requires one today.
    extra:
      `Backenly, Inc., a Delaware corporation, operates the Backenly service. For privacy questions or requests, contact ${PRIVACY_EMAIL}.`,
  },
  {
    id: 'scope',
    title: 'What this policy covers',
    content:
      'This policy covers the Backenly platform: the backenly.com website, the dashboard, the API and the MCP server.',
    list: [
      'It does not cover the applications you build on Backenly. If your app has its own users, its privacy practices are yours to describe to them.',
      'It does not cover a self-hosted Backenly deployment. Backenly is open source under Apache-2.0, and if you run it on your own infrastructure this policy does not apply to it.',
      'It does not cover services you connect to your own projects, such as a payment or email provider you configure with your own credentials.',
    ],
  },
  {
    id: 'roles',
    title: 'Your data and your users’ data',
    content:
      'Backenly holds two different kinds of information and it is worth separating them, because we treat them differently.',
    subsections: [
      {
        label: 'Information about you as a Backenly customer',
        items: [
          'Your account and how you sign in',
          'Your billing relationship with us',
          'How you use the dashboard and the assistant',
          'Your support messages',
        ],
      },
      {
        label: 'Data inside your projects',
        items: [
          'The tables you create and the rows your application writes',
          'Files your application uploads',
          'The accounts of your own end users',
          'We store and process this so your backend works. We do not decide what it contains and we do not use it for our own purposes.',
        ],
      },
    ],
    extra:
      'How these roles are characterised varies with the privacy law that applies. This section describes what the product does.',
  },
  {
    id: 'information-we-collect',
    title: 'Information we collect about you',
    content: 'Grouped by why it exists rather than by where it is stored.',
    subsections: [
      {
        label: 'Account',
        items: [
          'Name and email address',
          'A hashed password, if you sign in with one',
          'Whether your email is verified, and two-factor settings if you enable them',
          'Your plan, and referral attribution if you arrived through a referral link',
          'Sign-in and activity timestamps',
        ],
      },
      {
        label: 'Signup and anti-abuse',
        items: [
          'The IP address you signed up from',
          'A trust score calculated at signup, and the reasons behind it',
          'Blocklist entries for addresses, domains and mail hosts used for abuse',
        ],
      },
      {
        label: 'Authentication',
        items: [
          'Session and refresh tokens',
          'Password reset and email verification tokens, which expire',
          'API key hashes, key prefixes and usage timestamps',
        ],
      },
      {
        label: 'Billing',
        items: [
          'Your plan and subscription status',
          'Paddle customer and subscription identifiers',
          'Usage counters used to apply plan limits',
          'We never receive or store card numbers.',
        ],
      },
      {
        label: 'How you use Backenly',
        items: [
          'Projects you create and their configuration',
          'Your messages to the AI assistant and its replies',
          'A short excerpt of requests for things Backenly deliberately does not do, which we keep to guide what we build next',
          'API request paths, status codes and response times',
        ],
      },
      {
        label: 'Support and feedback',
        items: ['Support tickets and feature requests you submit in the dashboard'],
      },
      {
        label: 'Security',
        items: [
          'Records of blocked malicious requests, including the IP address, browser user agent, and the request that was blocked',
          'Security events, which can include your email address and IP address',
        ],
      },
    ],
  },
  {
    id: 'project-data',
    title: 'Data in your projects',
    content:
      'Backenly gives each project its own PostgreSQL schema. What goes into it is up to you.',
    list: [
      'When you enable end-user authentication, Backenly creates a users table in your project holding your users’ email addresses, hashed passwords, names and sign-in timestamps.',
      'Everything else is defined by you: your tables, your columns, your rows, the files your application uploads and the payloads it sends.',
      'Because you design that schema, we cannot tell you which categories of personal data it holds. If your application stores personal data about your users, you decide what and why.',
    ],
    extra:
      'We derive one thing from it for our own purposes: a monthly count of the distinct end users who signed in to each project, which is how paid plans are metered. That record holds an identifier, not your users’ names or email addresses.',
  },
  {
    id: 'how-we-use-it',
    title: 'How we use information',
    content: 'We process the information above to:',
    list: [
      'Run the platform and keep your projects working',
      'Authenticate you and keep accounts secure',
      'Detect and block abuse, including automated signups',
      'Apply plan limits and bill subscriptions',
      'Generate and repair backends from your instructions',
      'Send transactional email',
      'Answer support requests',
      'Understand which parts of the product are used',
      'Decide what to build next',
      'Meet legal obligations',
    ],
  },
  {
    id: 'ai',
    title: 'AI processing',
    content:
      'Backenly uses OpenAI to power the AI assistant and backend generation. When you send a message to the assistant, the following can be sent to OpenAI: your message, up to eight recent messages from the same conversation, your project’s name and description, the names of your tables, API paths and storage buckets, the names of your connected integrations, and short summaries of the actions the assistant takes.',
    list: [
      'The contents of your database rows are not routinely sent. When the assistant runs a query against your project it receives the number of rows returned, not the rows.',
      'If you paste data into a chat message, it is sent to OpenAI with the rest of your message.',
      'Database error messages can quote the value that caused the error, and those messages reach the assistant.',
      'Columns whose names look like credentials, such as password, secret, token or api_key, are replaced with [redacted] before query results are returned. That check reads column names, not contents, so a secret stored in a column called notes is not caught by it.',
      'Your integration credentials, API keys and password hashes are never sent to OpenAI.',
    ],
    extra:
      'OpenAI states that data sent to its API is not used to train its models unless a customer opts in, and that abuse monitoring logs are kept for up to 30 days. We use OpenAI’s standard configuration. Separately, if you connect a coding agent to Backenly over MCP, that agent can read your data, and what it reads goes to whichever AI provider that agent uses. That is your choice and this policy does not cover it.',
  },
  {
    id: 'analytics',
    title: 'Analytics',
    content:
      'Backenly uses Amplitude to understand how the product is used. It records page views and sessions, tied to a browser identifier rather than to your account.',
    list: [
      'Backenly currently uses Amplitude Session Replay on the web application, including authenticated dashboard pages.',
      'Session Replay records how pages are used, so it can capture what is displayed on screen. On a dashboard page that can include your project and table names and data shown in the interface.',
      'Backenly also uses Sentry to record errors. When something fails, Sentry receives the error, a stack trace and context about the request.',
    ],
    extra:
      'We do not run advertising and we do not share information with advertisers or data brokers.',
  },
  {
    id: 'payments',
    title: 'Payments',
    content:
      'Paddle sells and bills Backenly subscriptions as the merchant of record. Paddle is the seller on your transaction rather than only a payment processor, and it handles your payment details directly under its own privacy policy.',
    list: [
      'We send Paddle your email address and the plan you selected.',
      'Paddle sends back subscription identifiers and status.',
      'We never receive or store card numbers, expiry dates or security codes.',
    ],
  },
  {
    id: 'email',
    title: 'Email',
    content:
      'Backenly sends transactional email through Resend: email verification, password resets, organisation invitations, account lockout notices and billing notices. Resend receives the recipient address and the message.',
    extra:
      'Backenly also sends email on behalf of your projects when you enable end-user authentication, so your users receive verification and reset messages for your application. When we record whether a message was delivered we keep the recipient’s domain rather than the address, and we strip links out of any recorded text, because verification and reset links work as credentials.',
  },
  {
    id: 'providers',
    title: 'Service providers',
    content: 'These third parties can receive information when you use Backenly.',
    providers: true,
    extra:
      'Google and GitHub appear only if you choose to sign in with them. Paddle acts as the seller on your transaction rather than on our instructions. Providers you connect to your own projects are your relationships, not ours. The legal role of each provider depends on the service and the privacy law that applies.',
  },
  {
    id: 'international',
    title: 'Where information is processed',
    content:
      'Backenly’s platform and your project databases run on Hetzner infrastructure in Singapore.',
    list: [
      'The providers listed above operate their own infrastructure and may process information in other countries, including the United States.',
    ],
    extra:
      'Where information is processed outside the country where it was collected, we use applicable contractual and legal safeguards where required.',
  },
  {
    id: 'retention',
    title: 'How long we keep information',
    content: 'These periods are enforced automatically today:',
    list: [
      'API request logs: 30 days',
      'AI intent records: 30 days',
      'Successful webhook delivery records: 30 days',
      'Database performance samples: 14 days',
      'Project backups: 7 days',
    ],
    extra:
      'Beyond those, your account data, project data and AI conversation history are kept while your account and project exist. Other operational records, including security, audit and billing records, are currently kept without a fixed limit. We are putting defined limits in place, and this section will state them once they are enforced rather than before.',
  },
  {
    id: 'deletion',
    title: 'Deleting your data',
    content:
      'Cancelling a paid subscription does not delete anything. Your account and your projects stay, on the free plan.',
    list: [
      'Deleting a project or your account starts deletion of the project’s database contents, its backups and its stored files. It is not a recovery window and it is not reversible.',
      'Some of that removal completes on a delayed basis rather than at the moment you press the button.',
      'Security and anti-abuse records are kept afterwards, including blocklist entries, so that abuse cannot be reset by deleting and recreating an account. Some billing and audit records are also kept.',
    ],
    extra:
      'Copies held by the providers listed above are subject to their own retention. Deleting your Backenly account does not delete analytics data held by Amplitude, error reports held by Sentry, or the transaction records Paddle keeps as merchant of record.',
  },
  {
    id: 'export',
    title: 'Getting a copy of your data',
    content: 'You can export your project database at any time, without asking us.',
    list: [
      'Backenly produces a PostgreSQL dump of your project’s schema and data that restores onto any PostgreSQL server.',
      'Backenly can issue you read-only database credentials so you can connect with psql, a GUI client, or your own tooling.',
    ],
    extra:
      `Backenly does not currently provide a single account-level export bundling every category of information we hold, including account, billing, analytics and operational records. If you want those, email ${PRIVACY_EMAIL}.`,
  },
  {
    id: 'security',
    title: 'Security',
    content: 'Measures in place:',
    list: [
      'Passwords are hashed with bcrypt at cost factor 12, for Backenly accounts and for your applications’ end users',
      'Traffic is served over HTTPS, with HSTS',
      'Each project’s data lives in its own PostgreSQL schema',
      'Read access for AI queries runs as a project-scoped, select-only PostgreSQL role',
      'Each project has its own token signing secret, and the platform refuses to sign tokens without a configured secret rather than falling back to a default',
      'Integration credentials and project environment variables are encrypted with AES-256-GCM before storage',
      'Administrative changes require re-authentication',
    ],
    extra: 'No system is perfectly secure and we do not claim otherwise.',
  },
  {
    id: 'your-rights',
    title: 'Your rights',
    content:
      'Three different things get confused with each other here, so they are listed separately.',
    subsections: [
      {
        label: 'What you can do yourself',
        items: [
          'Update your profile',
          'Export your project database',
          'Issue and revoke API keys and database credentials',
          'Delete a project or your account',
        ],
      },
      {
        label: 'What we will do on request',
        items: [
          'Tell you what information we hold about you',
          'Correct it',
          'Delete what we are able to delete',
          'Answer questions about this policy',
          `Email ${PRIVACY_EMAIL}. We respond to privacy requests within 30 days.`,
        ],
      },
      {
        label: 'What the law may give you',
        items: [
          'Depending on where you live, you may have rights to access, correct, delete, port, restrict or object to processing, and to complain to a data protection authority.',
          'Which of these apply to you depends on the privacy laws in your jurisdiction. Contact us and we will help you exercise them.',
        ],
      },
    ],
  },
  {
    id: 'children',
    title: 'Children',
    content:
      'Backenly is not intended for people under 16 and we ask that they do not create an account. We do not verify age, and we do not knowingly collect personal information from children under 16.',
    extra: `If you believe a child has created an account, email ${PRIVACY_EMAIL} and we will remove it.`,
  },
  {
    id: 'changes',
    title: 'Changes to this policy',
    content:
      'We update this policy when what we do changes, and the effective date at the top of this page changes with it. For a significant change we will also give notice in the product.',
  },
]
