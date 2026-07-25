import type { ArticleData } from './types'

export const article: ArticleData = {
  slug: 'full-stack-development-with-ai-coding-agents',
  title: 'Full-Stack Development with AI Coding Agents: Give Your Agent a Real Backend Contract',
  metaDescription:
    'Cursor and Claude Code make frontends fast, but agents hallucinate the backend. How to give your coding agent a real API contract instead of mocks — over MCP — and ship full-stack apps dramatically faster.',
  category: 'Guide',
  readTime: '10 min read',
  datePublished: '2026-05-11',
  dateModified: '2026-07-18',
  dateDisplay: 'Updated July 18, 2026',
  intro:
    'If you build with Cursor or Claude Code, you know the asymmetry: your agent produces a working frontend in minutes, then everything slows down at the backend. Not because agents can\'t write backend code — they can — but because backend code isn\'t the deliverable. A backend is a running system: a live database, deployed endpoints, auth issuing real sessions, and someone responsible when it degrades. Your agent can\'t deploy, operate, or take responsibility for any of that. This guide covers the workflow that fixes the asymmetry: the agent owns the frontend, a platform owns the backend runtime, and the two meet at a real, inspectable contract.',
  sections: [
    {
      heading: 'The real bottleneck: agents invent APIs that don\'t exist',
      blocks: [
        {
          kind: 'p',
          text: 'Watch what your agent does when you ask for a full-stack feature without giving it a backend: it invents one. It writes fetch calls to endpoints that don\'t exist, defines TypeScript interfaces for responses nothing returns, and mocks the data so the UI renders. The frontend "works" in the way a film set works. Then you spend your session getting the agent to build the real thing behind the facade — schema, routes, auth middleware, migrations — and this is where agent quality collapses, because backend correctness is invisible in a browser. An agent can see that a button is misaligned; it cannot see that its RLS policy leaks rows across users.',
        },
        {
          kind: 'p',
          text: 'The fix is not a better prompt. It is giving the agent what it actually lacks: a live, inspectable backend contract — real tables, real endpoints, real auth — so it writes integration code against ground truth instead of hallucinating structure.',
        },
      ],
    },
    {
      heading: 'The workflow: describe the backend once, then let the agent read it',
      blocks: [
        {
          kind: 'p',
          text: 'Step one happens on Backenly, not in your editor: describe the product\'s backend in plain English ("users post recipes with photos, follow each other, save favorites — users only edit their own recipes"). The platform plans it, builds it as governed changes, and verifies it against the live runtime with real HTTP checks — including signing in as a second test user to prove cross-user isolation actually blocks. What you now have is not scaffolding; it is a deployed API with behavioral evidence.',
        },
        {
          kind: 'p',
          text: 'Step two connects your editor. Backenly ships an MCP server, so agents that speak the Model Context Protocol — Claude Code, Cursor, Codex — get direct, scope-gated access to the backend:',
        },
        {
          kind: 'code',
          language: 'bash',
          label: 'One-time setup in your terminal',
          code: `npx @backenly/mcp-server init
# paste the mcp_live_… key from your project's MCP tab
# ✓ Verified. Setup complete — restart your MCP host.`,
        },
        {
          kind: 'p',
          text: 'From then on, your agent can ask the backend real questions and make governed changes without leaving the editor. A representative exchange:',
        },
        {
          kind: 'code',
          language: 'text',
          label: 'What agent-to-backend actually looks like',
          code: `You: What tables does my Backenly project have?
Agent: (via MCP) users, recipes, follows, favorites — with columns,
       types, and relations listed from the live schema.

You: Add a saved_searches table with user_id and query columns.
Agent: (via MCP) Created — table, API endpoints, and policies applied
       through the platform's governed change path.

You: Drop the users table.
Agent: Refused — destructive operations are blocked at the MCP key
       scope and redirect to dashboard approval.`,
        },
        {
          kind: 'note',
          text: 'That last exchange is the point. MCP keys are scope-gated: reading state and building resources is allowed; destructive operations are structurally blocked and route to the dashboard\'s approval flow, which shows live row counts before anything runs. Your agent gets real power without the ability to destroy production data on a bad turn.',
        },
      ],
    },
    {
      heading: 'Frontend code your agent can\'t get wrong',
      blocks: [
        {
          kind: 'p',
          text: 'With the MCP server connected, your agent knows the actual schema — so the frontend code it writes calls real endpoints with real field names. The SDK surface is uniform enough that agents generate it correctly on the first pass:',
        },
        {
          kind: 'code',
          language: 'js',
          label: 'The integration layer your agent writes against',
          code: `import { createClient } from '@backenly/sdk'
const backend = createClient({ projectId, apiKey })

// Auth — real sessions, project-scoped JWTs
await backend.auth.signUp({ email, password })
await backend.auth.signIn({ email, password })

// CRUD with filtering, ordering, pagination — per table
const feed = await backend.recipes.list({
  where: { published: true },
  orderBy: 'created_at',
  order: 'desc',
  limit: 20,
  include: ['users'],          // relations resolved server-side
})

// Live updates over SSE — no socket server to run
const unsub = backend.realtime.subscribe('recipes', (event) => {
  applyChange(event)           // 'insert' | 'update' | 'delete'
})`,
        },
        {
          kind: 'p',
          text: 'Two properties carry most of the weight here. Row-level security is enforced in PostgreSQL, so the feed above is already scoped to what the signed-in user may see — the agent cannot forget an authorization check it never had to write. And realtime is server-sent events off the database\'s own change stream, so "make the feed live" is a subscription, not an infrastructure project.',
        },
      ],
    },
    {
      heading: 'Who fixes it at 3 a.m.? Not your agent',
      blocks: [
        {
          kind: 'p',
          text: 'Here is the part of agent-driven full-stack development nobody puts in the demo video: your Cursor session ends. The backend keeps running. When error rates spike on Tuesday night, your agent is not watching — it has no memory of the project until you open the editor and re-explain. This is the structural reason "my agent writes the whole stack" breaks down as a production strategy, however good the agent gets.',
        },
        {
          kind: 'p',
          text: 'On the platform side of this workflow, the backend is watched continuously: real request metrics feed an autonomy loop that detects anomalies, applies the fixes that are safe to apply (at the autonomy level you choose — from review-everything upward), queues anything risky for approval, and writes up every action with what was detected and how the fix was verified. Every change — yours, your agent\'s, or the platform\'s — lands in one journal, and schema changes get restore points. The division of labor is clean: the agent owns code, the platform owns the runtime, you own decisions.',
        },
      ],
    },
    {
      heading: 'No MCP in your tool? The hosted SDK is the same contract',
      blocks: [
        {
          kind: 'p',
          text: 'If a frontend isn\'t being written by an MCP-connected agent — it\'s hand-written, or generated by a tool that can\'t speak MCP — the contract is still right there: a hosted, typed SDK plus documented REST endpoints. The Connect page gives you a copy-paste SDK snippet with your project ID and public key already inlined; drop it into the codebase and the app is talking to your live tables, auth, and storage. Same backend, same contract — consumed as plain code instead of over MCP. The dashboard\'s connection health panel shows the moment real requests start landing, and diagnoses the exact misconfiguration when they fail.',
        },
        {
          kind: 'p',
          text: 'This is also the answer to a hard question in the AI-tooling ecosystem: what happens when your app outgrows the backend a frontend tool provisioned for it? Rebuilding a frontend is cheap — regenerating it is the tool\'s whole job. The backend, with its live data and accumulated schema decisions, is the part that has to survive. Putting it on a platform built to operate backends, while your tools keep doing what they are good at, is the separation that survives growth.',
        },
      ],
    },
  ],
  conclusion:
    'The fastest full-stack workflow in 2026 is not one agent doing everything — it is a clean contract between two systems that are each good at their job. Your coding agent owns the frontend and integration code, reading the backend\'s live schema through MCP so it never hallucinates structure. The backend platform owns the runtime: generation with behavioral verification, guardrails that block destructive changes at the key scope, and a monitoring loop that stays awake after your editor closes. Describe the backend once, connect your agent, and spend your sessions on the product instead of the plumbing.',
  relatedSlugs: ['how-to-build-a-backend-without-coding', 'backend-development-for-ai-app-builders'],
}
