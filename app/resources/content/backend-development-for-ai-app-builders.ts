import type { ArticleData } from './types'

export const article: ArticleData = {
  slug: 'backend-development-for-ai-app-builders',
  title: 'The Backend Your AI Product Actually Needs (Before You Write a Prompt)',
  metaDescription:
    'Shipping an AI product means running a backend with unusual demands: conversation storage, vector search, event-driven pipelines, streaming status, and per-user cost control. What that backend needs and how to get it without building it.',
  category: 'Guide',
  readTime: '10 min read',
  datePublished: '2026-05-11',
  dateModified: '2026-07-18',
  dateDisplay: 'Updated July 18, 2026',
  intro:
    'An AI product is two systems. The AI layer — models, prompts, inference — is the part you demo. The backend layer — users, data, files, permissions, billing state, job status — is the part that decides whether the demo becomes a product. Builders consistently under-invest in the second, partly because it is unglamorous and partly because AI apps have backend requirements that standard CRUD tutorials never cover. This guide goes through those requirements — conversation persistence, vector search, event-driven pipelines, streaming status, and cost control — and how to get them without spending your runway assembling infrastructure.',
  sections: [
    {
      heading: 'AI apps have five backend requirements CRUD apps don\'t',
      blocks: [
        {
          kind: 'list',
          items: [
            'Conversation and session persistence: chat history, model outputs, and context that must survive refreshes and be queryable later — with hard per-user isolation, because conversations are among the most private data a product can hold.',
            'Semantic retrieval: RAG products need embeddings stored next to the data they describe, and a way to query by similarity — which in a PostgreSQL world means pgvector, not a second database to operate.',
            'Event-driven processing: inference is slow and asynchronous. "User uploads a document → extract → embed → summarize → notify" is a pipeline, and pipelines need triggers and background execution, not fetch handlers that time out.',
            'Live status: users will not stare at a frozen spinner for a 40-second generation job. The frontend needs to observe job state changing in real time.',
            'Per-user cost control: every request costs you inference money. Without rate limits and usage tracking wired into the backend, one enthusiastic user — or one abusive script — is a four-figure surprise.',
          ],
        },
        {
          kind: 'p',
          text: 'None of these are exotic individually. The trap is that each one is a separate infrastructure project — a queue here, a vector store there, a websocket server, a rate limiter — and suddenly the "backend layer" is five systems you operate while also trying to ship an AI product.',
        },
      ],
    },
    {
      heading: 'Structure first: conversations, users, and isolation',
      blocks: [
        {
          kind: 'p',
          text: 'Start with the boring core, because everything else hangs off it. An AI writing assistant\'s data model, described to Backenly in one message:',
        },
        {
          kind: 'code',
          language: 'text',
          label: 'The description that becomes the backend',
          code: `An AI writing assistant. Users sign up with email.
Users create documents with a title and content.
Each document has many ai_runs: each run stores the prompt,
the model output, a status (queued / running / done / failed),
and a created_at. Users can only access their own documents
and runs.`,
        },
        {
          kind: 'p',
          text: 'That produces the PostgreSQL schema with the foreign keys, the REST APIs, auth with project-scoped JWT sessions, and — from the last sentence — row-level security enforced in the database. For an AI product the isolation line is not a nice-to-have: your ai_runs table contains every prompt your users ever wrote. Backenly\'s post-build verification includes signing in as a second test user and confirming they get zero of the first user\'s rows, with the evidence shown — the check you most want to exist and least want to write yourself.',
        },
        {
          kind: 'p',
          text: 'Your AI layer then reads and writes through the same API your frontend uses:',
        },
        {
          kind: 'code',
          language: 'js',
          label: 'The AI layer persisting its work',
          code: `// Record the run before calling the model
const run = await backend.ai_runs.create({
  document_id: doc.id,
  prompt,
  status: 'queued',
})

// ...call your model provider...

// Persist the output where the product can query it
await backend.ai_runs.update(run.id, {
  output: completion,
  status: 'done',
})`,
        },
      ],
    },
    {
      heading: 'Retrieval: vectors next to your data, not beside it',
      blocks: [
        {
          kind: 'p',
          text: 'If your product does RAG — answering from the user\'s own documents — you need embedding storage and similarity search. The 2026 default answer is pgvector: embeddings live in PostgreSQL columns next to the rows they describe, so similarity search composes with your existing filters and, critically, with row-level security. A standalone vector database is a second system to operate, a second copy of sensitive data to secure, and a class of sync bugs you don\'t need at product stage. Backenly supports pgvector-backed semantic search as a first-class capability — you describe what should be searchable, and the platform handles the embedding columns and query path, with results scoped by the same access policies as everything else.',
        },
        {
          kind: 'note',
          text: 'The isolation point deserves repeating for RAG specifically: a similarity query that ignores row-level security is a data breach with extra steps — user A\'s question retrieving user B\'s documents as "context." Keeping vectors inside the same policy-enforced database is the structural fix.',
        },
      ],
    },
    {
      heading: 'Pipelines: triggers instead of orchestration code',
      blocks: [
        {
          kind: 'p',
          text: 'AI work is asynchronous, and the standard trap is doing it inside request handlers — which means timeouts, lost work on crashes, and no retry story. The right shape is event-driven: something happens in the data, and processing follows. Backenly\'s functions attach directly to those events — on insert, update, or delete of a table, on user signup, on a schedule, or exposed as an HTTP endpoint:',
        },
        {
          kind: 'code',
          language: 'text',
          label: 'Wiring a pipeline in plain English',
          code: `When a new row is added to documents, run a function that
calls our summarization endpoint, then writes the summary
back to the document's summary column.

Also: every Monday at 9:00, email each user a digest of
their documents created that week.`,
        },
        {
          kind: 'p',
          text: 'The platform creates the on-insert function and the cron function, and they run inside the backend with quotas per plan (10,000 invocations/month on Free, 2 million on Pro). No queue to deploy, no worker fleet, no orchestration code — the database\'s own events are the queue. When your model finishes and the function updates the row\'s status, that update is itself an event the frontend can observe, which brings us to the next requirement.',
        },
      ],
    },
    {
      heading: 'Streaming status: the database change stream is your progress bar',
      blocks: [
        {
          kind: 'p',
          text: 'Users tolerate slow AI; they don\'t tolerate mute AI. The cleanest pattern is to make job state a row (you already have ai_runs.status) and let the frontend subscribe to changes on it — no websocket server, no polling loop:',
        },
        {
          kind: 'code',
          language: 'js',
          label: 'Live job status over SSE',
          code: `const unsub = backend.realtime.subscribe('ai_runs', (event) => {
  if (event.type === 'update') {
    showStatus(event.data.status)     // queued → running → done
    if (event.data.status === 'done') {
      renderOutput(event.data.output)
      unsub()
    }
  }
})`,
        },
        {
          kind: 'p',
          text: 'Under the hood this is PostgreSQL\'s own change notifications streamed to the browser over Server-Sent Events, with automatic reconnection. Because the events come from the database, every writer — your AI layer, a trigger function, the dashboard — feeds the same stream for free.',
        },
      ],
    },
    {
      heading: 'Cost control: rate limits and the operational layer',
      blocks: [
        {
          kind: 'p',
          text: 'Inference costs mean your backend is also your budget enforcement. Two backend-level facts make AI unit economics survivable: per-key rate limiting (so one user or one leaked key cannot spend your monthly inference budget in an afternoon) and request-level metrics you can actually see. Backenly supports rate limits on the runtime API and tracks real request traffic — requests, latency, error rates — in the monitoring layer, so "which endpoint is suddenly hot" is a dashboard glance, not a log-diving session.',
        },
        {
          kind: 'p',
          text: 'That same traffic feeds the autonomy loop after launch: anomaly detection on your real metrics, safe fixes applied automatically if you allow it, risky changes queued for approval, everything written up with evidence and covered by restore points. For an AI product this matters more than usual, because your team\'s attention is the scarcest resource you have — every hour spent operating infrastructure is an hour not spent on the model behavior that actually differentiates you.',
        },
      ],
    },
  ],
  conclusion:
    'An AI product\'s backend is not a smaller version of the usual problem — it is a stranger one: conversation-grade privacy, vectors under access control, event-driven pipelines, observable job state, and per-user cost enforcement, all before your first real feature. You can assemble that from five separate infrastructure projects, or you can describe it and get it as one governed system: PostgreSQL with pgvector, REST APIs, verified row-level isolation, event and cron functions with real quotas, SSE realtime, and a monitoring loop that keeps operating it after launch. Your differentiation lives in the AI layer. Spend your time there.',
  relatedSlugs: ['what-is-ai-backend-generation', 'full-stack-development-with-ai-coding-agents'],
}
