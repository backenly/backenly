# Backenly community Discord

Provisions the Backenly community server: roles, categories, channels, permissions, forum tags, seeded content, onboarding, and the welcome screen.

It is a **reconciler, not an installer**. It creates what is missing, updates what has drifted, and leaves everything else alone. Running it twice is the expected path. **It never deletes a channel or a role.**

The structure lives in [`blueprint.mjs`](blueprint.mjs) and the seeded posts in [`content/`](content/). Edit those and re-run; do not edit the server by hand and expect it to stick.

## The shape of the server

Two doors, one community. Onboarding asks how you run Backenly and unlocks the matching category — pick both if you use both.

```
📍 Start Here          rules · welcome · how-backenly-works
📣 Announcements       announcements · status · blog
💬 Community           general · introductions · showcase · agent-workflows · off-topic · office-hours

☁️ Backenly Cloud      — unlocked by the @Cloud role
   cloud-start-here · cloud-changelog · cloud-help-agent (forum) ·
   cloud-help-human (forum) · cloud-chat · billing-and-plans · cloud-feature-requests

🧱 Self-Hosted         — unlocked by the @Self-Hosted role
   selfhost-start-here · releases · selfhost-help-agent (forum) ·
   selfhost-help-human (forum) · selfhost-chat · file-a-bug (forum) ·
   selfhost-feature-requests · contributing

🔒 Core Team           team · mod-log · discord-updates · team-voice
```

Roles: `Core Team`, `Moderator`, `Contributor`, `Cloud`, `Self-Hosted`, plus four agent tags (`Claude Code`, `Cursor`, `Codex`, `Other Agent`).

## Before you run it

**1. Create the server in Discord.** Bots cannot create servers. Make it yourself, with any name. The owner account needs a **verified email**, or Discord will refuse to enable Community.

**2. Create the bot.** [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application** → **Bot** → **Reset Token**, and copy it. You do not need any privileged gateway intents; this script only uses the REST API.

**3. Invite it**, replacing `YOUR_APP_ID` with the Application ID from the General Information page:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot&permissions=1426197834999
```

That integer is what the script needs to operate **plus every permission the blueprint hands to `Core Team` and `Moderator`** — Kick, Ban, View Audit Log, and Moderate Members among them. Both halves are required: Discord refuses to let a bot create a role carrying a permission the bot does not itself hold, so an invite scoped to only what the script does fails at the first role with `403 Missing Permissions`.

`requiredInvitePermissions()` in `setup-discord.mjs` derives the number from the blueprint. If you add a permission to a role, re-derive it and re-authorize the bot — do not hand-edit the integer. Administrator also works and is easier to revoke afterwards.

**4. Drag the bot's role to the top** of Server Settings → Roles. It can only create and order roles below its own.

**5. Copy the server id.** Discord Settings → Advanced → Developer Mode, then right-click the server → Copy Server ID.

## Running it

```bash
# 1. Check the blueprint and content. No token, no network.
node scripts/discord/setup-discord.mjs --validate

# 2. See exactly what would change.
export DISCORD_BOT_TOKEN=...          # PowerShell: $env:DISCORD_BOT_TOKEN = "..."
node scripts/discord/setup-discord.mjs --guild 123456789012345678 --dry-run

# 3. Apply.
node scripts/discord/setup-discord.mjs --guild 123456789012345678
```

**The token goes in the environment and nowhere else.** This repository is public. Never put it in `.env`, a config file, or a commit — if one leaks, reset it in the developer portal immediately.

### Flags

| Flag | Effect |
|---|---|
| `--guild <id>` | Target server. Defaults to `DISCORD_GUILD_ID`. |
| `--validate` | Blueprint and content checks only. No token required. |
| `--dry-run` | Print the plan. Writes nothing. |
| `--minimal` | Skip everything marked `optional` — a leaner server for a small community. |
| `--reseed` | Delete the bot's own seeded messages and post them again. |
| `--rename` | Also set the server name from the blueprint. Off by default. |
| `--icon <path>` | Upload a server icon. PNG, JPG, or GIF — `public/apple-touch-icon.png` works. SVG does not. |
| `--no-content` | Skip seeding channel posts. |
| `--no-onboarding` | Skip onboarding and the welcome screen. |

A first run on a fresh server takes two to three minutes; the script paces itself against Discord's rate limits deliberately.

## Order of operations

Discord will not let a bot create announcement or forum channels until the guild is a Community, and it will not become a Community without a rules channel and a public-updates channel. So the run goes:

1. Roles, then role order.
2. Categories and plain text/voice channels — including `📜｜rules` and `📡｜discord-updates`.
3. **Enable Community** using those two channels.
4. Announcement and forum channels.
5. Channel ordering, server identity, seeded content.
6. Onboarding prompts and the welcome screen.
7. A permanent invite, printed at the end.

If step 3 fails — usually an unverified owner email — the script says so, skips steps 4 and 6, and completes everything else. Enable Community by hand in Server Settings and run it again.

## Changing the server

Edit [`blueprint.mjs`](blueprint.mjs), run `--validate`, then `--dry-run`, then apply. The validator catches the things that would otherwise fail halfway through a real run: unknown permission names, channel keys referenced by onboarding that do not exist, topics over Discord's limit, content that does not fit in a message, and the "7 default channels, 5 of them writable" rule Discord enforces on onboarding.

Adding a channel is a blueprint entry plus, if it should have a seeded post, a file in `content/`. Content files are Markdown as Discord renders it for bots — masked links work, and `<!-- split -->` starts a new message.

## What it deliberately leaves to a human

- Assigning `Core Team` to the founders, and dragging that role above the bot's.
- AutoMod rules (Server Settings → AutoMod): spam, mention spam, invite links.
- The banner and invite splash, which need boosts.
- The first post in `📣 announcements`. Write it yourselves — it reads better than a seeded one.

## Security

- The bot token is read from `DISCORD_BOT_TOKEN` and is never logged or written to disk.
- The script never deletes channels or roles. `--reseed` deletes only messages the bot itself posted.
- Every write carries an audit-log reason, so Server Settings → Audit Log shows what this script did and when.
