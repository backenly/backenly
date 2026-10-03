#!/usr/bin/env node
/**
 * Reconciles a Discord guild against scripts/discord/blueprint.mjs.
 *
 * It is a reconciler, not an installer: it creates what is missing, updates
 * what has drifted, and leaves everything else alone. Running it twice is the
 * expected path, not a failure. It never deletes a channel or a role.
 *
 *   node scripts/discord/setup-discord.mjs --guild <guild id> --dry-run
 *   node scripts/discord/setup-discord.mjs --guild <guild id>
 *
 * The bot token comes from DISCORD_BOT_TOKEN and is never written anywhere.
 *
 * Flags:
 *   --guild <id>     Target guild. Defaults to DISCORD_GUILD_ID.
 *   --dry-run        Print the plan. Touches nothing.
 *   --minimal        Skip every channel, role, and prompt marked optional.
 *   --reseed         Delete the bot's own seeded messages and post them again.
 *   --rename         Also set the guild name from the blueprint.
 *   --icon <path>    Upload a PNG/JPG as the server icon.
 *   --no-onboarding  Skip onboarding and the welcome screen.
 *   --no-content     Skip seeding channel content.
 *   --validate       Check the blueprint and content offline. No token needed.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOT_IDENTITY,
  PERMISSIONS,
  CHANNEL_TYPES,
  POSTING_PERMISSIONS,
  READONLY_EXEMPT_ROLES,
  GUILD,
  ROLES,
  CATEGORIES,
  ONBOARDING,
  WELCOME_SCREEN,
} from './blueprint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.join(HERE, 'content');
const API = 'https://discord.com/api/v10';
const SPLIT_MARKER = '<!-- split -->';
const MESSAGE_LIMIT = 2000;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const flags = {
    guild: process.env.DISCORD_GUILD_ID || null,
    dryRun: false,
    minimal: false,
    reseed: false,
    rename: false,
    icon: null,
    onboarding: true,
    content: true,
    validate: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--guild') flags.guild = argv[++i];
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--minimal') flags.minimal = true;
    else if (arg === '--reseed') flags.reseed = true;
    else if (arg === '--rename') flags.rename = true;
    else if (arg === '--icon') flags.icon = argv[++i];
    else if (arg === '--no-onboarding') flags.onboarding = false;
    else if (arg === '--no-content') flags.content = false;
    else if (arg === '--validate') flags.validate = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return flags;
}

// ------------------------------------------------------------------ logging

const styles = { dim: '[2m', bold: '[1m', reset: '[0m' };
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (style, text) => (useColor ? `${styles[style]}${text}${styles.reset}` : text);

let currentPhase = 0;
function phase(title) {
  currentPhase += 1;
  process.stdout.write(`\n${paint('bold', `${currentPhase}. ${title}`)}\n`);
}
const created = (what) => console.log(`   + ${what}`);
const updated = (what) => console.log(`   ~ ${what}`);
const kept = (what) => console.log(paint('dim', `   = ${what}`));
const skipped = (what) => console.log(paint('dim', `   - ${what}`));
const warn = (what) => console.log(`   ! ${what}`);

// ------------------------------------------------------------- discord rest

class DiscordError extends Error {
  constructor(status, body, method, endpoint) {
    const code = body?.code;
    const detail = body?.message || JSON.stringify(body);
    super(`${method} ${endpoint} -> ${status}${code ? ` (code ${code})` : ''}: ${detail}`);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let token = null;

async function api(method, endpoint, body, { reason, attempt = 0 } = {}) {
  const headers = {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'BackenlyCommunitySetup (https://backenly.com, 1.0)',
  };
  if (reason) headers['X-Audit-Log-Reason'] = reason.slice(0, 500);

  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 429) {
    const payload = await response.json().catch(() => ({}));
    const waitMs = Math.ceil((payload.retry_after ?? 1) * 1000) + 100;
    if (attempt >= 5) throw new DiscordError(429, payload, method, endpoint);
    warn(`rate limited, waiting ${waitMs}ms`);
    await sleep(waitMs);
    return api(method, endpoint, body, { reason, attempt: attempt + 1 });
  }

  if (response.status >= 500 && attempt < 3) {
    await sleep(500 * (attempt + 1));
    return api(method, endpoint, body, { reason, attempt: attempt + 1 });
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ message: response.statusText }));
    throw new DiscordError(response.status, payload, method, endpoint);
  }

  // Stay well inside the per-route buckets; this script is not in a hurry.
  const remaining = Number(response.headers.get('x-ratelimit-remaining'));
  if (Number.isFinite(remaining) && remaining <= 1) {
    const resetAfter = Number(response.headers.get('x-ratelimit-reset-after')) || 1;
    await sleep(Math.ceil(resetAfter * 1000) + 50);
  } else {
    await sleep(120);
  }

  if (response.status === 204) return null;
  return response.json();
}

// --------------------------------------------------------------- blueprint helpers

/**
 * Discord refuses to let a bot create a role carrying a permission the bot
 * does not itself hold, so the invite must grant the union of everything the
 * script does AND everything the blueprint's roles ask for. Derived rather
 * than hand-written, because hand-writing it is what broke the first run.
 */
export function requiredInvitePermissions() {
  const operational = [
    'CREATE_INSTANT_INVITE',
    'MANAGE_CHANNELS',
    'MANAGE_GUILD',
    'ADD_REACTIONS',
    'VIEW_CHANNEL',
    'SEND_MESSAGES',
    'MANAGE_MESSAGES',
    'EMBED_LINKS',
    'ATTACH_FILES',
    'READ_MESSAGE_HISTORY',
    'MANAGE_ROLES',
    'MANAGE_THREADS',
    'CREATE_PUBLIC_THREADS',
    'SEND_MESSAGES_IN_THREADS',
  ];
  let total = bits(operational);
  for (const role of ROLES) total |= bits(role.permissions);
  return total;
}

const inviteUrl = (clientId = 'YOUR_APP_ID') =>
  `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${requiredInvitePermissions()}`;

const bits = (names = []) =>
  names.reduce((acc, name) => {
    const bit = PERMISSIONS[name];
    if (bit === undefined) throw new Error(`Unknown permission in blueprint: ${name}`);
    return acc | bit;
  }, 0n);

/** Discord lowercases text channel names and turns spaces into hyphens. */
const normalizeChannelName = (name) => name.toLowerCase().replace(/\s+/g, '-');

const include = (item, minimal) => !(minimal && item.optional);

function activeCategories(minimal) {
  return CATEGORIES.map((category) => ({
    ...category,
    channels: category.channels.filter((channel) => include(channel, minimal)),
  })).filter((category) => category.channels.length > 0);
}

// ------------------------------------------------------------------- roles

async function reconcileRoles(guildId, flags, botId) {
  phase('Roles');
  const existing = await api('GET', `/guilds/${guildId}/roles`);
  const byName = new Map(existing.map((role) => [role.name, role]));
  const resolved = new Map([['@everyone', guildId]]);

  // The bot's own managed role, so every category can grant it access to what
  // it is about to build. Without this it locks itself out of read-only areas.
  const botRole = existing.find((role) => role.tags?.bot_id === botId);
  if (botRole) {
    resolved.set(BOT_ROLE_KEY, botRole.id);
    kept(`bot role "${botRole.name}" will be granted access to every category`);
  } else {
    warn('could not find the bot\'s own role; read-only categories may reject channel creation');
  }

  const wanted = ROLES.filter((role) => include(role, flags.minimal));

  for (const role of wanted) {
    const payload = {
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: bits(role.permissions).toString(),
    };
    const match = byName.get(role.name);

    if (!match) {
      if (flags.dryRun) {
        created(`role ${role.name}`);
        resolved.set(role.key, `dry-role-${role.key}`);
        resolved.set(role.name, `dry-role-${role.key}`);
        continue;
      }
      const fresh = await api('POST', `/guilds/${guildId}/roles`, payload, {
        reason: 'Backenly community server setup',
      });
      created(`role ${role.name}`);
      resolved.set(role.key, fresh.id);
      resolved.set(role.name, fresh.id);
      continue;
    }

    resolved.set(role.key, match.id);
    resolved.set(role.name, match.id);

    const drifted =
      match.color !== role.color ||
      match.hoist !== role.hoist ||
      match.mentionable !== role.mentionable ||
      match.permissions !== payload.permissions;

    if (!drifted) {
      kept(`role ${role.name}`);
      continue;
    }
    if (flags.dryRun) {
      updated(`role ${role.name} (colour/permissions drifted)`);
      continue;
    }
    await api('PATCH', `/guilds/${guildId}/roles/${match.id}`, payload, {
      reason: 'Backenly community server setup',
    });
    updated(`role ${role.name}`);
  }

  for (const role of ROLES) {
    if (!include(role, flags.minimal)) skipped(`role ${role.name} (--minimal)`);
  }

  return resolved;
}

async function orderRoles(guildId, roleIds, flags) {
  const wanted = ROLES.filter((role) => roleIds.has(role.key));
  if (flags.dryRun || wanted.length === 0) return;
  // Highest blueprint role gets the highest position the bot can still assign.
  const payload = wanted.map((role, index) => ({
    id: roleIds.get(role.key),
    position: wanted.length - index,
  }));
  try {
    await api('PATCH', `/guilds/${guildId}/roles`, payload, { reason: 'Backenly role order' });
    updated('role order');
  } catch (error) {
    warn(`could not reorder roles (${error.code ?? error.status}). Drag them in Server Settings once; the rest is fine.`);
  }
}

// ---------------------------------------------------------------- overwrites

/**
 * Channel permissions the bot grants itself on every category it manages.
 *
 * Discord evaluates a bot's permissions inside the target category, and refuses
 * to let it write an overwrite for a permission it does not hold *there*. A
 * read-only category denies SEND_MESSAGES to @everyone, and with no overwrite
 * of its own the bot inherits that deny — so it can neither create channels
 * with overwrites under that category nor seed content into them. An explicit
 * self-overwrite is what keeps the bot able to manage what it built.
 */
const BOT_CHANNEL_PERMISSIONS = [
  'VIEW_CHANNEL',
  'READ_MESSAGE_HISTORY',
  'SEND_MESSAGES',
  'SEND_MESSAGES_IN_THREADS',
  'CREATE_PUBLIC_THREADS',
  'CREATE_PRIVATE_THREADS',
  'MANAGE_MESSAGES',
  'MANAGE_THREADS',
  'MANAGE_CHANNELS',
  'MANAGE_ROLES',
  'EMBED_LINKS',
  'ATTACH_FILES',
  'ADD_REACTIONS',
  'USE_EXTERNAL_EMOJIS',
  'CREATE_INSTANT_INVITE',
  'CONNECT',
  'SPEAK',
];

/** Reserved key for the bot's own managed role in the resolved-roles map. */
const BOT_ROLE_KEY = '@bot';

function buildOverwrites(specs, roleIds, { readonly = false } = {}) {
  const botRoleId = roleIds.get(BOT_ROLE_KEY);
  const exemptIds = new Set(READONLY_EXEMPT_ROLES.map((name) => roleIds.get(name)).filter(Boolean));
  if (botRoleId) exemptIds.add(botRoleId);

  const withBot = botRoleId
    ? [...specs.filter((spec) => spec.role !== BOT_ROLE_KEY), { role: BOT_ROLE_KEY, allow: BOT_CHANNEL_PERMISSIONS }]
    : specs;

  return withBot
    .map((spec) => {
      const id = roleIds.get(spec.role);
      if (!id) return null;

      let allow = bits(spec.allow);
      let deny = bits(spec.deny);

      if (readonly && !exemptIds.has(id)) {
        const posting = bits(POSTING_PERMISSIONS);
        allow &= ~posting;
        deny |= posting;
      }

      return { id, type: 0, allow: allow.toString(), deny: deny.toString() };
    })
    .filter(Boolean);
}

const sameOverwrites = (a = [], b = []) => {
  const key = (list) =>
    [...list]
      .map((o) => `${o.id}:${o.allow}:${o.deny}`)
      .sort()
      .join('|');
  return key(a) === key(b);
};

// ------------------------------------------------------------------ community

let communityEnabled = false;

async function ensureCommunity(guildId, guild, channelIds, flags) {
  if (communityEnabled) return true;
  if (guild.features?.includes('COMMUNITY')) {
    communityEnabled = true;
    kept('Community already enabled');
    return true;
  }

  const rulesId = channelIds.get('start/rules');
  const updatesId = channelIds.get('team/discord-updates');
  if (!rulesId || !updatesId) {
    warn('cannot enable Community without the rules and discord-updates channels');
    return false;
  }

  if (flags.dryRun) {
    updated('enable Community (unlocks announcement and forum channels)');
    communityEnabled = true;
    return true;
  }

  try {
    await api(
      'PATCH',
      `/guilds/${guildId}`,
      {
        features: [...new Set([...(guild.features ?? []), 'COMMUNITY'])],
        rules_channel_id: rulesId,
        public_updates_channel_id: updatesId,
        verification_level: GUILD.verificationLevel,
        explicit_content_filter: GUILD.explicitContentFilter,
        default_message_notifications: GUILD.defaultMessageNotifications,
        preferred_locale: GUILD.preferredLocale,
      },
      { reason: 'Backenly community server setup' },
    );
    updated('Community enabled');
    communityEnabled = true;

    // Description is only accepted once the guild is a Community.
    await api('PATCH', `/guilds/${guildId}`, { description: GUILD.description }).catch(() => {});
    return true;
  } catch (error) {
    warn(`could not enable Community: ${error.message}`);
    warn('Enable it by hand (Server Settings -> Enable Community) and re-run. The server owner needs a verified email.');
    return false;
  }
}

// ------------------------------------------------------------------ channels

async function reconcileChannels(guildId, guild, flags) {
  const categories = activeCategories(flags.minimal);
  const existing = await api('GET', `/guilds/${guildId}/channels`);
  const channelIds = new Map();
  const roleIds = flags.roleIds;

  const findCategory = (name) =>
    existing.find((c) => c.type === CHANNEL_TYPES.CATEGORY && c.name.toLowerCase() === name.toLowerCase());
  const findChannel = (name, parentId) =>
    existing.find(
      (c) =>
        c.type !== CHANNEL_TYPES.CATEGORY &&
        normalizeChannelName(c.name) === normalizeChannelName(name) &&
        (parentId ? c.parent_id === parentId : true),
    );

  // ---- categories
  phase('Categories');
  const categoryIds = new Map();
  for (const category of categories) {
    const overwrites = buildOverwrites(category.overwrites, roleIds);
    const match = findCategory(category.name);
    if (match) {
      categoryIds.set(category.key, match.id);
      if (!flags.dryRun && !sameOverwrites(match.permission_overwrites, overwrites)) {
        await api('PATCH', `/channels/${match.id}`, { permission_overwrites: overwrites }, {
          reason: 'Backenly community server setup',
        });
        updated(`${category.name} (permissions)`);
      } else {
        kept(category.name);
      }
      continue;
    }
    if (flags.dryRun) {
      created(category.name);
      categoryIds.set(category.key, `dry-cat-${category.key}`);
      continue;
    }
    const fresh = await api(
      'POST',
      `/guilds/${guildId}/channels`,
      { name: category.name, type: CHANNEL_TYPES.CATEGORY, permission_overwrites: overwrites },
      { reason: 'Backenly community server setup' },
    );
    categoryIds.set(category.key, fresh.id);
    created(category.name);
  }

  // ---- pass A: plain text and voice channels (no Community required)
  const needsCommunity = (spec) => spec.type === 'ANNOUNCEMENT' || spec.type === 'FORUM';

  const createChannel = async (category, spec) => {
    const parentId = categoryIds.get(category.key);
    const overwrites = buildOverwrites(category.overwrites, roleIds, { readonly: spec.readonly });
    const match = findChannel(spec.name, parentId) || findChannel(spec.name, null);

    if (match) {
      channelIds.set(spec.key, match.id);
      const patch = {};
      if (match.parent_id !== parentId && !String(parentId).startsWith('dry-')) patch.parent_id = parentId;
      // Voice channels have no topic field; sending one is a 400.
      if (spec.topic && spec.type !== 'VOICE' && match.topic !== spec.topic) patch.topic = spec.topic;
      if (!sameOverwrites(match.permission_overwrites, overwrites)) patch.permission_overwrites = overwrites;

      if (Object.keys(patch).length === 0) {
        kept(spec.name);
        return;
      }
      if (flags.dryRun) {
        updated(`${spec.name} (${Object.keys(patch).join(', ')})`);
        return;
      }
      await api('PATCH', `/channels/${match.id}`, patch, { reason: 'Backenly community server setup' });
      updated(spec.name);
      return;
    }

    if (flags.dryRun) {
      created(`${spec.name} ${paint('dim', `(${spec.type.toLowerCase()})`)}`);
      channelIds.set(spec.key, `dry-chan-${spec.key}`);
      return;
    }

    const payload = {
      name: spec.name,
      type: CHANNEL_TYPES[spec.type],
      parent_id: parentId,
      permission_overwrites: overwrites,
    };
    if (spec.topic && spec.type !== 'VOICE') payload.topic = spec.topic;
    if (spec.type === 'FORUM') {
      payload.available_tags = spec.tags ?? [];
      payload.default_forum_layout = 1; // list view
      if (spec.defaultReaction) payload.default_reaction_emoji = { emoji_id: null, emoji_name: spec.defaultReaction };
    }

    const fresh = await api('POST', `/guilds/${guildId}/channels`, payload, {
      reason: 'Backenly community server setup',
    });
    channelIds.set(spec.key, fresh.id);
    created(`${spec.name} ${paint('dim', `(${spec.type.toLowerCase()})`)}`);
  };

  phase('Text and voice channels');
  for (const category of categories) {
    for (const spec of category.channels) {
      if (needsCommunity(spec)) continue;
      await createChannel(category, spec);
    }
  }

  // ---- Community, then pass B
  phase('Community features');
  const communityOk = await ensureCommunity(guildId, guild, channelIds, flags);

  phase('Announcement and forum channels');
  if (!communityOk) {
    warn('skipped: Community is not enabled on this guild');
  } else {
    for (const category of categories) {
      for (const spec of category.channels) {
        if (!needsCommunity(spec)) continue;
        await createChannel(category, spec);
      }
    }
  }

  // ---- ordering
  phase('Ordering');
  if (flags.dryRun) {
    kept('positions follow the blueprint order');
  } else {
    const positions = [];
    categories.forEach((category, index) => {
      const id = categoryIds.get(category.key);
      if (id) positions.push({ id, position: index });
      category.channels.forEach((spec, childIndex) => {
        const childId = channelIds.get(spec.key);
        // No parent_id here: Discord rejects a bulk reorder that reparents more
        // than one channel at a time (40009), and parents are already correct
        // from creation or from the per-channel patch above.
        if (childId) positions.push({ id: childId, position: childIndex });
      });
    });
    try {
      await api('PATCH', `/guilds/${guildId}/channels`, positions, { reason: 'Backenly channel order' });
      updated(`${positions.length} channels placed`);
    } catch (error) {
      warn(`could not set channel order: ${error.message}`);
    }
  }

  return { channelIds, categoryIds, communityOk };
}

// ------------------------------------------------------------------- content

function chunkMessage(text) {
  const chunks = [];
  for (const block of text.split(SPLIT_MARKER)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.length <= MESSAGE_LIMIT) {
      chunks.push(trimmed);
      continue;
    }
    // Fall back to paragraph packing so nothing is truncated silently.
    let buffer = '';
    for (const paragraph of trimmed.split(/\n\n+/)) {
      if (paragraph.length > MESSAGE_LIMIT) {
        throw new Error(`A single paragraph exceeds Discord's ${MESSAGE_LIMIT} character limit. Add a ${SPLIT_MARKER} marker.`);
      }
      if ((buffer + '\n\n' + paragraph).trim().length > MESSAGE_LIMIT) {
        chunks.push(buffer.trim());
        buffer = paragraph;
      } else {
        buffer = `${buffer}\n\n${paragraph}`;
      }
    }
    if (buffer.trim()) chunks.push(buffer.trim());
  }
  return chunks;
}

/**
 * Discord posts a type-6 "pinned a message" system message whenever something
 * is pinned. In a seeded channel that is pure noise, so clear the ones this
 * bot caused. Only ever touches system notices, never real content.
 */
async function removePinNotices(channelId, botId) {
  const CHANNEL_PINNED_MESSAGE = 6;
  const history = await api('GET', `/channels/${channelId}/messages?limit=50`).catch(() => []);
  for (const message of history) {
    if (message.type !== CHANNEL_PINNED_MESSAGE || message.author?.id !== botId) continue;
    await api('DELETE', `/channels/${channelId}/messages/${message.id}`, undefined, {
      reason: 'Backenly: clearing pin system notice',
    }).catch(() => {});
  }
}

async function loadContent(name) {
  const file = path.join(CONTENT_DIR, `${name}.md`);
  if (!existsSync(file)) throw new Error(`Missing content file: ${file}`);
  return readFile(file, 'utf8');
}

async function seedChannels(channelIds, botId, flags) {
  phase('Channel content');
  const categories = activeCategories(flags.minimal);

  for (const category of categories) {
    for (const spec of category.channels) {
      const channelId = channelIds.get(spec.key);
      if (!channelId) continue;

      if (spec.seed) {
        const chunks = chunkMessage(await loadContent(spec.seed));
        if (flags.dryRun) {
          created(`${spec.name}: ${chunks.length} message(s) from ${spec.seed}.md`);
          continue;
        }
        const history = await api('GET', `/channels/${channelId}/messages?limit=100`);
        const mine = history.filter((message) => message.author?.id === botId);
        if (mine.length > 0 && !flags.reseed) {
          const notices = mine.filter((message) => message.type === 6).length;
          await removePinNotices(channelId, botId);
          kept(`${spec.name} (already seeded)${notices ? `, cleared ${notices} pin notice(s)` : ''}`);
          continue;
        }
        for (const message of mine) {
          await api('DELETE', `/channels/${channelId}/messages/${message.id}`, undefined, {
            reason: 'Backenly content reseed',
          });
        }
        let first = null;
        for (const chunk of chunks) {
          const posted = await api('POST', `/channels/${channelId}/messages`, { content: chunk });
          first ??= posted;
        }
        // Pinning is only useful where members also talk; in a read-only
        // channel the seeded post is the entire channel, and the pin just
        // leaves a "pinned a message" system notice behind.
        if (first && !spec.readonly) await api('PUT', `/channels/${channelId}/pins/${first.id}`).catch(() => {});
        await removePinNotices(channelId, botId);
        created(`${spec.name}: ${chunks.length} message(s)`);
      }

      if (spec.seedThread) {
        const [opening, ...rest] = chunkMessage(await loadContent(spec.seedThread.file));
        if (flags.dryRun) {
          created(`${spec.name}: forum post "${spec.seedThread.name}" (${rest.length + 1} message(s))`);
          continue;
        }
        const active = await api('GET', `/guilds/${flags.guild}/threads/active`);
        const already = active.threads?.find(
          (thread) => thread.parent_id === channelId && thread.name === spec.seedThread.name,
        );
        if (already && !flags.reseed) {
          kept(`${spec.name} (guidelines post exists)`);
          continue;
        }
        const thread = await api('POST', `/channels/${channelId}/threads`, {
          name: spec.seedThread.name,
          auto_archive_duration: 10080,
          message: { content: opening },
        });
        // The starter message carries only the first chunk; the rest follow as
        // replies in the same thread so nothing is dropped.
        for (const chunk of rest) {
          await api('POST', `/channels/${thread.id}/messages`, { content: chunk });
        }
        // flags = 1 << 1 pins a forum post to the top of the channel.
        await api('PATCH', `/channels/${thread.id}`, { flags: 2 }).catch(() => {});
        created(`${spec.name}: forum post "${spec.seedThread.name}" (${rest.length + 1} message(s))`);
      }
    }
  }
}

// ---------------------------------------------------------------- onboarding

async function applyOnboarding(guildId, channelIds, roleIds, flags) {
  phase('Onboarding');

  const prompts = ONBOARDING.prompts.filter((prompt) => include(prompt, flags.minimal));
  const payloadPrompts = prompts.map((prompt, promptIndex) => ({
    id: String(promptIndex),
    type: 0, // MULTIPLE_CHOICE
    title: prompt.title,
    single_select: prompt.singleSelect,
    required: prompt.required,
    in_onboarding: true,
    options: prompt.options.map((option, optionIndex) => ({
      id: String(promptIndex * 100 + optionIndex),
      title: option.title,
      description: option.description,
      emoji: { name: option.emoji, id: null, animated: false },
      channel_ids: option.channels.map((key) => channelIds.get(key)).filter(Boolean),
      role_ids: option.roles.map((key) => roleIds.get(key)).filter(Boolean),
    })),
  }));

  const defaultChannelIds = ONBOARDING.defaultChannels.map((key) => channelIds.get(key)).filter(Boolean);

  if (flags.dryRun) {
    for (const prompt of prompts) {
      created(`prompt "${prompt.title}" (${prompt.options.map((o) => o.title).join(', ')})`);
    }
    created(`${defaultChannelIds.length} default channels`);
    return;
  }

  try {
    await api(
      'PUT',
      `/guilds/${guildId}/onboarding`,
      { prompts: payloadPrompts, default_channel_ids: defaultChannelIds, enabled: true, mode: ONBOARDING.mode },
      { reason: 'Backenly onboarding' },
    );
    updated(`onboarding enabled with ${payloadPrompts.length} prompt(s)`);
  } catch (error) {
    warn(`could not write onboarding: ${error.message}`);
    warn('Discord needs at least 7 default channels, 5 of them writable by @everyone. Re-run without --minimal.');
  }

  const welcomeChannels = WELCOME_SCREEN.channels
    .map((entry) => {
      const id = channelIds.get(entry.key);
      return id ? { channel_id: id, description: entry.description, emoji_name: entry.emoji, emoji_id: null } : null;
    })
    .filter(Boolean)
    .slice(0, 5);

  try {
    const screen = await api(
      'PATCH',
      `/guilds/${guildId}/welcome-screen`,
      { enabled: true, description: WELCOME_SCREEN.description, welcome_channels: welcomeChannels },
      { reason: 'Backenly welcome screen' },
    );
    // Discord keeps the legacy welcome screen switched off while onboarding is
    // enabled, so report what came back rather than what we asked for.
    if (screen?.enabled) updated(`welcome screen with ${welcomeChannels.length} entries`);
    else kept(`welcome screen saved (${welcomeChannels.length} entries) but stays off while onboarding is enabled`);
  } catch (error) {
    warn(`could not write welcome screen: ${error.message}`);
  }
}

// ------------------------------------------------------------------ identity

/** Reads an image file and returns it as a data URI Discord will accept. */
async function imageDataUri(relativePath) {
  const file = path.isAbsolute(relativePath) ? relativePath : path.resolve(process.cwd(), relativePath);
  if (!existsSync(file)) throw new Error(`Image not found: ${file}`);
  const ext = path.extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.gif'].includes(ext)) {
    throw new Error('Discord accepts PNG, JPG, or GIF. SVG will not work.');
  }
  const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  return `data:${mime};base64,${(await readFile(file)).toString('base64')}`;
}

/**
 * The bot's own display name and avatar, which is what every seeded message is
 * attributed to. Discord rate-limits username changes hard, so only write on
 * an actual difference.
 */
async function applyBotIdentity(me, flags) {
  phase('Bot identity');
  const patch = {};

  if (BOT_IDENTITY.username && me.username !== BOT_IDENTITY.username) patch.username = BOT_IDENTITY.username;
  if (BOT_IDENTITY.avatar && !me.avatar) patch.avatar = await imageDataUri(BOT_IDENTITY.avatar);

  if (Object.keys(patch).length === 0) {
    kept(`posting as "${me.username}"`);
    return;
  }
  if (flags.dryRun) {
    updated(`bot profile: ${Object.keys(patch).join(', ')} -> "${BOT_IDENTITY.username}"`);
    return;
  }
  try {
    const updatedUser = await api('PATCH', '/users/@me', patch);
    updated(`bot now posts as "${updatedUser.username}"${patch.avatar ? ' with the Backenly avatar' : ''}`);
    kept('every message it already posted re-attributes automatically');
  } catch (error) {
    warn(`could not update the bot profile: ${error.message}`);
    if (error.code === 50035) warn('Discord rate-limits username changes to 2 per hour. Wait and re-run.');
  }
}

async function applyIdentity(guildId, guild, channelIds, flags) {
  phase('Server identity');
  const patch = {};

  if (flags.rename && guild.name !== GUILD.name) patch.name = GUILD.name;

  if (flags.icon) {
    const file = path.resolve(flags.icon);
    if (!existsSync(file)) throw new Error(`Icon not found: ${file}`);
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    if (!['.png', '.jpg', '.jpeg', '.gif'].includes(ext)) {
      throw new Error('Discord accepts PNG, JPG, or GIF for the server icon. SVG will not work.');
    }
    patch.icon = `data:${mime};base64,${(await readFile(file)).toString('base64')}`;
  }

  const systemChannelId = channelIds.get(GUILD.systemChannel);
  if (systemChannelId && guild.system_channel_id !== systemChannelId) patch.system_channel_id = systemChannelId;

  if (Object.keys(patch).length === 0) {
    kept('nothing to change');
    return;
  }
  if (flags.dryRun) {
    updated(Object.keys(patch).join(', '));
    return;
  }
  await api('PATCH', `/guilds/${guildId}`, patch, { reason: 'Backenly community server setup' });
  updated(Object.keys(patch).join(', '));
}

// ----------------------------------------------------------------- validate

/**
 * Everything that can be checked without Discord: blueprint consistency,
 * content files, and the platform limits that would fail the run halfway
 * through. Runs on every invocation, including --dry-run.
 */
async function validate(flags) {
  const problems = [];
  const notes = [];
  const categories = activeCategories(flags.minimal);

  const roleKeys = new Set(ROLES.map((role) => role.key));
  const roleNames = new Set(ROLES.map((role) => role.name));
  const knownRoleRef = (ref) => ref === '@everyone' || roleKeys.has(ref) || roleNames.has(ref);

  const channelKeys = new Set();
  const writableByEveryone = new Set();

  for (const category of categories) {
    for (const spec of category.overwrites) {
      if (!knownRoleRef(spec.role)) problems.push(`${category.name}: overwrite references unknown role "${spec.role}"`);
      try {
        bits(spec.allow);
        bits(spec.deny);
      } catch (error) {
        problems.push(`${category.name}: ${error.message}`);
      }
    }
    if (category.channels.length > 50) problems.push(`${category.name}: ${category.channels.length} channels, Discord allows 50`);

    const everyoneCanSend = category.overwrites.some(
      (spec) => spec.role === '@everyone' && spec.allow?.includes('SEND_MESSAGES'),
    );

    for (const spec of category.channels) {
      if (channelKeys.has(spec.key)) problems.push(`duplicate channel key: ${spec.key}`);
      channelKeys.add(spec.key);

      if (!spec.key.startsWith(`${category.key}/`)) {
        problems.push(`${spec.key}: key should start with "${category.key}/"`);
      }
      if (CHANNEL_TYPES[spec.type] === undefined) problems.push(`${spec.key}: unknown channel type "${spec.type}"`);

      const topicLimit = spec.type === 'FORUM' ? 4096 : 1024;
      if (spec.topic && spec.topic.length > topicLimit) {
        problems.push(`${spec.key}: topic is ${spec.topic.length} chars, limit is ${topicLimit}`);
      }
      if (spec.topic && spec.type === 'VOICE') {
        problems.push(`${spec.key}: voice channels have no topic field; Discord rejects it with 400`);
      }
      if (spec.name.length > 100) problems.push(`${spec.key}: channel name is longer than 100 chars`);
      if (spec.tags && spec.tags.length > 20) problems.push(`${spec.key}: ${spec.tags.length} forum tags, limit is 20`);

      if (everyoneCanSend && !spec.readonly && spec.type === 'TEXT') writableByEveryone.add(spec.key);

      for (const file of [spec.seed, spec.seedThread?.file].filter(Boolean)) {
        const full = path.join(CONTENT_DIR, `${file}.md`);
        if (!existsSync(full)) {
          problems.push(`${spec.key}: missing content file content/${file}.md`);
          continue;
        }
        try {
          const chunks = chunkMessage(await readFile(full, 'utf8'));
          const longest = Math.max(...chunks.map((chunk) => chunk.length));
          notes.push(`content/${file}.md: ${chunks.length} message(s), longest ${longest}/${MESSAGE_LIMIT}`);
        } catch (error) {
          problems.push(`content/${file}.md: ${error.message}`);
        }
      }
    }
  }

  const totalChannels = categories.reduce((sum, category) => sum + category.channels.length + 1, 0);
  if (totalChannels > 500) problems.push(`${totalChannels} channels, Discord allows 500`);

  for (const prompt of ONBOARDING.prompts.filter((p) => include(p, flags.minimal))) {
    for (const option of prompt.options) {
      for (const key of option.channels) {
        if (!channelKeys.has(key)) problems.push(`onboarding "${option.title}": unknown channel ${key}`);
      }
      for (const key of option.roles) {
        if (!roleKeys.has(key)) problems.push(`onboarding "${option.title}": unknown role ${key}`);
        const role = ROLES.find((r) => r.key === key);
        if (role && !include(role, flags.minimal)) {
          problems.push(`onboarding "${option.title}": role ${key} is skipped by --minimal but the prompt is not`);
        }
      }
    }
  }

  const defaults = ONBOARDING.defaultChannels.filter((key) => channelKeys.has(key));
  const defaultWritable = defaults.filter((key) => writableByEveryone.has(key));
  if (defaults.length < 7 || defaultWritable.length < 5) {
    problems.push(
      `onboarding needs 7 default channels with 5 writable by @everyone; this blueprint gives ${defaults.length} and ${defaultWritable.length}`,
    );
  }

  // Every welcome-screen channel must be visible to @everyone or Discord
  // rejects the whole payload with a bare "Invalid Form Body".
  const gatedKeys = new Set(
    categories
      .filter((category) =>
        category.overwrites.some((spec) => spec.role === '@everyone' && spec.deny?.includes('VIEW_CHANNEL')),
      )
      .flatMap((category) => category.channels.map((spec) => spec.key)),
  );
  for (const entry of WELCOME_SCREEN.channels) {
    if (!channelKeys.has(entry.key)) notes.push(`welcome screen skips ${entry.key} (not in this run)`);
    else if (gatedKeys.has(entry.key)) {
      problems.push(`welcome screen entry ${entry.key} is in a category hidden from @everyone; Discord will reject it`);
    }
  }
  if (WELCOME_SCREEN.channels.length > 5) problems.push('welcome screen allows at most 5 channels');
  if (!channelKeys.has(GUILD.systemChannel)) notes.push(`system channel ${GUILD.systemChannel} is not in this run`);

  const rulesChannel = categories.flatMap((c) => c.channels).find((spec) => spec.role === 'rules');
  const updatesChannel = categories.flatMap((c) => c.channels).find((spec) => spec.role === 'public-updates');
  if (!rulesChannel) problems.push('no channel is marked role: "rules"; Community cannot be enabled');
  if (!updatesChannel) problems.push('no channel is marked role: "public-updates"; Community cannot be enabled');

  return { problems, notes, totalChannels, roleCount: ROLES.filter((r) => include(r, flags.minimal)).length };
}

// ---------------------------------------------------------------------- main

export async function main() {
  const flags = parseArgs(process.argv.slice(2));
  currentPhase = 0;
  communityEnabled = false;

  if (flags.help) {
    console.log(await readFile(path.join(HERE, 'README.md'), 'utf8'));
    return;
  }

  console.log(`\n${paint('bold', 'Backenly community server')}`);
  console.log(
    paint('dim', `   mode   ${flags.validate ? 'validate only' : flags.dryRun ? 'dry run, nothing will be written' : 'apply'}${flags.minimal ? ', minimal' : ''}`),
  );

  phase('Blueprint');
  const report = await validate(flags);
  for (const note of report.notes) kept(note);
  for (const problem of report.problems) warn(problem);
  if (report.problems.length > 0) {
    throw new Error(`${report.problems.length} blueprint problem(s). Fix scripts/discord/blueprint.mjs before running against a guild.`);
  }
  kept(`${report.roleCount} roles, ${report.totalChannels} channels and categories`);

  if (flags.validate) {
    console.log(`\n${paint('bold', 'Blueprint is valid.')} Nothing was contacted.\n`);
    return;
  }

  token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error(
      'DISCORD_BOT_TOKEN is not set. Export it for this shell only:\n' +
        '  PowerShell:  $env:DISCORD_BOT_TOKEN = "..."\n' +
        '  bash:        export DISCORD_BOT_TOKEN=...\n' +
        'Do not put it in a file that git can see.',
    );
  }
  if (!flags.guild) {
    throw new Error('No guild. Pass --guild <id> or set DISCORD_GUILD_ID. Right-click the server in Discord with Developer Mode on to copy the id.');
  }

  const me = await api('GET', '/users/@me');
  const guild = await api('GET', `/guilds/${flags.guild}`).catch((error) => {
    if (error.status === 403 || error.status === 404) {
      throw new Error(`The bot cannot see guild ${flags.guild}. Invite it to the server first (see scripts/discord/README.md).`);
    }
    throw error;
  });

  console.log(paint('dim', `\n   bot    ${me.username} (${me.id})`));
  console.log(paint('dim', `   guild  ${guild.name} (${guild.id})`));

  flags.roleIds = await reconcileRoles(flags.guild, flags, me.id);
  await orderRoles(flags.guild, flags.roleIds, flags);

  const { channelIds, communityOk } = await reconcileChannels(flags.guild, guild, flags);

  await applyIdentity(flags.guild, guild, channelIds, flags);
  await applyBotIdentity(me, flags);

  if (flags.content) await seedChannels(channelIds, me.id, flags);
  else skipped('channel content (--no-content)');

  if (flags.onboarding && communityOk) await applyOnboarding(flags.guild, channelIds, flags.roleIds, flags);
  else if (flags.onboarding) {
    phase('Onboarding');
    warn('skipped: onboarding needs Community enabled');
  }

  // ---- invite
  phase('Invite');
  const welcomeId = channelIds.get('start/welcome');
  if (flags.dryRun || !welcomeId) {
    kept('an invite is created on a real run');
  } else {
    try {
      // Reuse the permanent invite from a previous run rather than minting a
      // new code on every reconcile.
      const existing = await api('GET', `/channels/${welcomeId}/invites`).catch(() => []);
      const mine = existing.find(
        (invite) => invite.max_age === 0 && invite.max_uses === 0 && invite.inviter?.id === me.id,
      );
      if (mine) {
        kept(`https://discord.gg/${mine.code}`);
      } else {
        const invite = await api('POST', `/channels/${welcomeId}/invites`, { max_age: 0, max_uses: 0, unique: false });
        created(`https://discord.gg/${invite.code}`);
      }
    } catch (error) {
      warn(`could not create an invite: ${error.message}`);
    }
  }

  console.log(`\n${paint('bold', 'Done.')} ${flags.dryRun ? 'Nothing was written. Re-run without --dry-run to apply.' : 'Re-run any time; it reconciles.'}\n`);

  if (!flags.dryRun) {
    console.log('Left for a human:');
    console.log('  - Give the founders the Core Team role, and drag it above the bot role.');
    console.log('  - Turn on AutoMod (Server Settings -> AutoMod): spam, mention spam, and invite links.');
    console.log('  - Set the server banner and invite splash if you have the boosts for it.');
    console.log('  - Post the first message in announcements yourselves. It reads better than a seeded one.\n');
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`\n${paint('bold', 'Failed:')} ${error.message}`);
    if (error.code === 50013) {
      const onChannel = /\/channels\//.test(error.message);
      console.error(
        onChannel
          ? 'Missing Permissions on a channel or category.\n' +
            'Discord evaluates the bot inside the target category, and a read-only category denies\n' +
            'SEND_MESSAGES to @everyone. With no overwrite of its own the bot inherits that deny and\n' +
            'can no longer edit what it built. Categories this script creates carry a self-overwrite\n' +
            'for exactly this reason, but one created before that fix, or edited by hand, will not.\n' +
            'Delete the affected category and re-run so it is recreated correctly, or grant the bot\n' +
            'Administrator for one run (Administrator bypasses channel overwrites entirely).'
          : 'Missing Permissions. Discord will not let a bot create a role carrying a permission the bot\n' +
            'does not itself hold, so the invite must grant everything the blueprint hands out.\n' +
            `Re-authorize the bot with:\n  ${inviteUrl(process.env.DISCORD_APP_ID)}\n` +
            'then drag its role to the top of Server Settings -> Roles and run again.',
      );
    }
    if (error.code === 50001) console.error('Missing Access: the bot is not in this guild, or cannot see the channel.');
    process.exitCode = 1;
  });
}
