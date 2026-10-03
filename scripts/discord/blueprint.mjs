/**
 * Declarative description of the Backenly community Discord server.
 *
 * Nothing here talks to Discord. `setup-discord.mjs` reads this file and
 * reconciles a live guild against it, so editing this file and re-running the
 * script is the supported way to change the server.
 *
 * Two doors, one community: Backenly Cloud (managed) and Self-Hosted
 * (Apache-2.0, one deployment per project). Members pick one or both during
 * onboarding and the per-door categories unlock from that choice.
 */

/** Discord permission bits. Only the ones this blueprint uses. */
export const PERMISSIONS = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_AUDIT_LOG: 1n << 7n,
  STREAM: 1n << 9n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  USE_VAD: 1n << 25n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS: 1n << 36n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  MODERATE_MEMBERS: 1n << 40n,
};

/** Discord channel types. */
export const CHANNEL_TYPES = {
  TEXT: 0,
  VOICE: 2,
  CATEGORY: 4,
  ANNOUNCEMENT: 5,
  FORUM: 15,
};

/**
 * Permissions stripped from `allow` and added to `deny` on a read-only
 * channel, for every role except the ones in `READONLY_EXEMPT_ROLES`.
 */
export const POSTING_PERMISSIONS = [
  'SEND_MESSAGES',
  'SEND_MESSAGES_IN_THREADS',
  'CREATE_PUBLIC_THREADS',
  'CREATE_PRIVATE_THREADS',
];

export const READONLY_EXEMPT_ROLES = ['Core Team', 'Moderator'];

/**
 * The bot's own profile. Everything this script seeds — rules, start-here,
 * forum guidelines — is posted by the bot and carries this name and avatar, so
 * it should read as official platform communication rather than as a person.
 * A bot cannot post as a human account, and Discord stamps `APP` on bot and
 * webhook messages alike, so branding is the honest option rather than putting
 * a founder's name on an app badge.
 *
 * Discord rate-limits username changes to 2 per hour; the script only writes
 * when the current name differs.
 */
export const BOT_IDENTITY = {
  username: 'Backenly',
  avatar: 'public/apple-touch-icon.png',
};

export const GUILD = {
  name: 'Backenly',
  description:
    'The autonomous backend platform for agentic coding. Your coding agent builds it, Backenly keeps it running.',
  // Discord requires all three before a guild can be turned into a Community.
  verificationLevel: 1, // LOW: verified email required
  explicitContentFilter: 2, // ALL_MEMBERS
  defaultMessageNotifications: 1, // only @mentions
  preferredLocale: 'en-US',
  systemChannel: 'community/general',
};

/**
 * Roles, highest first. `Cloud` and `Self-Hosted` carry no permissions of
 * their own; they exist so onboarding can unlock the per-door categories.
 */
export const ROLES = [
  {
    key: 'core',
    name: 'Core Team',
    color: 0x8b5cf6,
    hoist: true,
    mentionable: true,
    permissions: [
      'KICK_MEMBERS',
      'BAN_MEMBERS',
      'MODERATE_MEMBERS',
      'MANAGE_MESSAGES',
      'MANAGE_THREADS',
      'MANAGE_CHANNELS',
      'MANAGE_ROLES',
      'MENTION_EVERYONE',
      'VIEW_AUDIT_LOG',
    ],
  },
  {
    key: 'moderator',
    name: 'Moderator',
    color: 0x7c3aed,
    hoist: true,
    mentionable: true,
    permissions: [
      'KICK_MEMBERS',
      'MODERATE_MEMBERS',
      'MANAGE_MESSAGES',
      'MANAGE_THREADS',
      'VIEW_AUDIT_LOG',
    ],
  },
  {
    key: 'contributor',
    name: 'Contributor',
    color: 0xe4e4e7,
    hoist: true,
    mentionable: true,
    permissions: [],
  },
  {
    key: 'cloud',
    name: 'Cloud',
    color: 0xa1a1aa,
    hoist: false,
    mentionable: true,
    permissions: [],
  },
  {
    key: 'selfhost',
    name: 'Self-Hosted',
    color: 0x71717a,
    hoist: false,
    mentionable: true,
    permissions: [],
  },
  { key: 'agent-claude', name: 'Claude Code', color: 0xd97757, hoist: false, mentionable: true, permissions: [], optional: true },
  { key: 'agent-cursor', name: 'Cursor', color: 0xa1a1aa, hoist: false, mentionable: true, permissions: [], optional: true },
  { key: 'agent-codex', name: 'Codex', color: 0xa1a1aa, hoist: false, mentionable: true, permissions: [], optional: true },
  { key: 'agent-other', name: 'Other Agent', color: 0x71717a, hoist: false, mentionable: true, permissions: [], optional: true },
];

/** Overwrite presets, referenced by category. */
const PUBLIC_READ = [
  {
    role: '@everyone',
    allow: ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY', 'ADD_REACTIONS', 'USE_EXTERNAL_EMOJIS'],
    deny: ['SEND_MESSAGES', 'CREATE_PUBLIC_THREADS', 'CREATE_PRIVATE_THREADS'],
  },
];

const PUBLIC_TALK = [
  {
    role: '@everyone',
    allow: [
      'VIEW_CHANNEL',
      'READ_MESSAGE_HISTORY',
      'SEND_MESSAGES',
      'SEND_MESSAGES_IN_THREADS',
      'CREATE_PUBLIC_THREADS',
      'ADD_REACTIONS',
      'EMBED_LINKS',
      'ATTACH_FILES',
      'USE_EXTERNAL_EMOJIS',
    ],
    deny: ['MENTION_EVERYONE'],
  },
];

/** A category only members holding `roleKey` can see. */
const gated = (roleKey) => [
  { role: '@everyone', deny: ['VIEW_CHANNEL'] },
  {
    role: roleKey,
    allow: [
      'VIEW_CHANNEL',
      'READ_MESSAGE_HISTORY',
      'SEND_MESSAGES',
      'SEND_MESSAGES_IN_THREADS',
      'CREATE_PUBLIC_THREADS',
      'ADD_REACTIONS',
      'EMBED_LINKS',
      'ATTACH_FILES',
      'USE_EXTERNAL_EMOJIS',
    ],
    deny: ['MENTION_EVERYONE'],
  },
  {
    role: 'core',
    allow: ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY', 'SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'MENTION_EVERYONE'],
  },
  {
    role: 'moderator',
    allow: ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY', 'SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS'],
  },
];

const STAFF_ONLY = [
  { role: '@everyone', deny: ['VIEW_CHANNEL'] },
  {
    role: 'core',
    allow: ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY', 'SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'CONNECT', 'SPEAK'],
  },
  {
    role: 'moderator',
    allow: ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY', 'SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'CONNECT', 'SPEAK'],
  },
];

const HELP_TAGS = [
  { name: 'Open', emoji_name: '🟣', moderated: false },
  { name: 'Answered', emoji_name: '✅', moderated: false },
  { name: 'Needs info', emoji_name: '❓', moderated: false },
  { name: 'Known issue', emoji_name: '🩹', moderated: true },
  { name: 'Stale', emoji_name: '💤', moderated: true },
];

const BUG_TAGS = [
  { name: 'Needs triage', emoji_name: '🔍', moderated: false },
  { name: 'Confirmed', emoji_name: '🔴', moderated: true },
  { name: 'Fixed', emoji_name: '✅', moderated: true },
  { name: 'Not a bug', emoji_name: '⚪', moderated: true },
  { name: 'Install', emoji_name: '📦', moderated: false },
  { name: 'Autonomy', emoji_name: '🔁', moderated: false },
  { name: 'MCP', emoji_name: '🔌', moderated: false },
];

/**
 * Categories in display order. Every channel `key` is `<category>/<slug>` and
 * is what content files, onboarding, and the welcome screen refer to.
 */
export const CATEGORIES = [
  {
    key: 'start',
    name: '📍 Start Here',
    overwrites: PUBLIC_READ,
    channels: [
      {
        key: 'start/rules',
        name: '📜｜rules',
        type: 'TEXT',
        topic: 'How we behave here. Joining the server means you have read this.',
        readonly: true,
        seed: 'rules',
        role: 'rules', // becomes the Community rules channel
      },
      {
        key: 'start/welcome',
        name: '👋｜welcome',
        type: 'TEXT',
        topic: 'What this server is, who runs it, and where to go next.',
        readonly: true,
        seed: 'welcome',
      },
      {
        key: 'start/how-backenly-works',
        name: '🧭｜how-backenly-works',
        type: 'TEXT',
        topic: 'Backenly in five minutes: the MCP door, the governed kernel, the autonomy loop, and the two ways to run it.',
        readonly: true,
        seed: 'how-backenly-works',
      },
    ],
  },
  {
    key: 'news',
    name: '📣 Announcements',
    overwrites: PUBLIC_READ,
    channels: [
      {
        key: 'news/announcements',
        name: '📣｜announcements',
        type: 'ANNOUNCEMENT',
        topic: 'Releases, breaking changes, and anything that needs everyone to read it. Low volume.',
        readonly: true,
      },
      {
        key: 'news/status',
        name: '🚦｜status',
        type: 'ANNOUNCEMENT',
        topic: 'Incidents and maintenance for the managed platform at backenly.com. Self-hosted deployments are not covered here.',
        readonly: true,
      },
      {
        key: 'news/blog',
        name: '📰｜blog',
        type: 'ANNOUNCEMENT',
        topic: 'Writing from the team: architecture notes, post-mortems, and what we are learning building this.',
        readonly: true,
        optional: true,
      },
    ],
  },
  {
    key: 'community',
    name: '💬 Community',
    overwrites: PUBLIC_TALK,
    channels: [
      {
        key: 'community/general',
        name: '💬｜general',
        type: 'TEXT',
        topic: 'Backends, agents, Postgres, and everything around them. Support questions belong in the help forums.',
      },
      {
        key: 'community/introductions',
        name: '🙋｜introductions',
        type: 'TEXT',
        topic: 'What you are building, what you are building it with, and what you want out of a backend.',
      },
      {
        key: 'community/showcase',
        name: '🛠️｜showcase',
        type: 'TEXT',
        topic: 'Ship something on Backenly and show it here. Screenshots, repos, live links.',
      },
      {
        key: 'community/agent-workflows',
        name: '🤖｜agent-workflows',
        type: 'TEXT',
        topic: 'Prompts, rules files, MCP configs, and the workflows that make a coding agent good at backend work.',
      },
      {
        key: 'community/off-topic',
        name: '🎲｜off-topic',
        type: 'TEXT',
        // Not optional: Discord requires 5 default channels @everyone can post
        // in before it will enable onboarding, and this is the fifth.
        topic: 'Everything else.',
      },
      {
        // Open call with the team; times are posted in announcements.
        // Voice channels take no topic, so that note lives here, not in Discord.
        key: 'community/office-hours',
        name: '🎙️｜office-hours',
        type: 'VOICE',
        optional: true,
      },
    ],
  },
  {
    key: 'cloud',
    name: '☁️ Backenly Cloud',
    overwrites: gated('cloud'),
    channels: [
      {
        key: 'cloud/start-here',
        name: '📖｜cloud-start-here',
        type: 'TEXT',
        topic: 'Connect your coding agent to a managed project in about two minutes.',
        readonly: true,
        seed: 'cloud-start-here',
      },
      {
        key: 'cloud/changelog',
        name: '🗒️｜cloud-changelog',
        type: 'ANNOUNCEMENT',
        topic: 'What shipped to backenly.com. Continuously deployed, so this is the record of it.',
        readonly: true,
      },
      {
        key: 'cloud/help-agent',
        name: '🤖｜cloud-help-agent',
        type: 'FORUM',
        topic:
          'Your agent did something to a managed project and you want a second pair of eyes.\n\nOne post per problem. Include: the project, the tool call your agent made, what came back, and what you expected. Paste the transcript rather than summarising it. Tag the post Answered when it is.',
        tags: HELP_TAGS,
        defaultReaction: '👍',
        seedThread: { name: 'Read this before posting', file: 'help-agent-guidelines' },
      },
      {
        key: 'cloud/help-human',
        name: '🙋｜cloud-help-human',
        type: 'FORUM',
        topic:
          'Questions about the managed platform that are not about a specific agent run: projects, dashboard, keys, limits, billing.\n\nOne post per question. Tag it Answered when it is resolved so the next person can tell.',
        tags: HELP_TAGS,
        defaultReaction: '👍',
        seedThread: { name: 'Read this before posting', file: 'help-human-guidelines' },
      },
      {
        key: 'cloud/chat',
        name: '💬｜cloud-chat',
        type: 'TEXT',
        topic: 'Loose talk about the managed platform. Anything that needs an answer goes in the help forums.',
      },
      {
        key: 'cloud/billing',
        name: '💳｜billing-and-plans',
        type: 'TEXT',
        topic: 'Plans, AI credits, invoices, and quota questions. Never post an invoice, key, or account email here — mail support@backenly.com.',
        optional: true,
      },
      {
        key: 'cloud/feature-requests',
        name: '💡｜cloud-feature-requests',
        type: 'TEXT',
        topic: 'What the managed platform should do that it does not. One idea per message so reactions mean something.',
      },
    ],
  },
  {
    key: 'selfhost',
    name: '🧱 Self-Hosted',
    overwrites: gated('selfhost'),
    channels: [
      {
        key: 'selfhost/start-here',
        name: '📖｜selfhost-start-here',
        type: 'TEXT',
        topic: 'Install, claim, and run your own deployment. One deployment is one project.',
        readonly: true,
        seed: 'selfhost-start-here',
      },
      {
        key: 'selfhost/releases',
        name: '🏷️｜releases',
        type: 'ANNOUNCEMENT',
        topic: 'Tagged releases of the Apache-2.0 platform, with upgrade notes and anything that needs a manual step.',
        readonly: true,
      },
      {
        key: 'selfhost/help-agent',
        name: '🤖｜selfhost-help-agent',
        type: 'FORUM',
        topic:
          'Agent-driven changes against your own deployment.\n\nOne post per problem. Include your version, the tool call, the response, and the relevant lines from the web and runtime logs. Redact secrets before pasting — .env, tokens, connection strings.',
        tags: HELP_TAGS,
        defaultReaction: '👍',
        seedThread: { name: 'Read this before posting', file: 'help-agent-guidelines' },
      },
      {
        key: 'selfhost/help-human',
        name: '🙋｜selfhost-help-human',
        type: 'FORUM',
        topic:
          'Install, upgrade, Docker, Postgres, PostgREST, and operations questions for deployments you run yourself.\n\nOne post per question. Include your OS, Node version, and whether you are using the bundled Compose stack or your own database.',
        tags: HELP_TAGS,
        defaultReaction: '👍',
        seedThread: { name: 'Read this before posting', file: 'help-human-guidelines' },
      },
      {
        key: 'selfhost/chat',
        name: '💬｜selfhost-chat',
        type: 'TEXT',
        topic: 'Running Backenly on your own infrastructure. Anything that needs an answer goes in the help forums.',
      },
      {
        key: 'selfhost/file-a-bug',
        name: '🐞｜file-a-bug',
        type: 'FORUM',
        topic:
          'Reproducible defects in the open-source platform.\n\nNot for security issues — those go to support@backenly.com with SECURITY in the subject, never to a public channel. One post per bug: version, steps, expected, actual. A GitHub issue is still the canonical place; this forum is where we work out whether it is one.',
        tags: BUG_TAGS,
        defaultReaction: '👀',
        seedThread: { name: 'How to file a bug we can act on', file: 'file-a-bug-guidelines' },
      },
      {
        key: 'selfhost/feature-requests',
        name: '💡｜selfhost-feature-requests',
        type: 'TEXT',
        topic: 'What the platform should do that it does not. One idea per message so reactions mean something.',
      },
      {
        key: 'selfhost/contributing',
        name: '🧰｜contributing',
        type: 'TEXT',
        topic: 'Working on the codebase itself: setup, tests, conventions, and PRs in flight.',
        seed: 'contributing',
      },
    ],
  },
  {
    key: 'team',
    name: '🔒 Core Team',
    overwrites: STAFF_ONLY,
    channels: [
      {
        key: 'team/team',
        name: '🧭｜team',
        type: 'TEXT',
        topic: 'Internal coordination.',
      },
      {
        key: 'team/mod-log',
        name: '🛡️｜mod-log',
        type: 'TEXT',
        topic: 'Moderation actions and the reasoning behind them.',
      },
      {
        key: 'team/discord-updates',
        name: '📡｜discord-updates',
        type: 'TEXT',
        topic: 'Where Discord posts Community notices for this server.',
        role: 'public-updates',
      },
      {
        key: 'team/voice',
        name: '🎧｜team-voice',
        type: 'VOICE',
        optional: true,
      },
    ],
  },
];

/**
 * Onboarding. Prompt one is the two-door question and is required; it grants
 * the role that unlocks each category. Prompt two is texture for us and is
 * skipped by `--minimal`.
 */
export const ONBOARDING = {
  mode: 1, // ONBOARDING_ADVANCED
  defaultChannels: [
    'start/rules',
    'start/welcome',
    'start/how-backenly-works',
    'news/announcements',
    'community/general',
    'community/introductions',
    'community/showcase',
    'community/agent-workflows',
    'community/off-topic',
  ],
  prompts: [
    {
      title: 'How are you running Backenly?',
      singleSelect: false,
      required: true,
      options: [
        {
          title: 'Backenly Cloud',
          description: 'Managed at backenly.com. Nothing to install or operate.',
          emoji: '☁️',
          roles: ['cloud'],
          channels: ['cloud/start-here', 'cloud/help-agent', 'cloud/help-human', 'cloud/chat', 'cloud/feature-requests'],
        },
        {
          title: 'Self-Hosted',
          description: 'Apache-2.0, on your own infrastructure. One deployment is one project.',
          emoji: '🧱',
          roles: ['selfhost'],
          channels: [
            'selfhost/start-here',
            'selfhost/help-agent',
            'selfhost/help-human',
            'selfhost/chat',
            'selfhost/file-a-bug',
            'selfhost/contributing',
          ],
        },
      ],
    },
    {
      title: 'Which coding agent do you drive it with?',
      singleSelect: false,
      required: false,
      optional: true,
      options: [
        { title: 'Claude Code', description: 'Anthropic, terminal and IDE.', emoji: '🟠', roles: ['agent-claude'], channels: [] },
        { title: 'Cursor', description: 'The editor.', emoji: '⬛', roles: ['agent-cursor'], channels: [] },
        { title: 'Codex', description: 'OpenAI.', emoji: '⚪', roles: ['agent-codex'], channels: [] },
        { title: 'Something else', description: 'Any other MCP client, or none yet.', emoji: '🔌', roles: ['agent-other'], channels: [] },
      ],
    },
  ],
};

/**
 * Welcome screen. At most five channels, and every one of them must be
 * visible to `@everyone` — Discord rejects the whole payload with a bare
 * `Invalid Form Body` if any entry sits in a gated category. That rules out
 * the per-door start-here channels, which is fine: onboarding is what routes
 * people to those.
 */
export const WELCOME_SCREEN = {
  description: 'The autonomous backend platform for agentic coding. Pick your door below.',
  channels: [
    { key: 'start/rules', description: 'Read this first', emoji: '📜' },
    { key: 'start/welcome', description: 'Cloud or self-hosted: pick a door', emoji: '👋' },
    { key: 'start/how-backenly-works', description: 'What Backenly actually does', emoji: '🧭' },
    { key: 'community/introductions', description: 'Say hello', emoji: '🙋' },
    { key: 'community/showcase', description: 'See what people shipped', emoji: '🛠️' },
  ],
};
