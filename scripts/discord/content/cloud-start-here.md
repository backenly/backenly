# ☁️ Backenly Cloud — start here

The managed platform at [backenly.com](https://backenly.com). Nothing to install, nothing to operate.

## Two minutes to a working backend

**1. Create a project** at [backenly.com](https://backenly.com).

**2. Point your coding agent at it** over MCP. The endpoint is `https://backenly.com/api/mcp`. The dashboard gives you the exact config block for Claude Code, Cursor, or Codex — copy it into your MCP settings and restart the client.

**3. Describe what you're building.** Not the tables — the product. "Users can save recipes and share collections with friends" is the right altitude. The Brain derives the entities, writes the policies, applies the change, and verifies it against the live runtime before telling you it's done.

**4. Check the dashboard.** Every change is there with its plan, its audit entry, and a restore point. Nothing happened that you can't see or undo.

<!-- split -->

## Things people trip over

**Restart your MCP client after changing config.** A running client will not pick up a new server mid-session, and the failure looks like the tools simply don't exist.

**Your agent should read before it writes.** `read_backend_state` and the `backenly://state` resource exist so it doesn't guess. An agent that plans from a stale model of your schema produces confident nonsense.

**Destructive changes wait for you.** Dropping a column, changing auth, touching external credentials — these stop and ask. That is deliberate, not a bug. Check the dashboard for the pending approval.

**There is no raw-SQL path for structure.** `run_query` reads. Structural change goes through typed actions so it can be planned, audited, and reversed.

## Plans

Free ($0), Pro ($25/mo), and Enterprise. AI credits meter the planning and autonomy work. Details at [backenly.com/pricing](https://backenly.com/pricing); questions in 💳 billing-and-plans, but never post an invoice, key, or account email in a public channel — mail **support@backenly.com**.

<!-- split -->

## Where to ask

🤖 **cloud-help-agent** — your agent did something and you want a second pair of eyes. Paste the tool call and what came back.
🙋 **cloud-help-human** — projects, dashboard, keys, limits, anything that isn't a specific agent run.
💡 **cloud-feature-requests** — one idea per message so reactions mean something.
🚦 **status** — incidents and maintenance.

Both forums: **one post per problem**, and tag it `Answered` when it's resolved. That's what makes them worth searching.

## Also useful

- [Connect your coding agent](https://backenly.com/resources/connect-your-coding-agent)
- [The data API](https://backenly.com/resources/the-data-api)
- Client libraries: [backenly-js](https://github.com/backenly/backenly-js) (SDK, CLI, MCP server — all MIT)

-# Thinking about running it yourself instead? Pick 🧱 Self-Hosted under Channels & Roles. Plenty of people use both.
